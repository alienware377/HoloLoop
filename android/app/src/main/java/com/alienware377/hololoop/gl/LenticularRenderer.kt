package com.alienware377.hololoop.gl

import android.content.Context
import android.opengl.GLES30
import android.opengl.GLSurfaceView
import com.alienware377.hololoop.calib.Calibration
import com.alienware377.hololoop.fx.FxPass
import com.alienware377.hololoop.fx.FxState
import com.alienware377.hololoop.media.HologramTexture
import com.alienware377.hololoop.media.PlaybackEvents
import com.alienware377.hololoop.media.TextureFactory
import com.alienware377.hololoop.media.VideoTexture
import com.alienware377.hololoop.model.HologramItem
import com.alienware377.hololoop.model.Look
import com.alienware377.hololoop.model.HologramKind
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/**
 * Renders the lenticular interleave to fill the Looking Glass display surface.
 * Applies the device [Calibration] to the current [HologramItem].
 *
 * The Go is drawn only when its picture changes: a new video frame, another item, a setting.
 * In between it keeps showing the last frame by itself, so a paused video or a still costs
 * nothing. [onChange] is how the renderer asks for a drawing.
 */
class LenticularRenderer(private val context: Context) : GLSurfaceView.Renderer {

    @Volatile var calibration: Calibration = Calibration.placeholder()
        set(v) { field = v; poke() }
    /** HoloLoop's 3D look. null = use the item's own depth values (studio behaviour). */
    @Volatile var look: Look? = null
        set(v) { field = v; poke() }
    @Volatile var events: PlaybackEvents? = null
    /** Video filters (HoloLoop), applied to the colour of RGBD pictures. null = none. */
    @Volatile var fx: FxState? = null
        set(v) { field = v; poke() }
    /** Cool mode: show at most this many video frames a second (0 = all of them). */
    @Volatile var maxFps = 0
        set(v) { field = v; (texture as? VideoTexture)?.maxFps = v }
    /** Called on any thread when the Go should be drawn again. */
    @Volatile var onChange: (() -> Unit)? = null
    /** Called on the GL thread when moving filters start; they need pacing (see [needsDraw]). */
    @Volatile var onAnimating: (() -> Unit)? = null

    @Volatile private var poked = true
    /** Moving filters (glitch, bokeh, grain) are on: they need a fresh picture ~30 times a second, even on a still frame. */
    @Volatile var animating = false
        private set
    @Volatile private var lastAnimNs = 0L
    private fun poke() { poked = true; onChange?.invoke() }

    /** True when a drawing now would show something new. Safe to call from any thread. */
    fun needsDraw(): Boolean = poked || pendingItem != null || clearRequested || texture?.hasNewFrame == true ||
        (animating && System.nanoTime() - lastAnimNs > 30_000_000L)
    @Volatile private var pendingItem: HologramItem? = null
    @Volatile private var clearRequested = false
    private var loggedOnce = false

    private var quiltProgram = 0
    private var quadVbo = 0
    // The RGBD shader is built once per edge mode and step count, with those as constants: each
    // program then holds only the code its mode runs, and its ray march has a fixed length.
    private var rgbdSource = ""
    private val rgbdPrograms = HashMap<Int, Int>()
    private val uniforms = HashMap<Int, HashMap<String, Int>>()

    private fun rgbdProgram(edgeFix: Int, iterations: Int): Int = rgbdPrograms.getOrPut(edgeFix * 1000 + iterations) {
        val defines = "#define EDGE_FIX $edgeFix\n#define ITERATIONS $iterations\n"
        val at = rgbdSource.indexOf('\n') + 1      // after #version
        GlUtil.link(GlUtil.loadAsset(context, "shaders/lenticular.vert"), rgbdSource.substring(0, at) + defines + rgbdSource.substring(at))
    }

    @Volatile private var texture: HologramTexture? = null
    private var currentItem: HologramItem? = null
    private var surfaceW = 0
    private var surfaceH = 0
    private val fmap = FloatArray(11)
    private var loggedFramingFor: HologramItem? = null

    /** Swap the displayed hologram; texture is (re)built on the GL thread. */
    fun setItem(item: HologramItem?) { if (item == null) { pendingItem = null; clearRequested = true } else { clearRequested = false; pendingItem = item }; poke() }

    fun setPaused(paused: Boolean) { (texture as? VideoTexture)?.setPaused(paused) }
    fun setVolume(v: Float) { (texture as? VideoTexture)?.setVolume(v) }
    fun seekBy(ms: Long) { (texture as? VideoTexture)?.seekBy(ms) }
    fun seekTo(ms: Long) { (texture as? VideoTexture)?.seekTo(ms) }

    private var fxPass = FxPass()

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES30.glClearColor(0f, 0f, 0f, 1f)
        quiltProgram = GlUtil.program(context, "shaders/lenticular.vert", "shaders/quilt_lenticular.frag")
        rgbdSource = GlUtil.loadAsset(context, "shaders/rgbd_lenticular.frag")
        rgbdPrograms.clear(); uniforms.clear()      // a new GL context: the old ones are gone
        quadVbo = GlUtil.fullscreenQuadVbo()
        fxPass = FxPass()
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceW = width; surfaceH = height
        GLES30.glViewport(0, 0, width, height)
    }

    private var frames = 0
    private var passes = 0
    private var fpsSince = 0L

    /**
     * A magnifying lens in front of the Go bends the light, which acts like looking from another
     * distance: the views drift across the picture, fewer of them land between the eyes, and past
     * the lens's focal point their order flips. [lensPitch] rescales the lens pattern around the
     * middle of the screen, [lensDepth] multiplies the 3D strength, [lensFlip] reverses the views.
     */
    @Volatile var lensPitch = 1f
        set(v) { field = v; poke() }
    @Volatile var lensDepth = 1f
        set(v) { field = v; poke() }
    @Volatile var lensFlip = false
        set(v) { field = v; poke() }

    // Every call draws the whole picture: the screen's buffers do not keep the last one.
    override fun onDrawFrame(gl: GL10?) {
        poked = false                     // first, so a change made while drawing asks for one more frame
        applyPendingItem()
        val item = currentItem
        val tex = texture
        if (item == null || tex == null) {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
            animating = false
            return
        }
        val lk = look
        val fxs = if (item.isRgbd) fx?.takeIf { it.active.isNotEmpty() } else null
        (tex as? VideoTexture)?.let {
            it.steady = if (item.isRgbd) (lk?.steady ?: 0) else 0
            it.steadyMove = if (item.isRgbd) (lk?.steadyMove ?: 0) else 0
            it.depthLoc = item.depthLoc
            it.wantDepth = item.isRgbd && fxs == null
        }
        val fresh = tex.update()          // new frame first, so ensure() hands back the newest (steadied) picture
        val texId = tex.ensure()

        // how often the Go is drawn, and how many of those drawings had a new video frame
        frames++
        if (fresh) passes++
        val now = System.nanoTime()
        if (now - fpsSince > 10_000_000_000L) {
            if (fpsSince > 0) android.util.Log.i("HoloLoop", "draw %.1f/s, new frames %.1f/s, edges ${lk?.edgeFix ?: 0}".format(frames * 1e9 / (now - fpsSince), passes * 1e9 / (now - fpsSince)))
            fpsSince = now; frames = 0; passes = 0
        }

        val moving = fxs?.animated == true
        if (moving) lastAnimNs = now
        if (moving != animating) { animating = moving; if (moving) onAnimating?.invoke() }
        val src = if (fxs != null) fxPass.apply(texId, tex.texW, tex.texH, item.depthLoc, fxs) else texId
        // depth from the one-channel copy when there is one (filters move the depth, so then from their picture)
        val depthId = if (fxs == null) tex.depthTex.takeIf { it != 0 } ?: src else src
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glViewport(0, 0, surfaceW, surfaceH)
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
        drawHologram(item, tex, src, depthId, lk)
    }

    private fun drawHologram(item: HologramItem, tex: HologramTexture, texId: Int, depthId: Int, lk: Look?) {
        val isRgbd = item.isRgbd
        val program = if (isRgbd) rgbdProgram(lk?.edgeFix ?: 0, lk?.iterations ?: 14) else quiltProgram
        GLES30.glUseProgram(program)
        GLES30.glViewport(0, 0, surfaceW, surfaceH)

        if (!loggedOnce) {
            loggedOnce = true
            android.util.Log.e("LkgDiag",
                "surf=${surfaceW}x${surfaceH} cols=${item.cols} rows=${item.rows} " +
                "pitchLoc=${loc(program,"pitch")} shaderPitch=${calibration.shaderPitch} " +
                "shaderSlope=${calibration.shaderSlope} center=${calibration.shaderCenter} " +
                "subpx=${calibration.shaderSubpixelSize} sw=${calibration.screenW} sh=${calibration.screenH} " +
                "dpi=${calibration.dpi} rawPitch=${calibration.pitch} rawSlope=${calibration.slope} " +
                "invView=${calibration.invView} shProg=$quiltProgram depthBits=${IntArray(1).also { GLES30.glGetIntegerv(GLES30.GL_DEPTH_BITS, it, 0) }[0]}")
        }

        // quad size on the panel: whole picture (letterbox) or fill (crop), then zoom
        val deviceAspect = calibration.screenAspect
        // RGBD framing for this moment: crop, pan, zoom, or a quarter turn to keep people upright
        val fr = item.framing
        val colorAspect = if (isRgbd) rgbdColorAspect(item, tex) else 1f
        val turnFit = isRgbd && item.frameMode == "turnfit"
        if (isRgbd && fr != null) fr.mapAt((tex as? VideoTexture)?.mediaTimeSec() ?: 0f, item.frameMode, colorAspect * 1000f, 1000f, fmap)
        else if (turnFit) com.alienware377.hololoop.model.Framing.turnFitWhole(colorAspect, fmap)
        else com.alienware377.hololoop.model.Framing.identity(colorAspect, fmap)
        if (item !== loggedFramingFor) {
            loggedFramingFor = item
            android.util.Log.i("HoloLoop", "framing ${if (fr != null) "on" else "none"} mode=${item.frameMode} map=${fmap.joinToString { "%.3f".format(it) }}")
        }
        val contentAspect = if (isRgbd) fmap[6] else item.viewAspect
        val wider = contentAspect > deviceAspect
        // fit: the long side touches the edges; fill: the short side does
        val sx: Float; val sy: Float
        // turnfit never crops
        if ((lk?.fill == true && !turnFit) != wider) { sx = 1f; sy = deviceAspect / contentAspect } else { sy = 1f; sx = contentAspect / deviceAspect }
        val z = (lk?.zoom ?: 1f).coerceIn(0.2f, 4f)
        GLES30.glUniform2f(loc(program, "quad_scale"), sx * z, sy * z)
        GLES30.glUniform2f(loc(program, "crop_pos"), 0f, 0f)

        // shared lenticular uniforms
        val k = lensPitch
        uf(program, "pitch", calibration.shaderPitch * k)
        uf(program, "slope", calibration.shaderSlope)
        // keep the view at the middle of the screen where it was, so the rescale spreads both ways
        uf(program, "center", calibration.shaderCenter + (k - 1f) * calibration.shaderPitch * (0.5f + 0.5f * calibration.shaderSlope))
        uf(program, "subpixelSize", calibration.shaderSubpixelSize)
        if (isRgbd) GLES30.glUniform4f(loc(program, "tile"), 11f, 6f, 0f, 0f)
        else GLES30.glUniform4f(loc(program, "tile"), item.cols.toFloat(), item.rows.toFloat(), 0f, 0f)
        GLES30.glUniform1i(loc(program, "filter_edge"), if (lk?.filterEdge == false) 0 else 1)
        // Device-level view reversal (visual.json invView). For quilts the per-item
        // depth toggle also reverses views, so XOR it in; the RGBD shader handles the
        // per-item toggle separately via depth_inversion, so use the device flag alone.
        // The Go reports invView=1, but flipping the views when it says so comes out
        // backwards on the panel (in the view-number test the left eye sees the higher
        // number, and RGBD looks inside-out). So the view order is reversed exactly
        // when invView is NOT set.
        val devInv = !calibration.invView != lensFlip
        val invView = if (isRgbd) devInv else (devInv != item.depthInversion)
        GLES30.glUniform1i(loc(program, "invView"), if (invView) 1 else 0)

        if (isRgbd) {
            GLES30.glUniform1i(loc(program, "depth_loc"), item.depthLoc)
            val inv = item.depthInversion != (lk?.depthInvert == true)
            GLES30.glUniform1i(loc(program, "depth_inversion"), if (inv) 1 else 0)
            uf(program, "depthiness", (lk?.depthiness ?: item.depthiness) * lensDepth)
            uf(program, "focus", lk?.focus ?: item.focus)
            GLES30.glUniform1i(loc(program, "iterations"), lk?.iterations ?: 14)
            GLES30.glUniform1i(loc(program, "edgeFix"), lk?.edgeFix ?: 0)
            // one pixel of the REAL colour picture (the texture can be a resampled guess in size)
            val vt = tex as? VideoTexture
            val pw = (vt?.videoW?.takeIf { it > 0 } ?: tex.width).toFloat()
            val ph = (vt?.videoH?.takeIf { it > 0 } ?: tex.height).toFloat()
            val cw = if (item.depthLoc >= 2) pw / 2f else pw
            val chh = if (item.depthLoc >= 2) ph else ph / 2f
            GLES30.glUniform2f(loc(program, "colorTexel"), 1f / cw.coerceAtLeast(1f), 1f / chh.coerceAtLeast(1f))
            GLES30.glUniform3f(loc(program, "mapU"), fmap[0], fmap[1], fmap[2])
            GLES30.glUniform3f(loc(program, "mapV"), fmap[3], fmap[4], fmap[5])
            GLES30.glUniform4f(loc(program, "contentRect"), fmap[7], fmap[8], fmap[9], fmap[10])
        } else {
            GLES30.glUniform2f(loc(program, "view_portion"), item.viewPortionX, item.viewPortionY)
        }

        if (isRgbd) {
            GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, depthId)
            GLES30.glUniform1i(loc(program, "dtex"), 1)
        }
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texId)
        GLES30.glUniform1i(loc(program, "tex"), 0)

        GlUtil.bindQuadAttrib(program, quadVbo)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
    }

    /** Returns true when the shown item changed. */
    private fun applyPendingItem(): Boolean {
        var changed = false
        if (clearRequested) {
            clearRequested = false
            texture?.release(); texture = null; currentItem = null; changed = true
        }
        val p = pendingItem ?: return changed
        if (p === currentItem) return changed
        texture?.release()
        currentItem = p
        texture = TextureFactory.create(context, p, events = events).also { t ->
            (t as? VideoTexture)?.let { it.maxFps = maxFps; it.onFrame = { onChange?.invoke() } }
        }
        pendingItem = null
        return true
    }

    /** Free the decoder and textures (GL thread). */
    fun release() {
        texture?.release(); texture = null; currentItem = null; fxPass.release()
        for (p in rgbdPrograms.values) GLES30.glDeleteProgram(p)
        rgbdPrograms.clear(); uniforms.clear()
    }

    /** Main thread: stop the decoder right away (the GL side follows on the GL thread). */
    fun releasePlayerNow() { (texture as? VideoTexture)?.releasePlayer() }

    private fun rgbdColorAspect(item: HologramItem, tex: HologramTexture): Float {
        // whole RGBD picture aspect: from the decoder for video (the texture size can be a guess)
        val whole = (tex as? VideoTexture)?.videoAspect?.takeIf { it > 0f }
            ?: (tex.width.toFloat().coerceAtLeast(1f) / tex.height.toFloat().coerceAtLeast(1f))
        return if (item.depthLoc == 0 || item.depthLoc == 1) whole * 2f else whole * 0.5f
    }

    private fun loc(p: Int, name: String) = uniforms.getOrPut(p) { HashMap() }.getOrPut(name) { GLES30.glGetUniformLocation(p, name) }
    private fun uf(p: Int, name: String, v: Float) = GLES30.glUniform1f(loc(p, name), v)
}
