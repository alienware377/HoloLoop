package com.alienware377.hololoop.model

import android.net.Uri

enum class HologramKind { QUILT_IMAGE, QUILT_VIDEO, RGBD_IMAGE, RGBD_VIDEO }

/**
 * A loadable hologram and its layout parameters.
 *
 * Quilt files encode their grid in the filename, e.g. `name_qs5x9a0.75.jpg`
 * => 5 columns, 9 rows, view aspect 0.75. RGBD files carry depth params instead.
 */
data class HologramItem(
    val uri: Uri,
    val displayName: String,
    val kind: HologramKind,
    // quilt layout
    val cols: Int = 5,
    val rows: Int = 9,
    val viewAspect: Float = 0.75f,
    // view_portion: fraction of the quilt texture actually covered by views
    // (1.0 unless the quilt has padding). Defaults to full.
    val viewPortionX: Float = 1f,
    val viewPortionY: Float = 1f,
    // RGBD params
    val depthLoc: Int = 1,        // 0 top,1 bottom,2 right,3 left
    val depthInversion: Boolean = false,
    val depthiness: Float = 0.5f,
    val focus: Float = 0.5f,
    // playback (HoloLoop): loop forever by default, as the studio preview always did
    val loop: Boolean = true,
    val startAtMs: Long = 0,
    val volume: Float = 0f,
    val videoW: Int = 0,
    val videoH: Int = 0,
    val id: String? = null,
    // HoloLoop framing (RGBD): worked out on the PC; mode auto / fit / fill
    val framing: Framing? = null,
    val frameMode: String = "auto",
) {
    val totalViews: Int get() = cols * rows

    /** True for any RGBD source (still or video): its views are made from the depth. */
    val isRgbd: Boolean get() = kind == HologramKind.RGBD_IMAGE || kind == HologramKind.RGBD_VIDEO

    companion object {
        private val QS = Regex("_qs(\\d+)x(\\d+)(?:a([0-9]*\\.?[0-9]+))?", RegexOption.IGNORE_CASE)

        fun fromFilename(uri: Uri, name: String, kind: HologramKind): HologramItem {
            val m = QS.find(name)
            if (kind == HologramKind.RGBD_IMAGE || kind == HologramKind.RGBD_VIDEO) {
                // RGBD carries depth params; cols/rows are the *target* quilt grid
                // produced by the on-device conversion (defaults 5x9).
                return HologramItem(uri, name, kind)
            }
            val cols = m?.groupValues?.get(1)?.toIntOrNull() ?: 5
            val rows = m?.groupValues?.get(2)?.toIntOrNull() ?: 9
            val aspect = m?.groupValues?.get(3)?.toFloatOrNull() ?: 0.75f
            return HologramItem(uri, name, kind, cols = cols, rows = rows, viewAspect = aspect)
        }

        /** Heuristic: pick a kind from the file name / extension. */
        fun guessKind(name: String): HologramKind {
            val lower = name.lowercase()
            val isVideo = lower.endsWith(".mp4") || lower.endsWith(".mov") ||
                lower.endsWith(".webm") || lower.endsWith(".mkv")
            val isRgbd = lower.contains("rgbd") || lower.contains("_depth") || lower.contains("depth")
            return when {
                isVideo && isRgbd -> HologramKind.RGBD_VIDEO
                isVideo -> HologramKind.QUILT_VIDEO
                isRgbd -> HologramKind.RGBD_IMAGE
                else -> HologramKind.QUILT_IMAGE
            }
        }

        /** True if [name] looks like a video file by extension. */
        fun isVideoName(name: String): Boolean {
            val lower = name.lowercase()
            return lower.endsWith(".mp4") || lower.endsWith(".mov") ||
                lower.endsWith(".webm") || lower.endsWith(".mkv")
        }
    }
}
