package com.alienware377.hololoop.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Opens HoloLoop after the phone restarts, when "Starts with the phone" is on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON") return
        if (!LoopPrefs(context).autoStart) return
        // Android blocks apps from opening themselves in the background unless
        // they may "display over other apps"; the toggle in HoloLoop asks for it.
        if (!Settings.canDrawOverlays(context)) return
        context.startActivity(Intent(context, LoopActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
