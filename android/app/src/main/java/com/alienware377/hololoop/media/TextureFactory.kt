package com.alienware377.hololoop.media

import android.content.Context
import com.alienware377.hololoop.model.HologramItem
import com.alienware377.hololoop.model.HologramKind

object TextureFactory {
    /**
     * Build a per-context texture for the item. Video needs a known pixel size up
     * front for its FBO; falls back to a sane default if metadata is unavailable.
     */
    fun create(context: Context, item: HologramItem, videoW: Int = 0, videoH: Int = 0, events: PlaybackEvents? = null): HologramTexture =
        when (item.kind) {
            HologramKind.QUILT_IMAGE, HologramKind.RGBD_IMAGE ->
                ImageTexture(context, item.uri)
            HologramKind.QUILT_VIDEO, HologramKind.RGBD_VIDEO -> {
                val w = if (videoW > 0) videoW else if (item.videoW > 0) item.videoW else 4096
                val h = if (videoH > 0) videoH else if (item.videoH > 0) item.videoH else 4096
                VideoTexture(context, item.uri, w, h, item.loop, item.startAtMs, item.volume, item.id, events)
            }
        }
}
