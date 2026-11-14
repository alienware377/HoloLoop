package com.alienware377.hololoop.media

import org.junit.Assert.assertEquals
import org.junit.Test

class CoolSlotTest {

    /** Frame times as Media3 hands them over: ticks scaled to whole microseconds, rounded down, plus the renderer offset. */
    private fun times(frames: Int, ticksPerFrame: Long, timescale: Long): List<Long> =
        (0 until frames).map { 1_000_000_000_000L + Math.floorDiv(it * ticksPerFrame * 1_000_000L, timescale) }

    /** Gaps (in source frames) between the frames cool mode shows. */
    private fun shownGaps(t: List<Long>, cap: Int): List<Int> {
        var last = Long.MIN_VALUE
        val shown = t.indices.filter { i -> coolSlot(t[i], cap).let { s -> (s != last).also { if (it) last = s } } }
        return shown.zipWithNext { a, b -> b - a }
    }

    @Test fun videoAtTheCapShowsEveryFrame() {
        assertEquals(setOf(1), shownGaps(times(300, 512, 15360), 30).toSet())         // 30 fps at 30
        assertEquals(setOf(1), shownGaps(times(300, 512, 12288), 24).toSet())         // 24 fps at 24
        assertEquals(setOf(1), shownGaps(times(300, 1001, 30000), 30).toSet())        // 29.97 fps at 30
    }

    @Test fun fasterVideoSkipsEvenly() {
        assertEquals(setOf(2), shownGaps(times(600, 256, 15360), 30).toSet())         // 60 fps at 30: every 2nd
        assertEquals(setOf(5), shownGaps(times(600, 256, 15360), 12).toSet())         // 60 fps at 12: every 5th
        val g = shownGaps(times(600, 256, 15360), 45)                                 // 60 fps at 45: 2,1,1 over and over
        assertEquals(setOf(1, 2), g.toSet())
        assertEquals(setOf(4), g.windowed(3).map { it.sum() }.toSet())               // 3 shown per 4 source frames, evenly
        assertEquals(449, g.size)                                                     // 450 of 600 frames shown
    }
}
