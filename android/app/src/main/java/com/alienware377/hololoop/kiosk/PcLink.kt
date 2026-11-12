package com.alienware377.hololoop.kiosk

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Videos the PC stops listing stay on the phone this long before they are deleted. */
private const val PRUNE_AFTER_MS = 3L * 24 * 3600 * 1000

private const val FAT32_FULL = "%s is over 4 GB, which a FAT32 flash drive can't hold. Format the drive as exFAT."

/** One finished 3D video (or still) as the PC lists it. */
data class LoopItem(
    val id: String, val key: String, val name: String, val kind: String, val still: Boolean,
    val cols: Int, val rows: Int, val aspect: Float, val depthLoc: Int,
    val width: Int, val height: Int, val file: String, val size: Long, val duration: Double,
    val frame: String = "auto", val framingJson: String? = null,
    /** The PC is making a smaller copy of this one: keep the big file if we have it, but don't fetch it. */
    val waitCopy: Boolean = false,
) {
    fun toJson() = JSONObject().apply {
        put("id", id); put("key", key); put("name", name); put("kind", kind); put("still", still)
        put("cols", cols); put("rows", rows); put("aspect", aspect.toDouble()); put("depthLoc", depthLoc)
        put("width", width); put("height", height); put("file", file); put("size", size); put("duration", duration)
        put("frame", frame); if (framingJson != null) put("framing", JSONObject(framingJson))
        put("waitCopy", waitCopy)
    }

    companion object {
        fun from(o: JSONObject) = LoopItem(
            id = o.getString("id"), key = o.optString("key", o.getString("id")), name = o.optString("name", "video"),
            kind = o.optString("kind", "rgbd"), still = o.optBoolean("still", false),
            cols = o.optInt("cols", 0), rows = o.optInt("rows", 0), aspect = o.optDouble("aspect", 0.0).toFloat(),
            depthLoc = o.optInt("depthLoc", 2), width = o.optInt("width", 0), height = o.optInt("height", 0),
            file = o.optString("file", o.getString("id") + ".mp4"), size = o.optLong("size", 0), duration = o.optDouble("duration", 0.0),
            frame = o.optString("frame", "auto"), framingJson = o.optJSONObject("framing")?.toString(),
            waitCopy = o.optBoolean("waitCopy", false),
        )

        fun listFrom(s: String): List<LoopItem> = runCatching {
            val a = JSONArray(s); (0 until a.length()).map { from(a.getJSONObject(it)) }
        }.getOrDefault(emptyList())

        fun listJson(items: List<LoopItem>) = JSONArray().apply { items.forEach { put(it.toJson()) } }.toString()
    }
}

/** Talks to HoloLoop on the PC: find it, log in with the PIN, fetch new 3D files. */
class PcLink(private val context: Context, private val prefs: LoopPrefs) {

    /** The phone's own video folder. */
    val phoneDir: File = File(context.getExternalFilesDir(null), "hololoop").apply { mkdirs() }

    /** The HoloLoop folder on the picked flash drive, or null when the videos live on the phone. */
    fun driveDir(): File? = prefs.storageRoot.takeIf { it.isNotEmpty() }?.let { File(it, "HoloLoop") }

    private fun usable(d: File) = (d.isDirectory || d.mkdirs()) && d.canWrite()

    /** A drive is picked but can't be used right now (unplugged, or all-files access was taken away). */
    fun driveMissing() = driveDir()?.let { !usable(it) } ?: false

    /** Where new downloads go; null while the picked drive is missing, so the phone doesn't fill up instead. */
    fun downloadDir(): File? {
        val d = driveDir() ?: return phoneDir
        return if (usable(d)) d else null
    }

    /** Every folder that may hold videos: the drive first, then the phone (videos kept from before the switch). */
    fun dirs(): List<File> = listOfNotNull(driveDir()?.takeIf { usable(it) }, phoneDir)

    /** The finished file wherever it is, else the place it would be downloaded to. */
    fun localFile(it: LoopItem): File {
        val name = safe(it.key) + "_" + safe(it.file)
        for (d in dirs()) File(d, name).let { f -> if (f.exists() && (it.size <= 0 || f.length() == it.size)) return f }
        return File(downloadDir() ?: phoneDir, name)
    }
    /** Downloaded completely: there and the size the PC says (a kept old file of the same name is not ready). */
    fun isReady(it: LoopItem) = localFile(it).let { f -> f.exists() && (it.size <= 0 || f.length() == it.size) }
    private fun safe(s: String) = s.replace(Regex("[^A-Za-z0-9._-]"), "_").take(90)

    class HttpError(val code: Int, msg: String) : Exception(msg)
    /** No room, no drive, or a drive that can't hold the file; the message is for people. */
    class StorageError(msg: String) : Exception(msg)

    /**
     * The file system of the drive a path is on. /storage/<id> itself is a FUSE layer, so look for
     * the real mount of the same volume id (e.g. /mnt/media_rw/<id>) first.
     */
    private fun fsType(f: File): String? = runCatching {
        val mounts = File("/proc/self/mounts").readLines().map { it.split(' ') }.filter { it.size > 2 }
        val id = f.path.removePrefix("/storage/").substringBefore('/')
        mounts.firstOrNull { it[1].endsWith("/$id") && it[2] != "fuse" }?.get(2)
            ?: mounts.filter { f.path.startsWith(it[1]) }.maxByOrNull { it[1].length }?.get(2)
    }.getOrNull()

    private fun fat32(f: File) = fsType(f)?.let { it == "vfat" || it == "msdos" || it == "fat" } == true

    /**
     * The home Wi-Fi (or a wired hub's Ethernet) with its IPv4 address. We pin
     * every request to it, because a VPN on the phone would otherwise grab the
     * traffic and the PC (a local address) would look unreachable.
     */
    private fun lan(): Pair<Network, Inet4Address>? {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        @Suppress("DEPRECATION")
        for (n in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) continue
            val addr = cm.getLinkProperties(n)?.linkAddresses?.map { it.address }?.filterIsInstance<Inet4Address>()
                ?.firstOrNull { it.isSiteLocalAddress } ?: continue
            return n to addr
        }
        return null
    }

    private fun open(path: String, method: String = "GET", body: String? = null, base: String = prefs.pcBase, timeoutMs: Int = 8000): HttpURLConnection {
        val url = URL((if (base.startsWith("http")) base else "http://$base") + path)
        val net = if (bindRefused) null else lan()?.first
        val c = (net?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
        c.connectTimeout = timeoutMs; c.readTimeout = 30000; c.requestMethod = method
        if (prefs.token.isNotEmpty() && base == prefs.pcBase) c.setRequestProperty("X-HoloLoop-Token", prefs.token)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return c
    }

    // An always-on VPN can forbid binding to the Wi-Fi (EPERM); then we just use
    // the normal route, which works when the VPN lets local traffic through.
    @Volatile private var bindRefused = false

    private fun <T> withBindFallback(block: () -> T): T = try { block() } catch (e: java.net.SocketException) {
        if (e.message?.contains("EPERM") == true) { bindRefused = true; block() } else throw e
    }

    private fun readJson(c: HttpURLConnection): JSONObject {
        val code = c.responseCode
        val text = (if (code in 200..299) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        c.disconnect()
        if (code !in 200..299) throw HttpError(code, runCatching { JSONObject(text).optString("error") }.getOrNull()?.ifBlank { null } ?: "HTTP $code")
        return JSONObject(text)
    }

    /** Ask every address on this Wi-Fi (same /24) whether it is HoloLoop. */
    fun discover(port: Int = 8787): List<Pair<String, String>> {
        val me = lan()?.second ?: run { android.util.Log.w("HoloLoop", "discover: no Wi-Fi/Ethernet IPv4 network"); return emptyList() }
        val b = me.address
        val prefix = "${b[0].toInt() and 255}.${b[1].toInt() and 255}.${b[2].toInt() and 255}."
        android.util.Log.i("HoloLoop", "discover: scanning $prefix* from ${me.hostAddress}")
        val errs = java.util.concurrent.atomic.AtomicInteger()
        val pool = Executors.newFixedThreadPool(48)
        val found = java.util.Collections.synchronizedList(mutableListOf<Pair<String, String>>())
        for (i in 1..254) pool.execute {
            val base = "$prefix$i:$port"
            runCatching {
                val o = withBindFallback { readJson(open("/api/hello", base = base, timeoutMs = 700)) }
                if (o.optString("app") == "hololoop") found.add(base to o.optString("name", base))
            }.onFailure { e ->
                if (e !is java.net.SocketTimeoutException && e !is java.net.ConnectException && errs.incrementAndGet() <= 3)
                    android.util.Log.w("HoloLoop", "discover $base: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        pool.shutdown(); pool.awaitTermination(12, TimeUnit.SECONDS)
        return found.toList()
    }

    /** Remembers the PC only once it accepted the PIN; a failed try keeps the old link. */
    fun login(base: String, pin: String) {
        val o = withBindFallback { readJson(open("/api/login", "POST", JSONObject().put("pin", pin).toString(), base = base)) }
        val token = o.optString("token")
        if (token.isEmpty()) throw HttpError(0, "the PC sent no key back")
        prefs.pcBase = base; prefs.token = token
    }

    class SyncList(val items: List<LoopItem>, val look: JSONObject?, val calibration: JSONObject?)

    fun fetchList(): SyncList {
        val o = withBindFallback { readJson(open("/api/sync")) }
        val arr = o.optJSONArray("items") ?: JSONArray()
        return SyncList((0 until arr.length()).map { LoopItem.from(arr.getJSONObject(it)) }, o.optJSONObject("look"), o.optJSONObject("calibration"))
    }

    /** Download (or finish downloading) one file. Resumes from a .part file. */
    fun download(it: LoopItem, onProgress: (Long, Long) -> Unit, cancelled: () -> Boolean): File {
        localFile(it).let { f -> if (f.exists() && f.length() == it.size) return f }
        val target = downloadDir() ?: throw StorageError("The flash drive isn't plugged in. Plug it back in, or pick This phone under Video storage.")
        val out = File(target, localFile(it).name)
        val part = File(out.path + ".part")
        // which file the .part holds: a half-fetched big original must not be finished with its small copy's bytes
        val partFor = File(part.path + ".for")
        val want = "${it.file}|${it.size}"
        if (part.exists() && runCatching { partFor.readText() }.getOrNull() != want) part.delete()
        partFor.writeText(want)
        var have = if (part.exists()) part.length() else 0L
        if (have > it.size) { part.delete(); have = 0 }
        if (target != phoneDir && it.size >= (4L shl 30) && fat32(target)) throw StorageError(FAT32_FULL.format(it.name))
        if (target.usableSpace < it.size - have + (256L shl 20))
            throw StorageError("Not enough room for ${it.name} on the ${if (target == phoneDir) "phone" else "flash drive"} " +
                "(${(it.size - have) shr 20} MB needed, ${target.usableSpace shr 20} MB free).")
        if (have == it.size && have > 0) {           // finished last time, only the rename was missing
            if (out.exists()) out.delete()
            if (part.renameTo(out)) { partFor.delete(); onProgress(have, it.size); return out }
        }
        val c = withBindFallback {
            open("/files/${it.id}?file=" + java.net.URLEncoder.encode(it.file, "UTF-8")).also { cc ->
                cc.readTimeout = 60000
                if (have > 0) cc.setRequestProperty("Range", "bytes=$have-")
                cc.responseCode
            }
        }
        val code = c.responseCode
        if (code == 416) { c.disconnect(); part.delete(); throw HttpError(code, "download restarts from the beginning") }
        if (code == 200) have = 0 else if (code != 206) { c.disconnect(); throw HttpError(code, "download failed (HTTP $code)") }
        RandomAccessFile(part, "rw").use { raf ->
            raf.setLength(have); raf.seek(have)
            c.inputStream.use { input ->
                val buf = ByteArray(1 shl 16)
                var last = 0L
                while (true) {
                    if (cancelled()) throw InterruptedException("cancelled")
                    val n = input.read(buf); if (n < 0) break
                    try { raf.write(buf, 0, n) } catch (e: java.io.IOException) {
                        if (target != phoneDir && have + n >= (4L shl 30) - 1) throw StorageError(FAT32_FULL.format(it.name))
                        throw e
                    }
                    have += n
                    val now = System.currentTimeMillis()
                    if (now - last > 500) { last = now; onProgress(have, it.size) }
                }
            }
        }
        c.disconnect()
        if (have != it.size) throw HttpError(0, "download stopped early (${have}/${it.size})")
        if (out.exists()) out.delete()
        if (!part.renameTo(out)) throw HttpError(0, "could not save ${out.name}")
        partFor.delete()
        onProgress(have, it.size)
        return out
    }

    /**
     * When the PC swaps a video for another file (its smaller phone copy), the old file goes at
     * once: the phone is often full, and the new one needs the room. A half-fetched big file the
     * PC now says not to fetch (a copy is coming) goes too.
     */
    fun dropReplaced(items: List<LoopItem>): Long = dirs().sumOf { dropReplaced(it, items) }

    private fun dropReplaced(dir: File, items: List<LoopItem>): Long {
        var freed = 0L
        val files = dir.listFiles() ?: return 0
        for (it in items) {
            val mine = safe(it.key) + "_" + safe(it.file)
            val prefix = safe(it.key) + "_"
            for (f in files) {
                val n = f.name
                if (!n.startsWith(prefix)) continue
                // long names are cut short, so a copy can land on the very name of the file it replaces:
                // then the size tells them apart
                val stale = (n != mine && n != "$mine.part" && n != "$mine.part.for") || (it.waitCopy && n == "$mine.part") ||
                    (n == mine && !it.waitCopy && it.size > 0 && f.length() != it.size)
                if (stale) { freed += f.length(); if (f.delete()) android.util.Log.i("HoloLoop", "dropped ${f.name} (replaced by a smaller copy)") }
            }
        }
        return freed
    }

    /**
     * Delete videos the PC no longer lists, but only once they have been missing for
     * [PRUNE_AFTER_MS]. A PC hiccup (say its settings were lost in a crash and it lists one
     * video for a while) must not make the phone throw away gigabytes it would then
     * download again. Unfinished downloads of dropped videos go at once.
     */
    fun prune(keep: List<LoopItem>) = dirs().forEach { prune(it, keep) }

    private fun prune(dir: File, keep: List<LoopItem>) {
        val names = keep.map { safe(it.key) + "_" + safe(it.file) }.toSet()
        val book = File(dir, ".dropped.json")
        val since = runCatching { org.json.JSONObject(book.readText()) }.getOrDefault(org.json.JSONObject())
        val now = System.currentTimeMillis()
        val next = org.json.JSONObject()
        dir.listFiles()?.forEach { f ->
            if (f.name.startsWith(".")) return@forEach
            if (f.name.removeSuffix(".for").removeSuffix(".part") in names) return@forEach
            val t = since.optLong(f.name, now).coerceAtMost(now)
            if (now - t > PRUNE_AFTER_MS) f.delete() else next.put(f.name, t)
        }
        runCatching { book.writeText(next.toString()) }
    }
}
