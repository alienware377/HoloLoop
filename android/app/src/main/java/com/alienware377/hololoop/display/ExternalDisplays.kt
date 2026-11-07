package com.alienware377.hololoop.display

import android.content.Context
import android.hardware.display.DisplayManager
import android.view.Display

/**
 * Finds the external display the Looking Glass presents as over USB-C
 * (DisplayPort Alt Mode). The panel enumerates as a secondary Android Display.
 */
object ExternalDisplays {

    fun manager(context: Context): DisplayManager =
        context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager

    /** The first non-default display, preferring one whose name mentions Looking Glass. */
    fun findLookingGlassDisplay(context: Context): Display? {
        val displays = manager(context).displays
        val externals = displays.filter { it.displayId != Display.DEFAULT_DISPLAY }
        return externals.firstOrNull { it.name.contains("Looking Glass", ignoreCase = true) }
            ?: externals.firstOrNull()
    }

    fun registerListener(
        context: Context,
        onChanged: () -> Unit,
    ): DisplayManager.DisplayListener {
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = onChanged()
            override fun onDisplayRemoved(displayId: Int) = onChanged()
            override fun onDisplayChanged(displayId: Int) = onChanged()
        }
        manager(context).registerDisplayListener(listener, null)
        return listener
    }
}
