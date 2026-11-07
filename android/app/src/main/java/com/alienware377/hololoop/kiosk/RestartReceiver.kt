package com.alienware377.hololoop.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Opens HoloLoop again a few seconds after a crash (the alarm is set by LoopActivity). */
class RestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // the app opens itself, so its "display over other apps" permission lets it start from the background
        if (!Settings.canDrawOverlays(context)) return
        context.startActivity(Intent(context, LoopActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
