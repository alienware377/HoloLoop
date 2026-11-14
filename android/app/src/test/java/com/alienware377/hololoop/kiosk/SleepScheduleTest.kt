package com.alienware377.hololoop.kiosk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class SleepScheduleTest {
    @Test fun sleepNowBeforeTheWindowLastsIntoIt() {
        val now = Calendar.getInstance()
        val m = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        // every day, starting 2 h from now and lasting 4 h
        val s = SleepSchedule.Settings(true, listOf(SleepSchedule.Window(fromMin = (m + 120) % 1440, toMin = (m + 360) % 1440)))
        val t = now.timeInMillis
        val h = 3_600_000L
        assertFalse(SleepSchedule.asleep(s, t))
        SleepSchedule.sleepNow(s)
        assertTrue(SleepSchedule.asleep(s, t + 3 * h))      // the "sleeping until" text looks ahead like this
        assertTrue(SleepSchedule.asleep(s, t))
        assertTrue(SleepSchedule.asleep(s, t + h))
        assertFalse(SleepSchedule.asleep(s, t + 7 * h))     // after the window the schedule decides again
        SleepSchedule.wakeNow(s)
        assertFalse(SleepSchedule.asleep(s, t))
    }
}
