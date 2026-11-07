package com.alienware377.hololoop.calib

import android.content.Context
import org.json.JSONObject

/** Keeps the last calibration the PC sent, so the Go works before the PC is reachable. */
object CalibrationStore {

    private const val PREFS = "lkg_calibration"
    private const val KEY = "calibration_json"

    fun save(context: Context, cal: Calibration) {
        val json = JSONObject().apply {
            put("serial", cal.serial)
            put("name", cal.name)
            put("pitch", cal.pitch.toDouble())
            put("slope", cal.slope.toDouble())
            put("center", cal.center.toDouble())
            put("dpi", cal.dpi.toDouble())
            put("screenW", cal.screenW)
            put("screenH", cal.screenH)
            put("flipImageX", cal.flipImageX)
            put("flipImageY", cal.flipImageY)
            put("invView", cal.invView)
            put("viewCone", cal.viewCone.toDouble())
        }
        prefs(context).edit().putString(KEY, json.toString()).apply()
    }

    fun load(context: Context): Calibration? {
        val text = prefs(context).getString(KEY, null) ?: return null
        return runCatching {
            val o = JSONObject(text)
            Calibration(
                serial = o.optString("serial", ""),
                name = o.optString("name", ""),
                pitch = o.getDouble("pitch").toFloat(),
                slope = o.getDouble("slope").toFloat(),
                center = o.getDouble("center").toFloat(),
                dpi = o.getDouble("dpi").toFloat(),
                screenW = o.getInt("screenW"),
                screenH = o.getInt("screenH"),
                flipImageX = o.optBoolean("flipImageX", false),
                flipImageY = o.optBoolean("flipImageY", false),
                invView = o.optBoolean("invView", false),
                viewCone = o.optDouble("viewCone", 40.0).toFloat(),
            )
        }.getOrNull()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
