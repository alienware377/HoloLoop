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
 */
class LenticularRenderer(private val context: Context) : GLSurfaceView.Renderer {

    @Volatile var calibration: Calibration = Calibration.placeholder()
    /** HoloLoop's 3D look. null = use the item's own depth values (studio behaviour). */
    @Volatile var look: Look? = null
    @Volatile var events: PlaybackEvents? = null
    /** Video filters (HoloLoop), applied to the colour of RGBD pictures. null = none. */
    @Volatile var fx: FxState? = null
    @Volatile private var pendingItem: HologramItem? = null
    @Volatile private var clearRequested = false
    private var loggedOnce = false

    private var quiltProgram = 0
    private var rgbdProgram = 0
    private var quadVbo = 0

    private var texture: HologramTexture? = null
    private var currentItem: HologramItem? = null
    private var surfaceW = 0
    private var surfaceH = 0
    private val fmap = FloatArray(11)
    private var loggedFramingFor: HologramItem? = null

    /** Swap the displayed hologram; texture is (re)built on the GL thread. */
    fun setItem(item: HologramItem?) { if (item == null) { pendingItem = null; clearRequested = true } else { clearRequested = false; pendingItem = item } }

    fun setPaused(paused: Boolean) { (texture as? VideoTexture)?.setPaused(paused) }
    fun setVolume(v: Float) { (texture as? VideoTexture)?.setVolume(v) }
    fun seekBy(ms: Long) { (texture as? VideoTexture)?.seekBy(ms) }
    fun seekTo(ms: Long) { (texture as? VideoTexture)?.seekTo(ms) }

    // The 3D picture only changes when the video shows a new frame (or the look, item or
    // calibration change), so it is drawn into [cacheTex] then and copied to the screen on
    // every refresh. A 30 fps video then costs half the GPU work of drawing it at 60 Hz.
    private var blitProgram = 0
    private var cacheFbo = 0
    private var cacheTex = 0
    private var cacheW = 0
    private var cacheH = 0
    private var cacheValid = false
    private var drawnLook: Look? = null
    private var drawnCal: Calibration? = null
    private var drawnFx: FxState? = null
    private var fxPass = FxPass()
    private var lastAnimNs = 0L

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES30.glClearColor(0f, 0f, 0f, 1f)
        quiltProgram = GlUtil.program(context, "shaders/lenticular.vert", "shaders/quilt_lenticular.frag")
        rgbdProgram = GlUtil.program(context, "shaders/lenticular.vert", "shaders/rgbd_lenticular.frag")
        blitProgram = GlUtil.link(BLIT_VERT, BLIT_FRAG)
        quadVbo = GlUtil.fullscreenQuadVbo()
        cacheFbo = 0; cacheTex = 0; cacheW = 0; cacheH = 0; cacheValid = false   // new GL context
        fxPass = FxPass()
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceW = width; surfaceH = height
        GLES30.glViewport(0, 0, width, height)
        cacheValid = false
    }

    private fun ensureCache() {
        if (cacheTex != 0 && cacheW == surfaceW && cacheH == surfaceH) return
        if (cacheTex != 0) { GLES30.glDeleteTextures(1, intArrayOf(cacheTex), 0); GLES30.glDeleteFramebuffers(1, intArrayOf(cacheFbo), 0) }
        val ids = IntArray(1)
        GLES30.glGenTextures(1, ids, 0); cacheTex = ids[0]
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, cacheTex)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, surfaceW, surfaceH, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glGenFramebuffers(1, ids, 0); cacheFbo = ids[0]
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, cacheFbo)
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, cacheTex, 0)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        cacheW = surfaceW; cacheH = surfaceH; cacheValid = false
    }

    private var frames = 0
    private var passes = 0
    private var fpsSince = 0L

    override fun onDrawFrame(gl: GL10?) {
        val itemChanged = applyPendingItem()
        val item = currentItem
        val tex = texture
        if (item == null || tex == null) {
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
            cacheValid = false
            return
        }
        val lk = look
        val cal = calibration
        (tex as? VideoTexture)?.let { it.steady = if (item.isRgbd) (lk?.steady ?: 0) else 0; it.depthLoc = item.depthLoc }
        val fresh = tex.update()          // new frame first, so ensure() hands back the newest (steadied) picture
        val texId = tex.ensure()

        // how often the Go is refreshed, and how often the 3D is really drawn
        frames++
        val now = System.nanoTime()
        if (now - fpsSince > 10_000_000_000L) {
            if (fpsSince > 0) android.util.Log.i("HoloLoop", "draw %.1f fps, 3D %.1f/s, edges ${lk?.edgeFix ?: 0}".format(frames * 1e9 / (now - fpsSince), passes * 1e9 / (now - fpsSince)))
            fpsSince = now; frames = 0; passes = 0
        }

        ensureCache()
        val fxs = if (item.isRgbd) fx?.takeIf { it.active.isNotEmpty() } else null
        // moving filters (glitch, bokeh, grain) need fresh pictures even on a still frame, ~30 a second
        val animate = fxs?.animated == true && now - lastAnimNs > 30_000_000L
        if (fresh || itemChanged || !cacheValid || lk != drawnLook || cal !== drawnCal || fxs != drawnFx || animate) {
            if (fxs?.animated == true) lastAnimNs = now
            val src = if (fxs != null) fxPass.apply(texId, tex.texW, tex.texH, item.depthLoc, fxs) else texId
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, cacheFbo)
            GLES30.glViewport(0, 0, surfaceW, surfaceH)
            GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
            drawHologram(item, tex, src, lk)
            cacheValid = true; drawnLook = lk; drawnCal = cal; drawnFx = fxs; passes++
        }
        // copy the finished picture to the screen, pixel for pixel
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        GLES30.glViewport(0, 0, surfaceW, surfaceH)
        GLES30.glUseProgram(blitProgram)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, cacheTex)
        GLES30.glUniform1i(loc(blitProgram, "tex"), 0)
        GlUtil.bindQuadAttrib(blitProgram, quadVbo)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
    }

    private fun drawHologram(item: HologramItem, tex: HologramTexture, texId: Int, lk: Look?) {
        val isRgbd = item.isRgbd
        val program = if (isRgbd) rgbdProgram else quiltProgram
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
                "invView=${calibration.invView} shProg=$quiltProgram")
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
        uf(program, "pitch", calibration.shaderPitch)
        uf(program, "slope", calibration.shaderSlope)
        uf(program, "center", calibration.shaderCenter)
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
        val devInv = !calibration.invView
        val invView = if (isRgbd) devInv else (devInv != item.depthInversion)
        GLES30.glUniform1i(loc(program, "invView"), if (invView) 1 else 0)

        if (isRgbd) {
            GLES30.glUniform1i(loc(program, "depth_loc"), item.depthLoc)
            val inv = item.depthInversion != (lk?.depthInvert == true)
            GLES30.glUniform1i(loc(program, "depth_inversion"), if (inv) 1 else 0)
            uf(program, "depthiness", lk?.depthiness ?: item.depthiness)
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
        texture = TextureFactory.create(context, p, events = events)
        pendingItem = null
        return true
    }

    /** Free the decoder and textures (GL thread). */
    fun release() { texture?.release(); texture = null; currentItem = null; fxPass.release() }

    /** Main thread: stop the decoder right away (the GL side follows on the GL thread). */
    fun releasePlayerNow() { (texture as? VideoTexture)?.releasePlayer() }

    private fun rgbdColorAspect(item: HologramItem, tex: HologramTexture): Float {
        // whole RGBD picture aspect: from the decoder for video (the texture size can be a guess)
        val whole = (tex as? VideoTexture)?.videoAspect?.takeIf { it > 0f }
            ?: (tex.width.toFloat().coerceAtLeast(1f) / tex.height.toFloat().coerceAtLeast(1f))
        return if (item.depthLoc == 0 || item.depthLoc == 1) whole * 2f else whole * 0.5f
    }

    private fun loc(p: Int, name: String) = GLES30.glGetUniformLocation(p, name)

    private companion object {
        const val BLIT_VERT = "#version 300 es\nin vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }\n"
        const val BLIT_FRAG = "#version 300 es\nprecision mediump float;\nuniform sampler2D tex;\nout vec4 color;\n" +
            "void main() { color = texelFetch(tex, ivec2(gl_FragCoord.xy), 0); }\n"
    }
    private fun uf(p: Int, name: String, v: Float) = GLES30.glUniform1f(loc(p, name), v)
}
