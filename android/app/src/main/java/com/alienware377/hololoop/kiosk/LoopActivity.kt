package com.alienware377.hololoop.kiosk

import android.app.TimePickerDialog
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.slider.Slider
import com.google.android.material.textfield.TextInputEditText
import com.alienware377.hololoop.BuildConfig
import com.alienware377.hololoop.R
import com.alienware377.hololoop.calib.Calibration
import com.alienware377.hololoop.calib.CalibrationStore
import com.alienware377.hololoop.display.ExternalDisplays
import com.alienware377.hololoop.display.HologramPresentation
import com.alienware377.hololoop.fx.FxState
import com.alienware377.hololoop.media.PlaybackEvents
import com.alienware377.hololoop.model.HologramItem
import com.alienware377.hololoop.model.HologramKind
import java.io.File
import kotlin.concurrent.thread

/**
 * HoloLoop's kiosk screen. The phone sits by the Go, plugged in, showing a
 * black screen; the Go loops the PC's 3D videos forever, sleeps on schedule,
 * and new videos arrive over Wi-Fi by themselves. Tap the phone to see controls.
 */
class LoopActivity : AppCompatActivity(), PlaybackEvents, GoMenu.Host, FxPanel.Host {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var prefs: LoopPrefs
    private lateinit var pc: PcLink
    private lateinit var thumbs: VideoThumbs

    private var calibration: Calibration? = null
    private var presentation: HologramPresentation? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    private var items: List<LoopItem> = emptyList()      // downloaded, in loop order
    private var current: LoopItem? = null
    private var playing = false
    private var paused = false
    private var asleep = false
    private var posMs = 0L
    private var durMs = 0L
    private var lastResumeSave = 0L
    private val errors = HashMap<String, Int>()
    private val history = ArrayDeque<String>()      // keys in the order they played (for shuffle and Back)
    private var stillRunnable: Runnable? = null

    private var refreshLookUi: () -> Unit = {}     // set in bindViews: redraws the 3D look controls
    private lateinit var root: View

    @Volatile private var syncing = false
    private var syncText = ""
    private var lastSyncAt = 0L
    private var syncOkAt = 0L            // last time the PC answered and everything was fetched
    @Volatile private var syncErr: String? = null      // why the last sync failed (null = it worked)
    @Volatile private var syncErrCode = 0
    // short-lived messages: shown for a while, then the normal status takes over again
    private var pcNote = ""
    private var pcNoteUntil = 0L
    private var note = ""
    private var noteUntil = 0L
    private var showPcForm = false       // "Link a different PC" pressed
    private fun notePc(msg: String, ms: Long = 30_000) { pcNote = msg; pcNoteUntil = System.currentTimeMillis() + ms; render() }
    private fun note(msg: String, ms: Long = 60_000) { note = msg; noteUntil = System.currentTimeMillis() + ms; render() }
    private var lastTouch = System.currentTimeMillis()

    // views
    private lateinit var panel: View
    private lateinit var blackout: View
    private lateinit var chips: TextView
    private lateinit var nowLabel: TextView
    private lateinit var nowTitle: TextView
    private lateinit var nowTimes: TextView
    private lateinit var nowProgress: LinearProgressIndicator
    private lateinit var playBtn: MaterialButton
    private lateinit var sleepBtn: MaterialButton
    private lateinit var syncStatus: TextView
    private lateinit var pcStatus: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        installRestartOnCrash()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_loop)
        prefs = LoopPrefs(this)
        prefs.migrate()
        pc = PcLink(this, prefs)
        thumbs = VideoThumbs(File(cacheDir, "thumbs"), pc)
        fxNow = FxState.fromJson(prefs.fxJson)
        calibration = CalibrationStore.load(this)
        items = LoopItem.listFrom(prefs.playlistJson).filter { pc.isReady(it) }
        bindViews()
        root = findViewById<View>(R.id.root).apply { isFocusableInTouchMode = true; defaultFocusHighlightEnabled = false; requestFocus() }
        displayListener = ExternalDisplays.registerListener(this) { main.post { refreshPresentation() } }
        refreshPresentation()
        startMediaSession()
        main.post(ticker)
        main.postDelayed({ syncNow() }, 1500)
    }

    /** If the app crashes, open HoloLoop again a few seconds later so the Go keeps playing. */
    private fun installRestartOnCrash() {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is RestartHandler) return
        Thread.setDefaultUncaughtExceptionHandler(RestartHandler(applicationContext, previous))
    }

    private class RestartHandler(val ctx: android.content.Context, val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(t: Thread, e: Throwable) {
            runCatching {
                val sp = ctx.getSharedPreferences("hololoop_crash", MODE_PRIVATE)
                val now = System.currentTimeMillis()
                val recent = (sp.getString("times", "") ?: "").split(',').mapNotNull { it.toLongOrNull() }.filter { now - it < 10 * 60_000 }
                sp.edit().putString("times", (recent + now).joinToString(",")).putString("last", "${e.javaClass.simpleName}: ${e.message}").commit()
                if (recent.size < 3 && Settings.canDrawOverlays(ctx)) {
                    val pi = android.app.PendingIntent.getBroadcast(ctx, 7, Intent(ctx, RestartReceiver::class.java),
                        android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_CANCEL_CURRENT)
                    (ctx.getSystemService(ALARM_SERVICE) as android.app.AlarmManager)
                        .set(android.app.AlarmManager.RTC, now + 3_000, pi)
                }
            }
            previous?.uncaughtException(t, e)
        }
    }

    override fun onResume() {
        super.onResume()
        findViewById<MaterialSwitch>(R.id.autoStartSwitch)?.isChecked = prefs.autoStart && Settings.canDrawOverlays(this)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        mediaSession?.release(); mediaSession = null
        displayListener?.let { ExternalDisplays.manager(this).unregisterDisplayListener(it) }
        presentation?.dismiss(); presentation = null
        super.onDestroy()
    }

    // The Go's own buttons show up as a little USB media remote
    // ("Looking Glass Go Consumer Control"): next, back, play/pause.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean = goKey(event) || super.dispatchKeyEvent(event)

    // Some phones (Samsung) hand media keys straight to the system's media controls, so they
    // never reach the window. A media session of our own makes the system pass them back to us.
    private var mediaSession: MediaSession? = null

    private fun startMediaSession() {
        mediaSession = MediaSession(this, "HoloLoop").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(intent: Intent): Boolean {
                    @Suppress("DEPRECATION") val e = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
                    return goKey(e)
                }
            }, main)
            setPlaybackState(PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                    PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build())
            isActive = true
        }
    }

    private fun goKey(e: KeyEvent): Boolean {
        val fromGo = e.device?.name?.contains("Looking Glass", ignoreCase = true) == true
        // 1 next, -1 back, 0 play/pause, 2 play, 3 pause. Plain numbers: function references made
        // by Kotlin 2 never compare equal, so telling ::goNext apart from ::goPrev silently failed.
        val key = when (e.keyCode) {
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD -> 1
            KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND, KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD -> -1
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> 0
            KeyEvent.KEYCODE_MEDIA_PLAY -> 2
            KeyEvent.KEYCODE_MEDIA_PAUSE -> 3
            // only from the Go: these are normal keys on the phone itself
            KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_VOLUME_UP -> if (fromGo) 1 else null
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> if (fromGo) -1 else null
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_SPACE -> if (fromGo) 0 else null
            else -> null
        }
        if (fromGo) Log.i(TAG, "Go key ${KeyEvent.keyCodeToString(e.keyCode)} ${if (e.action == KeyEvent.ACTION_DOWN) "down" else "up"} repeat=${e.repeatCount}")
        if (key == null) return false
        if (key == 0) return playKey(e)
        val act: () -> Unit = when (key) {
            1 -> ::goNext
            -1 -> ::goPrev
            2 -> { { if (asleep || !playing || paused) goPlayPause() } }
            else -> { { if (!asleep && playing && !paused) goPlayPause() } }
        }
        val dir = if (key == 1 || key == -1) key else 0
        // the filter menu on the Go has the buttons while it is open; there next moves up the list
        goMenu?.takeIf { it.isOpen && dir != 0 }?.let { if (e.action == KeyEvent.ACTION_DOWN) it.move(-dir, e.repeatCount); return true }
        val video = current?.let { !it.still } == true            // stills and the test pattern have nothing to skip
        if (dir != 0 && (holdDir != 0 || (!asleep && playing && video))) return holdKey(e, dir)
        if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0) main.post(act)
        return true
    }

    // Play: a press plays or pauses; two quick presses open the filter menu on the Go (holding it
    // is no use: Android keeps a held play button for the voice assistant). In the menu a press picks.
    private var lastPlayPress = 0L
    private val playSingle = Runnable { goPlayPause() }

    private fun playKey(e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN || e.repeatCount != 0) return true
        val m = goMenu
        if (m?.isOpen == true) { m.ok(); return true }
        val now = SystemClock.uptimeMillis()
        if (m != null && !asleep && now - lastPlayPress < DOUBLE_PRESS_MS) {
            main.removeCallbacks(playSingle); lastPlayPress = 0L
            m.open(); return true
        }
        lastPlayPress = now
        main.removeCallbacks(playSingle)
        // with no Go menu to open there is nothing to wait for
        if (m == null || asleep) main.post(playSingle) else main.postDelayed(playSingle, DOUBLE_PRESS_MS)
        return true
    }

    // ------------------------------------------------------------------ video filters
    private var fxNow = FxState()
    override val fx: FxState get() = fxNow
    private var goMenu: GoMenu? = null
    private var fxPanel: FxPanel? = null
    private lateinit var fxView: android.widget.FrameLayout
    private val fxBack = object : OnBackPressedCallback(false) { override fun handleOnBackPressed() = closeFx() }
    private val menuTimeout = Runnable { goMenu?.close() }

    override fun setFx(s: FxState) {
        if (s == fx) { goMenu?.refresh(); return }
        fxNow = s
        prefs.fxJson = s.toJson()
        presentation?.fx = s
        goMenu?.refresh()
        fxPanel?.refresh()
        fxButtonText()
    }

    private fun fxButtonText() {
        findViewById<MaterialButton>(R.id.fxBtn)?.text = getString(R.string.loop_filters) + if (fx.on && fx.active.isNotEmpty()) " (on)" else ""
    }

    override fun touched() { main.removeCallbacks(menuTimeout); main.postDelayed(menuTimeout, MENU_TIMEOUT_MS) }
    override fun closed() { main.removeCallbacks(menuTimeout) }

    private fun bindFx() {
        fxView = findViewById(R.id.fxPanel)
        findViewById<MaterialButton>(R.id.fxBtn).setOnClickListener { openFx() }
        onBackPressedDispatcher.addCallback(this, fxBack)
        fxButtonText()
    }

    private fun openFx() {
        if (fxPanel == null) fxPanel = FxPanel(this, this).also { fxView.addView(it.build()) }
        fxPanel?.refresh()
        fxView.visibility = View.VISIBLE; fxBack.isEnabled = true
    }

    override fun closeFx() { fxView.visibility = View.GONE; fxBack.isEnabled = false; root.requestFocus() }

    // Next / Back: a press changes video; held for HOLD_MS they skip through the video instead,
    // 10 s jumps, then 30 s, then 60 s the longer they are held. Letting go just keeps playing.
    private var holdDir = 0
    private var holdSince = 0L
    private var holdItem: String? = null
    private var skipping = false
    private val holdTick = object : Runnable {
        override fun run() {
            if (holdDir == 0) return
            skipping = true
            if (current?.key != holdItem) return             // the video changed under the hold: stop skipping
            val held = System.currentTimeMillis() - holdSince
            presentation?.seekBy(holdDir * when { held < 3000 -> 10_000L; held < 6000 -> 30_000L; else -> 60_000L })
            main.postDelayed(this, 350)
        }
    }

    private fun holdKey(e: KeyEvent, dir: Int): Boolean {
        if (e.action == KeyEvent.ACTION_DOWN && e.repeatCount == 0) main.post {
            holdDir = dir; holdSince = System.currentTimeMillis(); holdItem = current?.key; skipping = false
            main.removeCallbacks(holdTick); main.postDelayed(holdTick, HOLD_MS)
        } else if (e.action == KeyEvent.ACTION_UP) main.post {
            if (holdDir != dir) return@post
            main.removeCallbacks(holdTick)
            val skipped = skipping
            holdDir = 0; skipping = false
            if (!skipped) { if (dir > 0) goNext() else goPrev() }
        }
        return true
    }

    private fun goNext() { if (asleep) wakeNow() else { playNext(); render() } }
    private fun goPrev() { if (asleep) wakeNow() else { playPrev(); render() } }
    private fun goPlayPause() {
        when {
            asleep -> wakeNow()
            !playing -> playNext()
            else -> { paused = !paused; presentation?.setPaused(paused) }
        }
        render()
    }
    private fun wakeNow() { wakeCache = null; SleepSchedule.wakeNow(prefs.sleep); setAsleep(SleepSchedule.asleep(prefs.sleep)) }

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        if (ev?.action == MotionEvent.ACTION_DOWN) {
            val wasBlack = blackout.visibility == View.VISIBLE
            lastTouch = System.currentTimeMillis()
            showPanel(true)
            if (wasBlack) return true       // first tap only wakes the screen
        }
        return super.dispatchTouchEvent(ev)
    }

    // ------------------------------------------------------------------ screen
    private fun showPanel(show: Boolean) {
        blackout.visibility = if (show) View.GONE else View.VISIBLE
        if (!show && ::root.isInitialized) root.requestFocus()
        val lp = window.attributes
        lp.screenBrightness = if (show) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else 0.01f
        window.attributes = lp
    }

    private val ticker = object : Runnable {
        override fun run() {
            val sl = SleepSchedule.asleep(prefs.sleep)
            if (sl != asleep) setAsleep(sl)
            if (System.currentTimeMillis() - lastTouch > 25_000 && blackout.visibility != View.VISIBLE) showPanel(false)
            if (!syncing && System.currentTimeMillis() - lastSyncAt > 10 * 60_000) syncNow()
            if (!playing && !asleep && presentation != null && items.isNotEmpty()) playNext()
            render()
            main.postDelayed(this, 1000)
        }
    }

    // ------------------------------------------------------------------ Go display
    private fun refreshPresentation() {
        val display = ExternalDisplays.findLookingGlassDisplay(this)
        val cal = calibration
        if (display == null || cal == null) {
            presentation?.dismiss(); presentation = null; goMenu = null; playing = false
            return
        }
        val p = presentation
        if (p != null && p.isShowing && p.display.displayId == display.displayId) return
        p?.dismiss()
        presentation = HologramPresentation(this, display, cal, null).also {
            it.look = prefs.look
            it.events = this
            it.keys = ::goKey
            it.fx = fx
            val menu = GoMenu(it.context, this)
            it.overlay = menu
            goMenu = menu
            it.setOnDismissListener { _ -> if (presentation === it) { presentation = null; goMenu = null; playing = false; main.post { refreshPresentation() } } }
            runCatching { it.show() }.onFailure { e -> Log.w(TAG, "presentation failed", e) }
        }
        playing = false
        Log.i(TAG, "Go display ${display.displayId} ${display.name}")
    }

    // ------------------------------------------------------------------ playback
    private fun hologramFor(it: LoopItem, file: File): HologramItem {
        val kind = when {
            it.kind == "quilt" && it.still -> HologramKind.QUILT_IMAGE
            it.kind == "quilt" -> HologramKind.QUILT_VIDEO
            it.still -> HologramKind.RGBD_IMAGE
            else -> HologramKind.RGBD_VIDEO
        }
        val long = it.duration >= 10 * 60
        return HologramItem(
            uri = Uri.fromFile(file), displayName = it.name, kind = kind,
            cols = if (it.cols > 0) it.cols else 11, rows = if (it.rows > 0) it.rows else 6,
            viewAspect = if (it.aspect > 0) it.aspect else 0.5625f,
            depthLoc = it.depthLoc, loop = false,
            startAtMs = if (long) prefs.resumeAt(it.key) else 0,
            volume = if (prefs.muted) 0f else prefs.volume,
            videoW = it.width, videoH = it.height, id = it.key,
            framing = com.alienware377.hololoop.model.Framing.parse(it.framingJson), frameMode = it.frame,
        )
    }

    private fun play(it: LoopItem?) {
        stillRunnable?.let { r -> main.removeCallbacks(r) }; stillRunnable = null
        val p = presentation
        if (it == null || p == null || asleep) { playing = false; current = it ?: current; p?.updateItem(null); return }
        val f = pc.localFile(it)
        if (!f.exists()) { playing = false; return }
        current = it; playing = true; paused = false; posMs = 0; durMs = (it.duration * 1000).toLong()
        if (history.lastOrNull() != it.key) { history.addLast(it.key); while (history.size > 200) history.removeFirst() }
        prefs.currentKey = it.key
        p.look = prefs.look
        p.updateItem(hologramFor(it, f))
        if (it.still) {
            stillRunnable = Runnable { if (current?.key == it.key) playNext() }.also { r -> main.postDelayed(r, 20_000) }
        }
        Log.i(TAG, "play ${it.name} framing=${it.framingJson?.length ?: 0} chars, frame=${it.frame}")
    }

    private fun playNext() {
        if (items.isEmpty()) { play(null); return }
        val cur = current
        // after a restart (or a video picked before the Go was plugged in), that one comes first, shuffled or not
        if (cur == null) items.firstOrNull { it.key == prefs.currentKey && (errors[it.key] ?: 0) < 3 }?.let { play(it); return }
        val idx = if (cur == null) -1 else items.indexOfFirst { it.key == cur.key }
        if (prefs.shuffle && items.size > 1) {
            // shuffled: anything not played lately (last half of the list), never the same one twice in a row
            val recent = history.toList().takeLast(items.size / 2).toSet()
            val ok = items.filter { it.key != cur?.key && (errors[it.key] ?: 0) < 3 }
            val pick = ok.filter { it.key !in recent }.ifEmpty { ok }
            if (pick.isNotEmpty()) { play(pick.random()); return }
        }
        var n = (idx + 1).mod(items.size)
        // skip things that keep failing
        repeat(items.size) {
            if ((errors[items[n].key] ?: 0) < 3) { play(items[n]); return }
            n = (n + 1) % items.size
        }
        play(null)
    }

    private fun playPrev() {
        if (items.isEmpty()) return
        if (prefs.shuffle) {
            // shuffled: Back goes to what played before
            if (history.lastOrNull() == current?.key) history.removeLast()
            while (history.isNotEmpty()) {
                val k = history.removeLast()
                val it = items.firstOrNull { x -> x.key == k }
                if (it != null && it.key != current?.key) { play(it); return }
            }
        }
        val idx = items.indexOfFirst { it.key == current?.key }
        play(items[(idx - 1).mod(items.size)])
    }

    private fun setAsleep(v: Boolean) {
        asleep = v
        Log.i(TAG, if (v) "sleep" else "wake")
        if (v) { stillRunnable?.let { main.removeCallbacks(it) }; playing = false; presentation?.updateItem(null) }
        else {
            val cur = current?.let { c -> items.firstOrNull { it.key == c.key } }
            if (cur != null) play(cur) else playNext()
        }
    }

    // PlaybackEvents (main thread)
    override fun onStarted(itemId: String?, durationMs: Long) { if (durationMs > 0) durMs = durationMs; itemId?.let { errors.remove(it) } }
    override fun onEnded(itemId: String?) {
        if (itemId != current?.key) return
        itemId?.let { prefs.setResume(it, 0) }
        playNext()
    }
    override fun onError(itemId: String?, message: String) {
        Log.w(TAG, "play error $itemId: $message")
        if (itemId != null) errors[itemId] = (errors[itemId] ?: 0) + 1
        main.postDelayed({ if (current?.key == itemId) playNext() }, 1500)
    }
    override fun onPosition(itemId: String?, positionMs: Long, durationMs: Long) {
        posMs = positionMs; if (durationMs > 0) durMs = durationMs
        val now = System.currentTimeMillis()
        if (itemId != null && durMs >= 10 * 60_000 && now - lastResumeSave > 10_000) {
            lastResumeSave = now; prefs.setResume(itemId, (positionMs - 5000).coerceAtLeast(0))
        }
    }

    // ------------------------------------------------------------------ sync
    private fun syncNow() {
        if (syncing || !isLinked()) { if (!isLinked()) syncText = ""; return }
        syncing = true; lastSyncAt = System.currentTimeMillis()
        syncText = "Checking the PC..."
        thread(name = "hololoop-sync") {
            try {
                val list = pc.fetchList()
                list.look?.let { prefs.pcLook = LoopPrefs.lookFrom(it) }
                list.calibration?.let { raw -> applyPcCalibration(raw) }
                main.post { presentation?.look = prefs.look; refreshLookUi() }
                prefs.playlistJson = LoopItem.listJson(list.items)
                pc.dropReplaced(list.items)
                main.post { items = list.items.filter { x -> pc.isReady(x) } }
                var done = 0
                for (it in list.items) {
                    if (it.waitCopy && !pc.isReady(it)) { done++; continue }     // a smaller copy is on its way
                    if (!pc.localFile(it).exists() || pc.localFile(it).length() != it.size) {
                        pc.download(it, { have, total ->
                            syncText = "Getting ${it.name}: ${(have * 100 / total.coerceAtLeast(1))}% (${done + 1} of ${list.items.count { x -> !pc.localFile(x).exists() } + done})"
                        }, { isDestroyed })
                    }
                    done++
                    val ready = list.items.filter { x -> pc.isReady(x) }
                    main.post { items = ready }
                }
                pc.prune(list.items)
                val ready = list.items.filter { pc.isReady(it) }
                main.post { items = ready }
                val coming = list.items.count { x -> x.waitCopy && !pc.isReady(x) }
                syncText = "Up to date: ${ready.size} video${if (ready.size == 1) "" else "s"}" +
                    (if (coming > 0) ", $coming more once the PC has made smaller copies" else "") + ". Checks again every 10 minutes."
                syncOkAt = System.currentTimeMillis(); syncErr = null; syncErrCode = 0
            } catch (e: PcLink.HttpError) {
                syncText = if (e.code == 401) "The PC wants the PIN again." else "Couldn't reach the PC: ${e.message}"
                syncErr = syncText; syncErrCode = e.code
                if (e.code == 401) main.post { showPcForm = true; if (sections.isNotEmpty()) for (o in sections) setOpen(o, o === sections[0]) }
            } catch (e: Exception) {
                syncText = "Couldn't reach the PC (${e.javaClass.simpleName}). Is it on, with HoloLoop open?"
                syncErr = syncText; syncErrCode = 0
                Log.w(TAG, "sync", e)
            } finally { syncing = false }
        }
    }

    /** The PC knows the Go's calibration; keep a copy so a new phone works at once. */
    private fun applyPcCalibration(raw: org.json.JSONObject) {
        runCatching {
            val c = Calibration(
                serial = raw.optString("serial"), pitch = raw.getDouble("pitch").toFloat(), slope = raw.getDouble("slope").toFloat(),
                center = raw.getDouble("center").toFloat(), dpi = raw.optDouble("dpi", 491.0).toFloat(),
                screenW = raw.optInt("screenW", 1440), screenH = raw.optInt("screenH", 2560),
                flipImageX = raw.optBoolean("flipImageX"), flipImageY = raw.optBoolean("flipImageY"),
                invView = raw.optBoolean("invView"), viewCone = raw.optDouble("viewCone", 40.0).toFloat(),
            )
            val old = calibration
            if (old == null || old.serial != c.serial || old.pitch != c.pitch || old.center != c.center) {
                CalibrationStore.save(this, c)
                main.post {
                    calibration = c
                    presentation?.updateCalibration(c) ?: refreshPresentation()
                }
            }
        }.onFailure { Log.w(TAG, "calibration from PC", it) }
    }

    // ------------------------------------------------------------------ UI
    private fun bindViews() {
        panel = findViewById(R.id.panel); blackout = findViewById(R.id.blackout)
        chips = findViewById(R.id.chips); nowLabel = findViewById(R.id.nowLabel); nowTitle = findViewById(R.id.nowTitle)
        nowTimes = findViewById(R.id.nowTimes); nowProgress = findViewById(R.id.nowProgress)
        playBtn = findViewById(R.id.playBtn); sleepBtn = findViewById(R.id.sleepBtn)
        syncStatus = findViewById(R.id.syncStatus); pcStatus = findViewById(R.id.pcStatus)
        findViewById<TextView>(R.id.buildStamp).text = "HoloLoop ${BuildConfig.VERSION_NAME} · built ${BuildConfig.BUILD_STAMP}"

        findViewById<MaterialButton>(R.id.nextBtn).setOnClickListener { goNext() }
        findViewById<MaterialButton>(R.id.prevBtn).setOnClickListener { goPrev() }
        playBtn.setOnClickListener { goPlayPause() }
        findViewById<MaterialButton>(R.id.shuffleBtn).setOnClickListener { prefs.shuffle = !prefs.shuffle; render() }
        bindPicker()
        bindFx()
        sleepBtn.setOnClickListener {
            val s = prefs.sleep
            wakeCache = null
            if (asleep) SleepSchedule.wakeNow(s) else SleepSchedule.sleepNow(s)
            setAsleep(SleepSchedule.asleep(s)); render()
        }
        findViewById<MaterialButton>(R.id.syncBtn).setOnClickListener {
            if (!isLinked()) { note("Link your PC first (Your PC, below).", 8_000); for (o in sections) setOpen(o, o === sections.firstOrNull()); return@setOnClickListener }
            lastSyncAt = 0; syncNow()
        }

        val addr = findViewById<TextInputEditText>(R.id.pcAddress)
        val pin = findViewById<TextInputEditText>(R.id.pcPin)
        addr.setText(prefs.pcBase)
        findViewById<MaterialButton>(R.id.findBtn).setOnClickListener {
            notePc("Looking around the Wi-Fi...")
            thread {
                val found = runCatching { pc.discover() }.getOrDefault(emptyList())
                main.post {
                    if (found.isEmpty()) notePc("No PC found. Is HoloLoop open on it, with \"Let phones connect\" on?")
                    else { addr.setText(found[0].first); notePc("Found ${found[0].second}. Type its PIN and press Connect.", 120_000) }
                }
            }
        }
        findViewById<MaterialButton>(R.id.connectBtn).setOnClickListener {
            val base = addr.text?.toString()?.trim().orEmpty()
            val code = pin.text?.toString()?.trim().orEmpty()
            if (base.isEmpty()) { notePc("Type the PC's address first (or press Find my PC)."); return@setOnClickListener }
            notePc("Connecting...")
            thread {
                val err = runCatching { pc.login(if (base.contains(':')) base else "$base:8787", code) }.exceptionOrNull()
                main.post {
                    if (err == null) { notePc("Linked!", 5_000); pin.setText(""); showPcForm = false; syncOkAt = 0; syncErr = null; lastSyncAt = 0; syncNow() }
                    else notePc("That didn't work: ${err.message}", 60_000)
                }
            }
        }

        val sound = findViewById<MaterialSwitch>(R.id.soundSwitch)
        val vol = findViewById<Slider>(R.id.volumeSlider)
        sound.isChecked = !prefs.muted; vol.value = prefs.volume.coerceIn(0f, 1f)
        sound.setOnCheckedChangeListener { _, on -> prefs.muted = !on; presentation?.setVolume(if (on) prefs.volume else 0f) }
        vol.addOnChangeListener { _, v, fromUser -> if (fromUser) { prefs.volume = v; if (!prefs.muted) presentation?.setVolume(v) } }

        val localLook = findViewById<MaterialSwitch>(R.id.localLookSwitch)
        val depth = findViewById<Slider>(R.id.depthSlider)
        val focus = findViewById<Slider>(R.id.focusSlider)
        val fill = findViewById<MaterialSwitch>(R.id.fillSwitch)
        val flip = findViewById<MaterialSwitch>(R.id.flipSwitch)
        val depthLabel = findViewById<TextView>(R.id.depthLabel)
        val focusLabel = findViewById<TextView>(R.id.focusLabel)
        fun showLook() {
            val l = prefs.look
            localLook.isChecked = prefs.useLocalLook
            depth.value = l.depthiness.coerceIn(0f, 0.8f); focus.value = l.focus.coerceIn(0f, 1f)
            fill.isChecked = l.fill; flip.isChecked = l.depthInvert
            depthLabel.text = "3D strength: ${(l.depthiness / 0.8f * 100).toInt()}%"
            focusLabel.text = "What sits on the glass: " + when { l.focus < 0.4f -> "far things"; l.focus > 0.6f -> "near things"; else -> "middle" }
            // always usable: changing one switches to this phone's own 3D settings
        }
        fun pushLook(edit: (com.alienware377.hololoop.model.Look) -> com.alienware377.hololoop.model.Look) {
            // touching any 3D control switches to this phone's own settings, starting from the PC's
            if (!prefs.useLocalLook) { prefs.localLook = prefs.pcLook; prefs.useLocalLook = true }
            prefs.localLook = edit(prefs.localLook); presentation?.look = prefs.look; showLook()
        }
        // 3D edge fixing: each tap moves to the next way of cleaning up edges
        val edgeBtn = findViewById<MaterialButton>(R.id.edgeBtn)
        val modes = com.alienware377.hololoop.model.Look.EDGE_MODES
        fun showEdge() { edgeBtn.text = "3D edges: " + modes[prefs.look.edgeFix.coerceIn(0, modes.size - 1)] }
        edgeBtn.setOnClickListener { pushLook { it.copy(edgeFix = (prefs.look.edgeFix + 1) % modes.size) }; showEdge() }
        showEdge()
        // steady edges: smoothing between frames, Off / Normal / Strong
        val steadyBtn = findViewById<MaterialButton>(R.id.steadyBtn)
        val steadyModes = com.alienware377.hololoop.model.Look.STEADY_MODES
        fun showSteady() { steadyBtn.text = "Steady edges: " + steadyModes[prefs.look.steady.coerceIn(0, steadyModes.size - 1)] }
        steadyBtn.setOnClickListener { pushLook { it.copy(steady = (prefs.look.steady + 1) % steadyModes.size) }; showSteady() }
        showSteady()
        showLook()
        refreshLookUi = { showLook(); showEdge(); showSteady(); render() }
        localLook.setOnCheckedChangeListener { _, on ->
            if (on && !prefs.useLocalLook) prefs.localLook = prefs.pcLook     // start from what the PC had
            prefs.useLocalLook = on; presentation?.look = prefs.look; refreshLookUi()
        }
        depth.addOnChangeListener { _, v, u -> if (u) pushLook { it.copy(depthiness = v) } }
        focus.addOnChangeListener { _, v, u -> if (u) pushLook { it.copy(focus = v) } }
        fill.setOnCheckedChangeListener { b, on -> if (b.isPressed) pushLook { it.copy(fill = on) } }
        flip.setOnCheckedChangeListener { b, on -> if (b.isPressed) pushLook { it.copy(depthInvert = on) } }
        findViewById<MaterialButton>(R.id.testBtn).setOnClickListener { showTestPattern() }
        findViewById<MaterialButton>(R.id.changePcBtn).setOnClickListener { showPcForm = true; render() }
        bindSections()

        bindSleep()

        val auto = findViewById<MaterialSwitch>(R.id.autoStartSwitch)
        auto.isChecked = prefs.autoStart && Settings.canDrawOverlays(this)
        auto.setOnCheckedChangeListener { b, on ->
            if (!b.isPressed) return@setOnCheckedChangeListener
            prefs.autoStart = on
            if (on && !Settings.canDrawOverlays(this)) {
                // Android only lets an app open itself after a restart with "display over other apps"
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        }
    }

    // Settings live in sections that open like a menu; one is open at a time, and each
    // closed one shows a one-line summary of what it is set to.
    private data class Section(val header: View, val body: View, val chevron: View, val summary: TextView)
    private val sections = ArrayList<Section>()

    private fun bindSections() {
        for (key in listOf("Pc", "Look", "Sound", "Sleep", "Phone")) {
            fun id(n: String) = resources.getIdentifier("sec$key$n", "id", packageName)
            val sec = Section(findViewById(id("Header")), findViewById(id("Body")), findViewById(id("Chevron")), findViewById(id("Summary")))
            sections += sec
            sec.header.setOnClickListener {
                val open = sec.body.visibility != View.VISIBLE
                for (o in sections) setOpen(o, o === sec && open)
            }
        }
        // not linked yet: open the PC section so the first thing to do is right there
        if (prefs.pcBase.isEmpty()) setOpen(sections[0], true)
    }

    private fun setOpen(sec: Section, open: Boolean) {
        sec.body.visibility = if (open) View.VISIBLE else View.GONE
        sec.chevron.animate().rotation(if (open) 90f else 0f).setDuration(150).start()
    }

    private fun isLinked() = prefs.pcBase.isNotEmpty() && prefs.token.isNotEmpty()

    /** When a sleep ends: a manual "sleep now" lasts until the schedule changes, then the schedule decides. */
    private var wakeCache: Pair<Long, Long?>? = null      // (worked out at, wake time), refreshed every 30 s
    private fun wakeTime(): Long? {
        val now = System.currentTimeMillis()
        wakeCache?.let { (at, v) -> if (now - at < 30_000) return v }
        val s = prefs.sleep
        val c = java.util.Calendar.getInstance()
        var found: Long? = null
        for (i in 0 until 8 * 24 * 60) {
            c.add(java.util.Calendar.MINUTE, 1)
            if (!SleepSchedule.asleep(s, c.timeInMillis)) { found = c.timeInMillis; break }
        }
        wakeCache = now to found
        return found
    }

    private fun ago(t: Long): String {
        val m = (System.currentTimeMillis() - t) / 60_000
        return when { m < 1 -> "just now"; m < 60 -> "$m min ago"; else -> "${m / 60} h ago" }
    }

    private fun bindSleep() {
        val sw = findViewById<MaterialSwitch>(R.id.sleepSwitch)
        val from = findViewById<MaterialButton>(R.id.sleepFrom)
        val to = findViewById<MaterialButton>(R.id.sleepTo)
        val daysGroup = findViewById<ChipGroup>(R.id.sleepDays)
        val names = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
        fun win() = prefs.sleep.windows.first()
        fun save(w: SleepSchedule.Window, enabled: Boolean = prefs.sleep.enabled) {
            prefs.sleep = SleepSchedule.Settings(enabled, listOf(w)); render()
        }
        fun show() {
            val w = win()
            sw.isChecked = prefs.sleep.enabled
            from.text = "Sleep at " + SleepSchedule.hhmm(w.fromMin)
            to.text = "Wake at " + SleepSchedule.hhmm(w.toMin)
        }
        names.forEachIndexed { i, n ->
            val chip = Chip(this).apply {
                text = n; isCheckable = true; isChecked = i in win().days
                setOnCheckedChangeListener { _, on ->
                    val w = win(); val d = w.days.toMutableSet(); if (on) d.add(i) else d.remove(i)
                    save(w.copy(days = d))
                }
            }
            daysGroup.addView(chip)
        }
        show()
        sw.setOnCheckedChangeListener { b, on -> if (b.isPressed) save(win(), on) }
        from.setOnClickListener {
            val w = win()
            TimePickerDialog(this, { _, h, m -> save(w.copy(fromMin = h * 60 + m)); show() }, w.fromMin / 60, w.fromMin % 60, true).show()
        }
        to.setOnClickListener {
            val w = win()
            TimePickerDialog(this, { _, h, m -> save(w.copy(toMin = h * 60 + m)); show() }, w.toMin / 60, w.toMin % 60, true).show()
        }
    }

    // ------------------------------------------------------------------ video picker
    private lateinit var picker: View
    private lateinit var pickerCount: TextView
    private lateinit var pickerList: RecyclerView
    private val pickerAdapter = PickerAdapter()
    private val pickerBack = object : OnBackPressedCallback(false) { override fun handleOnBackPressed() = closePicker() }

    private fun bindPicker() {
        picker = findViewById(R.id.picker); pickerCount = findViewById(R.id.pickerCount); pickerList = findViewById(R.id.pickerList)
        val dm = resources.displayMetrics
        pickerList.layoutManager = GridLayoutManager(this, (dm.widthPixels / dm.density / 170).toInt().coerceAtLeast(2))
        pickerList.adapter = pickerAdapter
        findViewById<MaterialButton>(R.id.chooseBtn).setOnClickListener { openPicker() }
        findViewById<MaterialButton>(R.id.pickerClose).setOnClickListener { closePicker() }
        onBackPressedDispatcher.addCallback(this, pickerBack)
    }

    private fun openPicker() {
        if (items.isEmpty()) { note("No videos on this phone yet.", 8_000); return }
        thumbs.prune(items)
        refreshPicker()
        picker.visibility = View.VISIBLE; pickerBack.isEnabled = true
        val i = items.indexOfFirst { it.key == current?.key }
        if (i >= 0) pickerList.scrollToPosition(i)
    }

    private fun closePicker() { picker.visibility = View.GONE; pickerBack.isEnabled = false; root.requestFocus() }

    private fun refreshPicker() {
        pickerAdapter.list = items; pickerAdapter.playingKey = current?.key
        pickerAdapter.notifyDataSetChanged()
        pickerCount.text = "${items.size} video${if (items.size == 1) "" else "s"} on this phone. Tap one to play it on the Go."
    }

    private fun pick(it: LoopItem) {
        closePicker()
        errors.remove(it.key)
        if (presentation == null) {
            // no Go yet: this one plays first once it is plugged in
            current = null; prefs.currentKey = it.key
            note("Plug the Go in and \"${it.name}\" plays first.", 10_000); return
        }
        if (asleep) { wakeCache = null; SleepSchedule.wakeNow(prefs.sleep); asleep = SleepSchedule.asleep(prefs.sleep) }
        play(it); render()
    }

    private inner class PickerAdapter : RecyclerView.Adapter<PickerAdapter.Holder>() {
        var list: List<LoopItem> = emptyList()
        var playingKey: String? = null

        inner class Holder(v: View) : RecyclerView.ViewHolder(v) {
            val thumb: ImageView = v.findViewById(R.id.thumb)
            val name: TextView = v.findViewById(R.id.name)
            val length: TextView = v.findViewById(R.id.length)
            val resume: TextView = v.findViewById(R.id.resume)
            val tag: View = v.findViewById(R.id.playingTag)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = Holder(layoutInflater.inflate(R.layout.item_loop_video, parent, false))
        override fun getItemCount() = list.size

        override fun onBindViewHolder(h: Holder, pos: Int) {
            val it = list[pos]
            h.name.text = it.name
            h.length.text = if (it.still) "Still" else fmt((it.duration * 1000).toLong())
            h.tag.visibility = if (it.key == playingKey) View.VISIBLE else View.GONE
            val at = if (!it.still && it.duration >= 10 * 60) prefs.resumeAt(it.key) else 0L
            h.resume.text = if (at > 0) "Carries on from ${fmt(at)}" else ""
            h.resume.visibility = if (at > 0) View.VISIBLE else View.GONE
            h.thumb.setImageBitmap(thumbs.get(it) { val i = list.indexOfFirst { x -> x.key == it.key }; if (i >= 0) notifyItemChanged(i) })
            h.itemView.setOnClickListener { _ -> pick(it) }
        }
    }

    private fun showTestPattern() {
        val p = presentation ?: run { note("Plug the Go in first.", 8_000); return }
        val f = File(cacheDir, "viewnum_qs11x6a0.667.png")
        if (!f.exists()) assets.open("test/viewnum_qs11x6a0.667.png").use { i -> f.outputStream().use { i.copyTo(it) } }
        stillRunnable?.let { main.removeCallbacks(it) }
        current = null; playing = true
        p.updateItem(HologramItem(Uri.fromFile(f), "view-number test", HologramKind.QUILT_IMAGE, cols = 11, rows = 6, viewAspect = 0.667f))
        stillRunnable = Runnable { playNext() }.also { main.postDelayed(it, 60_000) }
        note("Test pattern for a minute. Each eye should see one clean number; moving sideways should count up or down by one.")
    }

    private fun fmt(ms: Long): String {
        if (ms <= 0) return "0:00"
        val s = ms / 1000; val h = s / 3600; val m = (s / 60) % 60; val x = s % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, x) else "%d:%02d".format(m, x)
    }

    private fun render() {
        val go = presentation != null
        val s = prefs.sleep
        val cal = calibration
        chips.text = listOf(
            if (go) "Go connected" else "Go not plugged in",
            if (cal != null) "calibration ${cal.serial.ifBlank { "saved" }}" else if (isLinked()) "no calibration yet (plug the Go into the PC once)" else "no calibration yet (link the PC)",
            "${items.size} ready",
        ).joinToString("  ·  ")
        nowLabel.text = when {
            asleep -> "Asleep"
            !go -> "Waiting for the Go"
            items.isEmpty() -> "Nothing to play yet"
            paused -> "Paused"
            playing -> "Playing on the Go"
            else -> "Starting..."
        }
        val linked = isLinked()
        val err = syncErr
        nowTitle.text = if (asleep) "Sleeping until " + (wakeTime()?.let { java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(it)) } ?: "you wake it")
            else current?.name ?: when {
                items.isNotEmpty() -> ""
                !linked -> "Link your PC below to get videos"
                syncing -> "Getting videos from the PC..."
                err != null -> if (syncErrCode == 401) "The PC wants its PIN again" else "Can't reach the PC right now"
                syncOkAt > 0 -> "No 3D videos on the PC yet"
                else -> "Can't reach the PC right now"
            }
        nowTimes.text = if (current?.still == true || asleep) "" else "${fmt(posMs)} / ${fmt(durMs)}"
        nowProgress.progress = if (durMs > 0) (posMs * 1000 / durMs).toInt() else 0
        playBtn.text = getString(if (paused || !playing) R.string.loop_play else R.string.loop_pause)
        findViewById<MaterialButton>(R.id.shuffleBtn).text = getString(if (prefs.shuffle) R.string.loop_shuffle_on else R.string.loop_shuffle_off)
        sleepBtn.text = getString(if (asleep) R.string.loop_wake_now else R.string.loop_sleep_now)
        val now = System.currentTimeMillis()
        syncStatus.text = if (now < noteUntil) note else syncText
        pcStatus.text = when {
            now < pcNoteUntil -> pcNote
            !linked -> "Not linked yet. Open HoloLoop on the PC, then press Find my PC."
            syncing -> "Linked to ${prefs.pcBase}. Checking for videos..."
            err != null && syncErrCode == 401 -> "${prefs.pcBase} wants its PIN again. Type it below and press Connect."
            err != null -> "Can't reach ${prefs.pcBase} right now" + (if (syncOkAt > 0) " (last good check ${ago(syncOkAt)})." else ".")
            syncOkAt > 0 -> "Linked to ${prefs.pcBase}. Last good check ${ago(syncOkAt)}."
            else -> "Linked to ${prefs.pcBase}."
        }
        findViewById<View>(R.id.pcForm).visibility = if (!linked || showPcForm) View.VISIBLE else View.GONE
        findViewById<View>(R.id.changePcBtn).visibility = if (linked && !showPcForm) View.VISIBLE else View.GONE
        findViewById<TextView>(R.id.sleepStatus).text = when {
            asleep && !SleepSchedule.scheduledAsleep(s) -> "Asleep now (you pressed Sleep now)."
            asleep -> "Asleep now (scheduled)."
            !s.enabled -> "Off: plays all day and night."
            SleepSchedule.scheduledAsleep(s) -> "Awake now (you pressed Wake up)."
            else -> "Awake now."
        }
        renderSummaries(linked)
        if (::picker.isInitialized && picker.visibility == View.VISIBLE &&
            (pickerAdapter.list !== items || pickerAdapter.playingKey != current?.key)) refreshPicker()
    }

    private fun renderSummaries(linked: Boolean) {
        if (sections.size < 5) return
        val l = prefs.look
        val edge = com.alienware377.hololoop.model.Look.EDGE_MODES.getOrElse(l.edgeFix) { "" }
        val err = syncErr
        sections[0].summary.text = when {
            !linked -> "Not linked yet"
            syncing -> "Linked, getting videos"
            err != null && syncErrCode == 401 -> "PIN needed again"
            err != null -> "Can't reach the PC right now"
            syncOkAt > 0 -> "Linked, ${items.size} video${if (items.size == 1) "" else "s"}, last check ${ago(syncOkAt)}"
            else -> "Linked to ${prefs.pcBase}"
        }
        sections[1].summary.text = (if (prefs.useLocalLook) "This phone's settings, 3D ${(l.depthiness / 0.8f * 100).toInt()}%" else "The PC's settings") +
            ", edges: ${edge.lowercase()}"
        sections[2].summary.text = if (prefs.muted) "Off" else "On, ${(prefs.volume * 100).toInt()}%"
        val s = prefs.sleep
        val w = s.windows.firstOrNull()
        sections[3].summary.text = if (asleep && (!s.enabled || w == null)) "Asleep now (you pressed Sleep now)" else
            if (!s.enabled || w == null) "Off, plays all day and night" else
            "Black from ${SleepSchedule.hhmm(w.fromMin)} to ${SleepSchedule.hhmm(w.toMin)}" +
                (if (w.days.size == 7) ", every day" else ", ${w.days.size} days a week") +
                (if (asleep) ", asleep now" else "")
        sections[4].summary.text = "Starts with the phone: " + (if (prefs.autoStart && Settings.canDrawOverlays(this)) "on" else "off")
    }

    companion object { private const val TAG = "HoloLoop"; private const val HOLD_MS = 500L
        private const val DOUBLE_PRESS_MS = 350L; private const val MENU_TIMEOUT_MS = 30_000L }
}
