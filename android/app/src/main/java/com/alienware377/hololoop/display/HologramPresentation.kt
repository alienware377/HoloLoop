package com.alienware377.hololoop.display

import android.app.Presentation
import android.content.Context
import android.opengl.GLSurfaceView
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
    /** Drawn flat on top of the 3D (the on-Go menu). Set before show(). */
    var overlay: View? = null
    /** Key presses that land on the Go's window (its buttons, if focus is here). */
    var keys: ((KeyEvent) -> Boolean)? = null

    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
        keys?.invoke(event) == true || super.dispatchKeyEvent(event)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        renderer = LenticularRenderer(context).also { it.calibration = calibration; it.look = look; it.events = events; it.fx = fx }
        glView = GLSurfaceView(context).apply {
            setEGLContextClientVersion(3)
            setRenderer(renderer)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
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
        if (::glView.isInitialized) {
            renderer.releasePlayerNow()                   // the decoder goes now, whatever the GL thread does
            glView.queueEvent { renderer.release() }      // GL objects (die with the context anyway)
            glView.onPause()
        }
        super.onStop()
    }
}
