package com.alienware377.hololoop.kiosk

import android.content.Context
import com.alienware377.hololoop.model.Look
import org.json.JSONArray
import org.json.JSONObject

/** Everything HoloLoop remembers on the phone. */
class LoopPrefs(context: Context) {
    private val p = context.getSharedPreferences("hololoop", Context.MODE_PRIVATE)

    var pcBase: String
        get() = p.getString("pcBase", "") ?: ""
        set(v) = p.edit().putString("pcBase", v.trim().trimEnd('/')).apply()
    var token: String
        get() = p.getString("token", "") ?: ""
        set(v) = p.edit().putString("token", v).apply()
    var muted: Boolean
        get() = p.getBoolean("muted", false)
        set(v) = p.edit().putBoolean("muted", v).apply()
    var volume: Float
        get() = p.getFloat("volume", 0.8f)
        set(v) = p.edit().putFloat("volume", v).apply()
    var shuffle: Boolean
        get() = p.getBoolean("shuffle", false)
        set(v) = p.edit().putBoolean("shuffle", v).apply()
    var useLocalLook: Boolean
        get() = p.getBoolean("useLocalLook", false)
        set(v) = p.edit().putBoolean("useLocalLook", v).apply()
    var autoStart: Boolean
        get() = p.getBoolean("autoStart", false)
        set(v) = p.edit().putBoolean("autoStart", v).apply()
    /** Cool mode: refresh the Go 30 times a second instead of 60, so the phone runs cooler. */
    var coolMode: Boolean
        get() = p.getBoolean("coolMode", false)
        set(v) = p.edit().putBoolean("coolMode", v).apply()
    /** Root of the flash drive the videos live on (its /storage path), or "" for the phone. */
    var storageRoot: String
        get() = p.getString("storageRoot", "") ?: ""
        set(v) = p.edit().putString("storageRoot", v).apply()
    var currentKey: String
        get() = p.getString("currentKey", "") ?: ""
        set(v) = p.edit().putString("currentKey", v).apply()

    /** Video filters, as FxState JSON. */
    var fxJson: String
        get() = p.getString("fx", "") ?: ""
        set(v) = p.edit().putString("fx", v).apply()

    var pcLook: Look
        get() = lookFrom(p.getString("pcLook", null))
        set(v) = p.edit().putString("pcLook", lookJson(v)).apply()
    var localLook: Look
        get() = lookFrom(p.getString("localLook", null))
        set(v) = p.edit().putString("localLook", lookJson(v)).apply()
    val look: Look get() = if (useLocalLook) localLook else pcLook

    /** One-time: the view order fix made the manual "Flip 3D" unnecessary, so clear it. */
    fun migrate() {
        if (p.getInt("migration", 0) < 1) {
            localLook = localLook.copy(depthInvert = false)
            pcLook = pcLook.copy(depthInvert = false)
            p.edit().putInt("migration", 1).apply()
        }
    }

    var sleep: SleepSchedule.Settings
        get() = SleepSchedule.Settings.fromJson(p.getString("sleep", null))
        set(v) = p.edit().putString("sleep", v.toJson()).apply()

    /** Where long videos were, so a restart continues mid-film. key -> ms */
    fun resumeAt(key: String): Long = p.getLong("resume_$key", 0)
    fun setResume(key: String, ms: Long) { p.edit().putLong("resume_$key", ms).apply() }

    /** The playlist as last synced (JSON array of LoopItem). */
    var playlistJson: String
        get() = p.getString("playlist", "[]") ?: "[]"
        set(v) = p.edit().putString("playlist", v).apply()

    companion object {
        fun lookJson(l: Look) = JSONObject().apply {
            put("depthiness", l.depthiness.toDouble()); put("focus", l.focus.toDouble())
            put("fit", if (l.fill) "fill" else "fit"); put("zoom", l.zoom.toDouble())
            put("iterations", l.iterations); put("depthInvert", l.depthInvert); put("filterEdge", l.filterEdge)
            put("edgeFix", l.edgeFix); put("steady", l.steady); put("steadyMove", l.steadyMove)
        }.toString()

        fun lookFrom(s: String?): Look {
            if (s.isNullOrBlank()) return Look()
            return runCatching { lookFrom(JSONObject(s)) }.getOrDefault(Look())
        }

        fun lookFrom(o: JSONObject): Look = Look(
            depthiness = o.optDouble("depthiness", 0.32).toFloat(),
            focus = o.optDouble("focus", 0.5).toFloat(),
            fill = o.optString("fit", "fit") == "fill",
            zoom = o.optDouble("zoom", 1.0).toFloat(),
            iterations = o.optInt("iterations", 14),
            depthInvert = o.optBoolean("depthInvert", false),
            filterEdge = o.optBoolean("filterEdge", true),
            edgeFix = o.optInt("edgeFix", 2).takeIf { it in Look.EDGE_MODES.indices } ?: 2,
            steady = o.optInt("steady", 1).takeIf { it in Look.STEADY_MODES.indices } ?: 1,
            steadyMove = o.optInt("steadyMove", 1).takeIf { it in Look.MOVE_MODES.indices } ?: 1,
        )
    }
}
