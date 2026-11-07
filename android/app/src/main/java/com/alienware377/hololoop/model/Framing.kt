package com.alienware377.hololoop.model

import org.json.JSONObject
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * How a video fits the tall Go screen, worked out on the PC shot by shot: crop to
 * the subject and pan along, zoom halfway, show everything, or turn the picture a
 * quarter turn so people stay upright. "turnfit" shows everything and turns a wide
 * picture to stand tall, without looking at people. Same maths as framemap.js on the PC.
 *
 * keys: (time s, centre, width, cut) in content-width units.
 * rot : (time s, turn deg 0/90/-90, centre across the turned view, cut).
 * content: the picture without burned-in black bars, (x0, y0, x1, y1), y from the top.
 */
class Framing(
    val content: FloatArray, val minW: Float, val rotMinW: Float,
    private val t: FloatArray, private val c: FloatArray, private val w: FloatArray, private val cut: BooleanArray,
    private val rt: FloatArray, private val rr: IntArray, private val rc: FloatArray, private val rcut: BooleanArray,
) {
    private class State(var phi: Float, var cx: Float, var cy: Float, var W: Float, var H: Float)

    private fun keyAt(times: FloatArray, sec: Float): Int {
        var lo = 0
        var hi = times.size - 1
        while (lo < hi) { val m = (lo + hi + 1) ushr 1; if (times[m] <= sec) lo = m else hi = m - 1 }
        return lo
    }

    private fun flat(mode: String, sec: Float, Cw: Float, Ch: Float): State {
        var cc = 0.5f
        var ww = 1f
        if (mode == "fill") ww = minW
        else if (mode != "fit" && t.isNotEmpty()) {
            val lo = keyAt(t, sec)
            val b = lo + 1
            if (b >= t.size || cut[b] || sec <= t[lo]) { cc = c[lo]; ww = w[lo] }
            else {
                val f = ((sec - t[lo]) / max(1e-6f, t[b] - t[lo])).coerceIn(0f, 1f)
                cc = c[lo] + (c[b] - c[lo]) * f
                ww = w[lo] + (w[b] - w[lo]) * f
            }
        }
        return State(0f, (cc - 0.5f) * Cw, 0f, ww * Cw, Ch)
    }

    private fun turned(r: Int, centre: Float, Cw: Float, Ch: Float): State {
        val ww = min(1f, rotMinW)
        val cc = centre.coerceIn(ww / 2f, 1f - ww / 2f)
        return State(r.toFloat(), 0f, (if (r == 90) 1f else -1f) * (cc - 0.5f) * Ch, ww * Ch, Cw)
    }

    /** "turnfit": the whole picture, a wide one turned a quarter turn clockwise to stand tall */
    private fun turnFit(Cw: Float, Ch: Float) = if (Cw > Ch) State(90f, 0f, 0f, Ch, Cw) else State(0f, 0f, 0f, Cw, Ch)

    /**
     * Fills [out] with (mapU xyz, mapV xyz, aspect, U0, V0, U1, V1): the shown picture q
     * (0..1, y up) -> colour uv (v up) as u = dot(mapU,(q,1)), v = dot(mapV,(q,1)).
     * colorW/colorH only need the right ratio.
     */
    fun mapAt(sec: Float, mode: String, colorW: Float, colorH: Float, out: FloatArray) {
        val U0 = content[0]; val U1 = content[2]; val V0 = 1f - content[3]; val V1 = 1f - content[1]
        val Cw = (U1 - U0) * colorW; val Ch = (V1 - V0) * colorH
        var S: State
        if (mode == "turnfit") S = turnFit(Cw, Ch)
        else if (mode != "rotate" || rt.isEmpty()) S = flat(mode, sec, Cw, Ch)
        else {
            val k = keyAt(rt, sec)
            val r = rr[k]
            var cc = rc[k]
            if (r != 0 && k + 1 < rt.size && rr[k + 1] == r && !rcut[k + 1])
                cc += (rc[k + 1] - cc) * ((sec - rt[k]) / max(1e-6f, rt[k + 1] - rt[k])).coerceIn(0f, 1f)
            val cur = if (r == 0) flat("auto", sec, Cw, Ch) else turned(r, cc, Cw, Ch)
            S = cur
            if (k > 0 && rr[k - 1] != r && !rcut[k] && sec - rt[k] < TURN_SEC) {       // turning inside a shot
                val prev = if (rr[k - 1] == 0) flat("auto", sec, Cw, Ch) else turned(rr[k - 1], rc[k - 1], Cw, Ch)
                var f = max(0f, (sec - rt[k]) / TURN_SEC); f = f * f * (3 - 2 * f)
                S = State(prev.phi + (cur.phi - prev.phi) * f, prev.cx + (cur.cx - prev.cx) * f, prev.cy + (cur.cy - prev.cy) * f,
                    prev.W + (cur.W - prev.W) * f, prev.H + (cur.H - prev.H) * f)
            }
        }
        val a = Math.toRadians(S.phi.toDouble())
        val cs = cos(a).toFloat(); val sn = sin(a).toFloat()
        val l00 = cs * S.W; val l01 = -sn * S.H; val l10 = sn * S.W; val l11 = cs * S.H
        val uc = (U0 + U1) / 2f; val vc = (V0 + V1) / 2f
        out[0] = l00 / colorW; out[1] = l01 / colorW; out[2] = uc + (S.cx - 0.5f * l00 - 0.5f * l01) / colorW
        out[3] = l10 / colorH; out[4] = l11 / colorH; out[5] = vc + (S.cy - 0.5f * l10 - 0.5f * l11) / colorH
        out[6] = S.W / S.H
        out[7] = U0; out[8] = V0; out[9] = U1; out[10] = V1
    }

    companion object {
        const val TURN_SEC = 0.6f

        /** turnfit without any framing from the PC: the whole colour picture */
        fun turnFitWhole(aspect: Float, out: FloatArray) =
            Framing(floatArrayOf(0f, 0f, 1f, 1f), 1f, 1f, FloatArray(0), FloatArray(0), FloatArray(0), BooleanArray(0),
                FloatArray(0), IntArray(0), FloatArray(0), BooleanArray(0)).mapAt(0f, "turnfit", aspect * 1000f, 1000f, out)

        /** identity map (no framing) for a picture of the given aspect */
        fun identity(aspect: Float, out: FloatArray) {
            out[0] = 1f; out[1] = 0f; out[2] = 0f; out[3] = 0f; out[4] = 1f; out[5] = 0f
            out[6] = aspect; out[7] = 0f; out[8] = 0f; out[9] = 1f; out[10] = 1f
        }

        fun parse(json: String?): Framing? {
            if (json.isNullOrBlank()) return null
            return runCatching {
                val o = JSONObject(json)
                val ca = o.getJSONArray("content")
                val keys = o.optJSONArray("keys")
                val n = keys?.length() ?: 0
                val t = FloatArray(n); val c = FloatArray(n); val w = FloatArray(n); val cut = BooleanArray(n)
                for (i in 0 until n) {
                    val k = keys!!.getJSONArray(i)
                    t[i] = k.getDouble(0).toFloat(); c[i] = k.getDouble(1).toFloat(); w[i] = k.getDouble(2).toFloat()
                    cut[i] = k.optInt(3, 0) == 1
                }
                val rot = o.optJSONArray("rot")
                val m = rot?.length() ?: 0
                val rt = FloatArray(m); val rr = IntArray(m); val rc = FloatArray(m); val rcut = BooleanArray(m)
                for (i in 0 until m) {
                    val k = rot!!.getJSONArray(i)
                    rt[i] = k.getDouble(0).toFloat(); rr[i] = k.getInt(1); rc[i] = k.getDouble(2).toFloat(); rcut[i] = k.optInt(3, 0) == 1
                }
                Framing(FloatArray(4) { ca.getDouble(it).toFloat() }, o.optDouble("minW", 1.0).toFloat(), o.optDouble("rotMinW", 1.0).toFloat(),
                    t, c, w, cut, rt, rr, rc, rcut)
            }.getOrNull()
        }
    }
}
