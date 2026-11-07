package com.alienware377.hololoop.kiosk

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.LruCache
import java.io.File
import java.util.concurrent.Executors

/**
 * Small pictures of each downloaded video for the video picker. Made on the phone from the
 * file itself (the colour half of an RGBD frame, or the middle view of a quilt), one at a time
 * so playback on the Go keeps its decoder, and kept on disk so each is only made once.
 */
class VideoThumbs(private val dir: File, private val pc: PcLink) {

    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "hololoop-thumbs").apply { priority = Thread.MIN_PRIORITY } }
    private val mem = object : LruCache<String, Bitmap>(12 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val pending = HashSet<String>()
    private val failed = HashSet<String>()     // no picture could be made: don't keep trying

    init { dir.mkdirs() }

    private fun fileFor(it: LoopItem) = File(dir, it.key.replace(Regex("[^A-Za-z0-9._-]"), "_").take(90) + ".jpg")

    /** The picture if it is ready; otherwise null, and [done] runs on the main thread once one was made. */
    fun get(it: LoopItem, done: () -> Unit): Bitmap? {
        mem.get(it.key)?.let { return it }
        if (it.key in failed || !pending.add(it.key)) return null
        worker.execute {
            val bmp = runCatching { load(it) }.onFailure { e -> Log.w("HoloLoop", "thumb ${it.name}: ${e.message}") }.getOrNull()
            main.post {
                pending.remove(it.key)
                if (bmp != null) { mem.put(it.key, bmp); done() } else failed.add(it.key)
            }
        }
        return null
    }

    /** Forget pictures of videos that are gone from the phone. */
    fun prune(keep: List<LoopItem>) {
        val names = keep.map { fileFor(it).name }.toSet()
        worker.execute { dir.listFiles()?.forEach { f -> if (f.name !in names) f.delete() } }
    }

    private fun load(it: LoopItem): Bitmap? {
        val out = fileFor(it)
        if (out.exists()) BitmapFactory.decodeFile(out.path)?.let { return it }
        val src = pc.localFile(it)
        if (!src.exists()) return null
        val frame = if (it.still) decodeStill(src) else grabFrame(src, it.duration) ?: return null
        val pic = cropPicture(frame ?: return null, it)
        if (pic !== frame) frame.recycle()
        val w = THUMB_W
        val h = (pic.height * w / pic.width.coerceAtLeast(1)).coerceIn(1, w * 2)
        val small = Bitmap.createScaledBitmap(pic, w, h, true)
        if (small !== pic) pic.recycle()
        runCatching { out.outputStream().use { small.compress(Bitmap.CompressFormat.JPEG, 85, it) } }
        return small
    }

    // a frame a fifth of the way in skips "starting soon" screens on streams
    private fun grabFrame(f: File, durationSec: Double): Bitmap? {
        val r = MediaMetadataRetriever()
        try {
            r.setDataSource(f.path)
            val dur = if (durationSec > 0) durationSec else (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0) / 1000
            val atUs = (dur * 0.2 * 1_000_000).toLong()
            val vw = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val vh = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            return if (Build.VERSION.SDK_INT >= 27 && vw > 0 && vh > 0) {
                // whole frame at about 4 thumbnails wide, so the colour half still has detail
                val s = (THUMB_W * 4f / vw).coerceAtMost(1f)
                r.getScaledFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, (vw * s).toInt().coerceAtLeast(1), (vh * s).toInt().coerceAtLeast(1))
            } else r.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } finally { runCatching { r.release() } }
    }

    private fun decodeStill(f: File): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        var sample = 1
        while (o.outWidth / (sample * 2) >= THUMB_W * 4) sample *= 2
        return BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** RGBD: the colour half (depthLoc says where the depth sits). Quilt: the middle view. */
    private fun cropPicture(b: Bitmap, it: LoopItem): Bitmap {
        val w = b.width; val h = b.height
        if (it.kind == "quilt") {
            val cols = if (it.cols > 0) it.cols else 11; val rows = if (it.rows > 0) it.rows else 6
            val tw = w / cols; val th = h / rows
            val view = cols * rows / 2
            val col = view % cols; val rowFromBottom = view / cols
            return Bitmap.createBitmap(b, col * tw, h - (rowFromBottom + 1) * th, tw.coerceAtLeast(1), th.coerceAtLeast(1))
        }
        return when (it.depthLoc) {
            0 -> Bitmap.createBitmap(b, 0, h / 2, w, h / 2)          // depth on top
            1 -> Bitmap.createBitmap(b, 0, 0, w, h / 2)              // depth below
            3 -> Bitmap.createBitmap(b, w / 2, 0, w / 2, h)          // depth on the left
            else -> Bitmap.createBitmap(b, 0, 0, w / 2, h)           // depth on the right
        }
    }

    companion object { private const val THUMB_W = 320 }
}
