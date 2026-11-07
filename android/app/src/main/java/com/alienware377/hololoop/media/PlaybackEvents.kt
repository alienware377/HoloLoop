package com.alienware377.hololoop.media

/** Playback callbacks for HoloLoop's endless playlist. Called on the main thread. */
interface PlaybackEvents {
    fun onStarted(itemId: String?, durationMs: Long) {}
    fun onEnded(itemId: String?) {}
    fun onError(itemId: String?, message: String) {}
    fun onPosition(itemId: String?, positionMs: Long, durationMs: Long) {}
}
