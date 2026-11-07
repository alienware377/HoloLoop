package com.alienware377.hololoop.kiosk

import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * Sleep windows like "every day 23:00 -> 08:00" (they may cross midnight).
 * Same rules as the PC app. A manual sleep/wake holds until the schedule next
 * changes on its own, then the schedule takes over again.
 */
object SleepSchedule {

    data class Window(val days: Set<Int> = (0..6).toSet(), val fromMin: Int = 23 * 60, val toMin: Int = 8 * 60) {
        fun toJson() = JSONObject().apply {
            put("days", JSONArray(days.sorted())); put("from", hhmm(fromMin)); put("to", hhmm(toMin))
        }
    }

    data class Settings(val enabled: Boolean = false, val windows: List<Window> = listOf(Window())) {
        fun toJson(): String = JSONObject().apply {
            put("enabled", enabled)
            put("windows", JSONArray().apply { windows.forEach { put(it.toJson()) } })
        }.toString()

        companion object {
            fun fromJson(s: String?): Settings {
                if (s.isNullOrBlank()) return Settings()
                return runCatching {
                    val o = JSONObject(s)
                    val arr = o.optJSONArray("windows") ?: JSONArray()
                    val ws = (0 until arr.length()).map { i ->
                        val w = arr.getJSONObject(i)
                        val d = w.optJSONArray("days")
                        Window(
                            days = if (d == null || d.length() == 0) (0..6).toSet() else (0 until d.length()).map { d.getInt(it) }.toSet(),
                            fromMin = minutes(w.optString("from", "23:00")),
                            toMin = minutes(w.optString("to", "08:00")),
                        )
                    }
                    Settings(o.optBoolean("enabled", false), ws.ifEmpty { listOf(Window()) })
                }.getOrDefault(Settings())
            }
        }
    }

    fun minutes(hhmm: String): Int {
        val parts = hhmm.split(":")
        return (parts.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (parts.getOrNull(1)?.toIntOrNull() ?: 0)
    }
    fun hhmm(min: Int) = "%02d:%02d".format(min / 60, min % 60)

    // Calendar.DAY_OF_WEEK is 1=Sunday; we use 0=Sunday like JavaScript.
    private fun dow(c: Calendar) = c.get(Calendar.DAY_OF_WEEK) - 1

    fun inWindow(c: Calendar, w: Window): Boolean {
        val now = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        val day = dow(c); val prev = (day + 6) % 7
        val a = w.fromMin; val b = w.toMin
        if (a == b) return false
        return if (a < b) day in w.days && now >= a && now < b
        else (day in w.days && now >= a) || (prev in w.days && now < b)
    }

    fun scheduledAsleep(s: Settings, c: Calendar = Calendar.getInstance()) = s.enabled && s.windows.any { inWindow(c, it) }

    fun nextChange(s: Settings, from: Calendar = Calendar.getInstance()): Long? {
        val cur = scheduledAsleep(s, from)
        val t = from.clone() as Calendar
        t.set(Calendar.SECOND, 0); t.set(Calendar.MILLISECOND, 0)
        repeat(8 * 24 * 60) {
            t.add(Calendar.MINUTE, 1)
            if (scheduledAsleep(s, t) != cur) return t.timeInMillis
        }
        return null
    }

    // manual override
    private var override: Pair<Boolean, Long?>? = null

    fun asleep(s: Settings, now: Long = System.currentTimeMillis()): Boolean {
        override?.let { (v, until) ->
            if (until != null && now >= until) override = null else return v
        }
        val c = Calendar.getInstance().apply { timeInMillis = now }
        return scheduledAsleep(s, c)
    }

    fun sleepNow(s: Settings) { override = if (scheduledAsleep(s)) null else true to nextChange(s) }
    fun wakeNow(s: Settings) { override = if (scheduledAsleep(s)) false to nextChange(s) else null }
}
