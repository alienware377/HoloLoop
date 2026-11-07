package com.alienware377.hololoop.media

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.opengl.GLES30
import android.opengl.GLUtils

/** Decodes a quilt/RGBD still image and uploads it as a GL_TEXTURE_2D. */
class ImageTexture(private val context: Context, private val uri: Uri) : HologramTexture {
    private var texId = 0
    override var width = 0; private set
    override var height = 0; private set

    override fun ensure(): Int {
        if (texId != 0) return texId
        // GLUtils uploads the bitmap's top row first (t=0 = top), but the shaders
        // use the desktop-GL convention the video path has (t=0 = bottom, quilt
        // view 0 in the bottom-left tile). Flip once here so stills match video.
        val bmp = decode()?.let { flipVertically(it) } ?: throw RuntimeException("Failed to decode image: $uri")
        width = bmp.width; height = bmp.height

        val ids = IntArray(1)
        GLES30.glGenTextures(1, ids, 0)
        texId = ids[0]
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texId)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bmp, 0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, 0)
        bmp.recycle()
        return texId
    }

    private fun flipVertically(src: Bitmap): Bitmap {
        val m = android.graphics.Matrix().apply { preScale(1f, -1f) }
        val out = Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, false)
        if (out !== src) src.recycle()
        return out
    }

    private fun decode(): Bitmap? {
        val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
        return context.contentResolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, opts)
        }
    }

    override fun release() {
        if (texId != 0) {
            GLES30.glDeleteTextures(1, intArrayOf(texId), 0)
            texId = 0
        }
    }
}
