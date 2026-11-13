package com.alienware377.hololoop.display

import android.app.Presentation
import android.content.Context
import android.opengl.GLSurfaceView
import android.view.Choreographer
import android.os.Bundle
import android.view.Display
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.alienware377.hololoop.fx.FxState
import com.alienware377.hololoop.calib.Calibration
import com.alienware377.hololoop.gl.LenticularRenderer
import com.alienware377.hololoop.media.PlaybackEvents
import com.alienware377.hololoop.model.HologramItem
import com.alienware377.hololoop.model.Look

/**
 * Full-screen lenticular output rendered onto the Looking Glass [Display].
 * Holds its own GL context and [LenticularRenderer].
 */
class HologramPresentation(
    context: Context,
    display: Display,
    private val calibration: Calibration,
    private var item: HologramItem?,
) : Presentation(context, display) {

    private lateinit var glView: GLSurfaceView
    private lateinit var renderer: LenticularRenderer

    /** HoloLoop: 3D look + playback callbacks. Set before show() or any time after. */
    var look: Look? = null
        set(v) { field = v; if (::renderer.isInitialized) renderer.look = v }
    var events: PlaybackEvents? = null
        set(v) { field = v; if (::renderer.isInitialized) renderer.events = v }
    var fx: FxState? = null
        set(v) { field = v; if (::renderer.isInitialized) renderer.fx = v }
    /**
     * Cool mode: show at most this many video frames a second (0 = all of them, up to the Go's 60).
     * A faster video skips frames, and the phone runs cooler. Either way the Go is only drawn when
     * its picture changes, so a paused video costs nothing.
     */
    var fpsCap: Int = 0
        set(v) { field = v; if (::renderer.isInitialized) renderer.maxFps = v }

    // Drawings are asked for by the renderer itself (renderer.onChange): a new video frame, a new
    // item, a setting. Only moving filters need a steady beat, ~30 a second (or the cool mode rate),
    // and this pacer gives it to them; it runs only while they are on.
    private var lastPaced = 0L
    private var pacing = false
    private val pacer = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!::glView.isInitialized || !renderer.animating) { pacing = false; return }
            val cap = fpsCap
            if (cap <= 0) {
                if (renderer.needsDraw()) glView.requestRender()
            } else {
                val period = 1_000_000_000L / cap
                // draw on the first refresh at or past the next due time (a little slack for timing jitter);
                // due times step by exactly one period, so e.g. 45 a second draws 3 of every 4 refreshes
                if (frameTimeNanos - lastPaced >= period - 1_500_000L) {
                    lastPaced = if (frameTimeNanos - lastPaced > 2 * period) frameTimeNanos else lastPaced + period
                    if (renderer.needsDraw()) glView.requestRender()
                }
            }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    /** Main thread: start the beat for moving filters. */
    private fun pace() {
        if (pacing || !::glView.isInitialized || !renderer.animating) return
        pacing = true; lastPaced = 0L
        Choreographer.getInstance().postFrameCallback(pacer)
    }
    /** Lens correction (see LenticularRenderer.lensPitch). Set any time. */
    var lensPitch: Float = 1f
        set(v) { field = v; if (::renderer.isInitialized) renderer.lensPitch = v }
    var lensDepth: Float = 1f
        set(v) { field = v; if (::renderer.isInitialized) renderer.lensDepth = v }
    var lensFlip: Boolean = false
        set(v) { field = v; if (::renderer.isInitialized) renderer.lensFlip = v }
    /** Drawn flat on top of the 3D (the on-Go menu). Set before show(). */
    var overlay: View? = null
    /** Key presses that land on the Go's window (its buttons, if focus is here). */
    var keys: ((KeyEvent) -> Boolean)? = null

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        keys?.invoke(event) == true || super.dispatchKeyEvent(event)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        renderer = LenticularRenderer(context).also { it.calibration = calibration; it.look = look; it.events = events; it.fx = fx
            it.lensPitch = lensPitch; it.lensDepth = lensDepth; it.lensFlip = lensFlip; it.maxFps = fpsCap }
        glView = GLSurfaceView(context).apply {
            setEGLContextClientVersion(3)
            setEGLConfigChooser(8, 8, 8, 0, 0, 0)     // no depth or stencil buffer: nothing draws with them
            setRenderer(renderer)
            renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
        }
        renderer.onChange = { glView.requestRender() }
        renderer.onAnimating = { glView.post { pace() } }
        val ov = overlay
        if (ov == null) setContentView(glView)
        else setContentView(FrameLayout(context).apply {
            addView(glView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            (ov.parent as? ViewGroup)?.removeView(ov)
            addView(ov, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        })
        renderer.setItem(item)
    }

    fun updateItem(newItem: HologramItem?) {
        item = newItem
        if (::renderer.isInitialized) renderer.setItem(newItem)
    }

    fun setPaused(paused: Boolean) { if (::renderer.isInitialized) renderer.setPaused(paused) }
    fun setVolume(v: Float) { if (::renderer.isInitialized) renderer.setVolume(v) }
    fun seekBy(ms: Long) { if (::renderer.isInitialized) renderer.seekBy(ms) }

    fun updateCalibration(cal: Calibration) {
        if (::renderer.isInitialized) renderer.calibration = cal
    }

    override fun onStop() {
        Choreographer.getInstance().removeFrameCallback(pacer); pacing = false
        if (::renderer.isInitialized) { renderer.onChange = null; renderer.onAnimating = null }
        if (::glView.isInitialized) {
            renderer.releasePlayerNow()                   // the decoder goes now, whatever the GL thread does
            glView.queueEvent { renderer.release() }      // GL objects (die with the context anyway)
            glView.onPause()
        }
        super.onStop()
    }
}
