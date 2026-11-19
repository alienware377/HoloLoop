package com.alienware377.hololoop.kiosk

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors

/**
 * Switches the Looking Glass Go's screen fully off and on again.
 *
 * Going black, or even turning the phone's screen off, leaves the Go's backlight glowing: the light
 * belongs to the Go's own control chip, which also shows up on the phone as the small USB device
 * that sends its buttons (05df:16c0). That chip takes JSON commands in 64-byte HID feature reports
 * (report 0x45): POWS switches the screen and backlight off or on, POWG reads the state back.
 *
 * Talking to it means claiming its HID interface for a moment, which takes the Go's buttons away
 * from Android until it is released again (a fraction of a second).
 */
class GoPower(private val context: Context) {
    private val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val main = Handler(Looper.getMainLooper())
    private var asked = false

    /** Called on the main thread when the user answers the USB permission popup. */
    var onAccess: ((Boolean) -> Unit)? = null

    private val permReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            onAccess?.invoke(i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
        }
    }

    init {
        val filter = IntentFilter(ACTION_PERMISSION)
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(permReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") context.registerReceiver(permReceiver, filter)
    }

    fun release() {
        runCatching { context.unregisterReceiver(permReceiver) }
    }

    private fun device(): UsbDevice? = usb.deviceList.values.firstOrNull { it.vendorId == VID && it.productId == PID }

    /** The Go's control chip is plugged in. */
    val present: Boolean get() = device() != null

    /** We may talk to it (Android asks the user once; "always" when HoloLoop opened from the plug-in popup). */
    val hasAccess: Boolean get() = device()?.let { usb.hasPermission(it) } == true

    /** Shows Android's USB permission popup once per app start, if it is needed. */
    fun askAccess() {
        val d = device() ?: return
        if (usb.hasPermission(d) || asked) return
        asked = true
        val pi = PendingIntent.getBroadcast(context, 0, Intent(ACTION_PERMISSION).setPackage(context.packageName),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        usb.requestPermission(d, pi)
    }

    /**
     * Turns the Go's screen [on] or off, unless it already is. [done] gets the state read back
     * afterwards on the main thread (null when the Go could not be reached).
     */
    fun set(on: Boolean, done: ((Boolean?) -> Unit)? = null) = worker.execute {
        var state = query()
        if (state != null && state != on) {
            for (attempt in 0 until 2) {
                command("POWS", on)
                Thread.sleep(300)
                state = query()
                if (state == on) break
            }
        }
        Log.i(TAG, "screen ${if (on) "on" else "off"} -> $state")
        done?.let { main.post { it(state) } }
    }

    /** Reads whether the Go's screen is on, on the main thread (null when it could not be reached). */
    fun get(done: (Boolean?) -> Unit) = worker.execute {
        val state = query()
        main.post { done(state) }
    }

    private fun query(): Boolean? {
        val answer = command("POWG", null) ?: return null
        return Regex("\"val\"\\s*:\\s*(true|false)").find(answer)?.groupValues?.get(1)?.toBoolean()
    }

    /** Sends one command and returns the chip's answer to it (its JSON), or null. Worker thread only. */
    private fun command(cmd: String, value: Boolean?): String? {
        val dev = device() ?: return null
        if (!usb.hasPermission(dev)) return null
        val hid = (0 until dev.interfaceCount).map { dev.getInterface(it) }
            .firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_HID } ?: return null
        val inEp = (0 until hid.endpointCount).map { hid.getEndpoint(it) }
            .firstOrNull { it.direction == UsbConstants.USB_DIR_IN } ?: return null
        val conn = usb.openDevice(dev) ?: return null
        val id = ++rid
        val json = if (value == null) """{"cmd":"$cmd","rid":$id}""" else """{"cmd":"$cmd","rid":$id,"msg":{"val":$value}}"""
        try {
            if (!conn.claimInterface(hid, true)) return null
            for (frame in frames(json)) {
                if (conn.controlTransfer(0x21, SET_REPORT, 0x0300 or REPORT_ID, hid.id, frame, frame.size, 1000) < 0) return null
            }
            // the answer comes back as input reports with the same report id; skip anything else
            val buf = ByteArray(64)
            val until = System.currentTimeMillis() + 1500
            while (System.currentTimeMillis() < until) {
                val n = conn.bulkTransfer(inEp, buf, buf.size, 300)
                if (n <= 2 || buf[0].toInt() != REPORT_ID) continue
                val text = String(buf, 2, n - 2, Charsets.UTF_8)
                if (text.contains("\"cmd\":\"$cmd\"") && text.contains("\"rid\":$id")) return text
            }
            return null
        } catch (e: Exception) {
            Log.w(TAG, "$cmd failed", e)
            return null
        } finally {
            runCatching { conn.releaseInterface(hid) }
            conn.close()
        }
    }

    /** "\u0007" + JSON + "\r", cut into 64-byte reports that each start with the report id and 0x05. */
    private fun frames(json: String): List<ByteArray> {
        val data = ("\u0007" + json + "\r").toByteArray(Charsets.UTF_8)
        return (data.indices step 62).map { p ->
            ByteArray(64).also { f ->
                f[0] = REPORT_ID.toByte(); f[1] = 0x05
                System.arraycopy(data, p, f, 2, minOf(62, data.size - p))
            }
        }
    }

    private companion object {
        val worker = Executors.newSingleThreadExecutor { Thread(it, "GoPower").apply { isDaemon = true } }
        var rid = 0
        const val TAG = "GoPower"
        const val VID = 0x05df
        const val PID = 0x16c0
        const val REPORT_ID = 0x45
        const val SET_REPORT = 0x09
        const val ACTION_PERMISSION = "com.alienware377.hololoop.GO_POWER_PERMISSION"
    }
}
