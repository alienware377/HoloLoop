package com.alienware377.hololoop.calib

import kotlin.math.atan
import kotlin.math.cos

/**
 * The Go's lens calibration: the raw values from its visual.json, plus the
 * numbers the lenticular shaders take.
 */
data class Calibration(
    val serial: String = "",
    val name: String = "",
    val pitch: Float,
    val slope: Float,
    val center: Float,
    val dpi: Float,
    val screenW: Int,
    val screenH: Int,
    val flipImageX: Boolean = false,
    val flipImageY: Boolean = false,
    val invView: Boolean = false,
    val viewCone: Float = 40f,
) {
    val screenAspect: Float get() = screenW.toFloat() / screenH.toFloat()

    private val flipSign: Float get() = if (flipImageX) -1f else 1f

    /** Lens periods across the screen width, measured along the tilted lens. */
    val shaderPitch: Float
        get() = pitch * (screenW / dpi) * cos(atan(1.0 / slope)).toFloat()

    /** How far the lenses lean, in screen widths per screen height. */
    val shaderSlope: Float
        get() = screenH.toFloat() / (screenW * slope) * flipSign

    val shaderCenter: Float get() = center

    /** One subpixel in screen widths. */
    val shaderSubpixelSize: Float
        get() = 1f / (3f * screenW) * flipSign

    companion object {
        /** Stand-in until the PC sends the real calibration. */
        fun placeholder() = Calibration(
            name = "placeholder",
            pitch = 80.7f, slope = -6.6f, center = 0.5f,
            dpi = 491f, screenW = 1440, screenH = 2560,
        )
    }
}
