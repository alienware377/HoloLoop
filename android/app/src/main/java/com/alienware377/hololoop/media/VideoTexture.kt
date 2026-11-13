package com.alienware377.hololoop.media

import android.content.Context
import android.graphics.SurfaceTexture
import android.net.Uri
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import com.alienware377.hololoop.gl.GlUtil

/**
 * Decodes a quilt video with ExoPlayer into an external-OES texture, then blits
 * each frame into a GL_TEXTURE_2D so the lenticular shader can sample it.
 *
 * Created and used on a single GL thread. ExoPlayer itself runs on the main
 * thread; only the Surface is shared.
 */
class VideoTexture(
    private val context: Context,
    private val uri: Uri,
    override val width: Int,
    override val height: Int,
    private val loop: Boolean = true,
    private val startAtMs: Long = 0,
    private val volume: Float = 0f,
    private val itemId: String? = null,
    private val events: PlaybackEvents? = null,
) : HologramTexture {

    private var oesTex = 0
    private var tex2d = 0
    private var fbo = 0
    private var surfaceTexture: SurfaceTexture? = null
    private var surface: Surface? = null
    private var player: ExoPlayer? = null

    private var blitProgram = 0
    private var quadVbo = 0

    /** Steady edges (set by the renderer each frame): 0 off, 1 normal, 2 strong, for still and moving
     *  parts; and where the depth half is. */
    @Volatile var steady = 0
    @Volatile var steadyMove = 0
    private val steadyOn get() = steady > 0 || steadyMove > 0
    @Volatile var depthLoc = 2
    private val stab = IntArray(2)        // ping-pong: the steadied frames
    private var stabI = 0
    private var stabFresh = true
    private var steadyProgram = 0
    private var outTex = 0                // what the lenticular shader samples: tex2d, or a steadied copy
    private var stabW = 0                 // the steadied copies are the video's REAL size (tex2d can be a guess)
    private var stabH = 0
    override val texW: Int get() = if (steadyOn && outTex != 0 && outTex != tex2d && stabW > 0) stabW else width
    override val texH: Int get() = if (steadyOn && outTex != 0 && outTex != tex2d && stabH > 0) stabH else height
    private var stabT = 0f
    @Volatile private var restartSteady = false
    private val stMatrix = FloatArray(16)
    @Volatile private var frameAvailable = false
    // media time for the GL thread (ExoPlayer may only be touched on the main thread)
    @Volatile private var posMs = 0L
    @Volatile private var posAtNs = 0L
    @Volatile private var isPlaying = false

    /** Real picture aspect reported by the decoder (0 until known). The FBO size is
     *  only a guess when the playlist didn't say, so never trust width/height for shape. */
    @Volatile var videoAspect = 0f
    /** The decoder's real picture size (0 until known); the 3D edge fixes measure pixels with it. */
    @Volatile var videoW = 0
    @Volatile var videoH = 0
        private set

    /** Where playback is now, in seconds; safe to call from the GL thread. */
    fun mediaTimeSec(): Float {
        val p = posMs
        val at = posAtNs
        val extra = if (isPlaying && at > 0) (System.nanoTime() - at) / 1_000_000L else 0L
        return (p + extra) / 1000f
    }

    override fun ensure(): Int {
        if (tex2d != 0) return if (steadyOn && outTex != 0) outTex else tex2d

        // OES texture fed by the decoder
        val oes = IntArray(1)
        GLES30.glGenTextures(1, oes, 0)
        oesTex = oes[0]
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)

        // 2D target + FBO
        val t = IntArray(1)
        GLES30.glGenTextures(1, t, 0)
        tex2d = t[0]
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex2d)
        GLES30.glTexImage2D(
            GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA, width, height, 0,
            GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null
        )
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)

        val f = IntArray(1)
        GLES30.glGenFramebuffers(1, f, 0)
        fbo = f[0]

        blitProgram = GlUtil.program(context, "shaders/oes_blit.vert", "shaders/oes_blit.frag")
        quadVbo = GlUtil.fullscreenQuadVbo()

        surfaceTexture = SurfaceTexture(oesTex).apply {
            setDefaultBufferSize(width, height)
            setOnFrameAvailableListener { frameAvailable = true }
        }
        surface = Surface(surfaceTexture)

        val main = Handler(Looper.getMainLooper())
        main.post {
            // Local files need only a few seconds of buffer. ExoPlayer's default keeps up to
            // ~130 MB of video in the Java heap (512 MB max), which pushed long kiosk runs out of memory.
            val load = androidx.media3.exoplayer.DefaultLoadControl.Builder()
                .setBufferDurationsMs(4_000, 12_000, 1_000, 2_000)
                .setTargetBufferBytes(40 * 1024 * 1024)
                .setPrioritizeTimeOverSizeThresholds(false)
                .build()
            val p = ExoPlayer.Builder(context).setLoadControl(load).build()
            player = p
            p.setVideoSurface(surface)
            p.addListener(object : androidx.media3.common.Player.Listener {
                override fun onVideoSizeChanged(vs: androidx.media3.common.VideoSize) {
                    if (vs.width > 0 && vs.height > 0) { videoAspect = vs.width * vs.pixelWidthHeightRatio / vs.height; videoW = vs.width; videoH = vs.height }
                }
            })
            p.setMediaItem(MediaItem.fromUri(uri))
            p.repeatMode = if (loop) ExoPlayer.REPEAT_MODE_ALL else ExoPlayer.REPEAT_MODE_OFF
            p.volume = volume
            if (events != null) {
                p.addListener(object : androidx.media3.common.Player.Listener {
                    private var started = false
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == androidx.media3.common.Player.STATE_READY && !started) {
                            started = true; events.onStarted(itemId, p.duration)
                        }
                        if (state == androidx.media3.common.Player.STATE_ENDED) events.onEnded(itemId)
                    }
                    override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                        events.onError(itemId, error.errorCodeName + ": " + (error.message ?: ""))
                    }
                })
                val tick = object : Runnable {
                    override fun run() {
                        val pl = player ?: return
                        if (pl.isPlaying) events.onPosition(itemId, pl.currentPosition, pl.duration)
                        main.postDelayed(this, 1000)
                    }
                }
                main.postDelayed(tick, 1000)
            }
            val clock = object : Runnable {
                override fun run() {
                    val pl = player ?: return
                    posMs = pl.currentPosition; posAtNs = System.nanoTime(); isPlaying = pl.isPlaying
                    main.postDelayed(this, 100)
                }
            }
            main.post(clock)
            p.prepare()
            if (startAtMs > 0) p.seekTo(startAtMs)
            p.playWhenReady = true
        }
        return tex2d
    }

    override val hasNewFrame: Boolean get() = frameAvailable

    override fun update(): Boolean {
        val st = surfaceTexture ?: return false
        if (!frameAvailable) return false
        frameAvailable = false
        try {
            st.updateTexImage()
        } catch (e: Exception) {
            android.util.Log.w("VideoTexture", "updateTexImage skipped: ${e.message}")
            return false
        }
        st.getTransformMatrix(stMatrix)
        blitToTex2d()
        steadyPass()
        return true
    }

    /** Smooth the depth between frames, more where the picture is still (see steady.frag). */
    private fun steadyPass() {
        val level = steady
        val move = steadyMove
        if (level <= 0 && move <= 0) { outTex = tex2d; stabFresh = true; return }
        if (restartSteady) { restartSteady = false; stabFresh = true }
        val t = mediaTimeSec()
        if (t < stabT - 0.5f) stabFresh = true          // looped back to the start
        stabT = t
        val sw = if (videoW > 0) videoW else width
        val sh = if (videoH > 0) videoH else height
        if (stab[0] == 0) {
            GLES30.glGenTextures(2, stab, 0)
            steadyProgram = GlUtil.program(context, "shaders/steady.vert", "shaders/steady.frag")
        }
        if (sw != stabW || sh != stabH) {
            for (tx in stab) {
                GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tx)
                GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA, sw, sh, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
                GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
                GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
                GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
                GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
            }
            stabW = sw; stabH = sh; stabFresh = true
        }
        val prevFbo = IntArray(1)
        GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0)
        val vp = IntArray(4)
        GLES30.glGetIntegerv(GLES30.GL_VIEWPORT, vp, 0)
        val src = stab[stabI]
        val dst = stab[1 - stabI]
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, dst, 0)
        GLES30.glViewport(0, 0, sw, sh)
        GLES30.glUseProgram(steadyProgram)
        GlUtil.bindQuadAttrib(steadyProgram, quadVbo)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, tex2d)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, src)
        GLES30.glUniform1i(GLES30.glGetUniformLocation(steadyProgram, "cur"), 0)
        GLES30.glUniform1i(GLES30.glGetUniformLocation(steadyProgram, "prev"), 1)
        GLES30.glUniform1i(GLES30.glGetUniformLocation(steadyProgram, "depthLoc"), depthLoc)
        GLES30.glUniform1f(GLES30.glGetUniformLocation(steadyProgram, "still"), if (stabFresh) 1f else STILL.getOrElse(level) { 0.25f })
        GLES30.glUniform1f(GLES30.glGetUniformLocation(steadyProgram, "moving"), if (stabFresh) 1f else MOVING.getOrElse(move) { 0.5f })
        GLES30.glUniform2f(GLES30.glGetUniformLocation(steadyProgram, "texel"), 1f / sw, 1f / sh)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, prevFbo[0])
        GLES30.glViewport(vp[0], vp[1], vp[2], vp[3])
        stabI = 1 - stabI; outTex = dst; stabFresh = false
    }

    private fun blitToTex2d() {
        val prevFbo = IntArray(1)
        GLES30.glGetIntegerv(GLES30.GL_FRAMEBUFFER_BINDING, prevFbo, 0)
        val vp = IntArray(4)
        GLES30.glGetIntegerv(GLES30.GL_VIEWPORT, vp, 0)

        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
        GLES30.glFramebufferTexture2D(
            GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, tex2d, 0
        )
        GLES30.glViewport(0, 0, width, height)
        GLES30.glUseProgram(blitProgram)
        GlUtil.bindQuadAttrib(blitProgram, quadVbo)
        GLES30.glUniformMatrix4fv(GLES30.glGetUniformLocation(blitProgram, "stMatrix"), 1, false, stMatrix, 0)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        GLES30.glUniform1i(GLES30.glGetUniformLocation(blitProgram, "tex"), 0)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)

        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, prevFbo[0])
        GLES30.glViewport(vp[0], vp[1], vp[2], vp[3])
    }

    fun setPaused(paused: Boolean) { Handler(Looper.getMainLooper()).post { player?.playWhenReady = !paused } }
    fun setVolume(v: Float) { Handler(Looper.getMainLooper()).post { player?.volume = v } }
    fun seekTo(ms: Long) {
        restartSteady = true
        Handler(Looper.getMainLooper()).post { player?.run { setSeekParameters(SeekParameters.DEFAULT); seekTo(ms) } }
    }

    /**
     * Skip [deltaMs] from where the video is now, landing on a keyframe (quick, for holding a button):
     * the next one going forward, the one before going back, so every jump really moves. Never closer
     * than 2 s to the end (the video would end mid-hold), and a forward skip never goes backwards.
     */
    fun seekBy(deltaMs: Long) {
        Handler(Looper.getMainLooper()).post {
            val p = player ?: return@post
            val dur = p.duration.takeIf { it > 0 } ?: return@post
            val pos = p.currentPosition
            val cap = (dur - 2000L).coerceAtLeast(0L)
            if (deltaMs > 0 && pos >= cap) return@post
            val to = (pos + deltaMs).coerceIn(0L, cap)
            restartSteady = true
            p.setSeekParameters(if (deltaMs < 0 || to == cap) SeekParameters.PREVIOUS_SYNC else SeekParameters.NEXT_SYNC)
            p.seekTo(to)
        }
    }

    /** Stop and free the decoder now (any thread); GL objects are freed by [release]. */
    fun releasePlayer() {
        // always queued: if ensure() just queued the player's creation, this runs after it
        Handler(Looper.getMainLooper()).post { player?.release(); player = null }
    }

    override fun release() {
        Handler(Looper.getMainLooper()).post { player?.release(); player = null }
        surface?.release(); surface = null
        surfaceTexture?.release(); surfaceTexture = null
        if (tex2d != 0) GLES30.glDeleteTextures(1, intArrayOf(tex2d), 0)
        if (oesTex != 0) GLES30.glDeleteTextures(1, intArrayOf(oesTex), 0)
        if (fbo != 0) GLES30.glDeleteFramebuffers(1, intArrayOf(fbo), 0)
        if (stab[0] != 0) GLES30.glDeleteTextures(2, stab, 0)
        if (steadyProgram != 0) GLES30.glDeleteProgram(steadyProgram)
        stab[0] = 0; stab[1] = 0; steadyProgram = 0; outTex = 0; stabW = 0; stabH = 0
        if (blitProgram != 0) GLES30.glDeleteProgram(blitProgram)
        if (quadVbo != 0) GLES30.glDeleteBuffers(1, intArrayOf(quadVbo), 0)
        tex2d = 0; oesTex = 0; fbo = 0; blitProgram = 0; quadVbo = 0
    }
}

// Share of the new depth a spot takes per frame for each steady level: off, normal/light, strong.
private val STILL = floatArrayOf(1f, 0.25f, 0.1f)
private val MOVING = floatArrayOf(1f, 0.5f, 0.3f)
