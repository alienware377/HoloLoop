package com.alienware377.hololoop.media

/**
 * A source that exposes the current hologram frame as a GL_TEXTURE_2D in the
 * calling thread's GL context. Each GL context (phone preview + external
 * display Presentation) creates its own instance.
 */
interface HologramTexture {
    /** Decode/create if needed and return the GL_TEXTURE_2D id. Call on the GL thread. */
    fun ensure(): Int

    /** Advance to the newest frame (video). No-op for still images. Returns true if changed. */
    fun update(): Boolean = false

    /** Full texture pixel size (whole quilt / whole RGBD image). */
    val width: Int
    val height: Int

    /** Pixel size of the texture [ensure] last handed back (a video's steadied copy is its real size). */
    val texW: Int get() = width
    val texH: Int get() = height

    fun release()
}
