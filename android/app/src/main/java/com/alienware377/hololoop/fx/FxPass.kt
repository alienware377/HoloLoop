package com.alienware377.hololoop.fx

import android.graphics.Color
import android.opengl.GLES30
import android.os.SystemClock
import android.util.Log
import com.alienware377.hololoop.gl.GlUtil

/**
 * Runs the video filters over a colour + depth texture into a texture of its own (GL thread).
 * One program per set of active filters, so unused filters cost nothing.
 */
class FxPass {
    private val programs = object : LinkedHashMap<String, Int>(8, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Int>?): Boolean {
            if (size > 6 && e != null) { if (e.value > 0) GLES30.glDeleteProgram(e.value); return true }
            return false
        }
    }
    private var quadVbo = 0
    private var fbo = 0
    private var outTex = 0
    private var outW = 0
    private var outH = 0
    private var seed = 0f

    private fun program(active: Set<String>): Int {
        val key = active.sorted().joinToString(",")
        programs[key]?.let { return it }
        val p = runCatching { GlUtil.link(FxShader.VERT, FxShader.frag(active)) }
            .onFailure { Log.w("HoloLoop", "filter shader failed for $key", it) }.getOrDefault(0)
        programs[key] = p
        return p
    }

    private fun ensureTarget(w: Int, h: Int) {
        if (outTex != 0 && w == outW && h == outH) return
        val ids = IntArray(1)
        if (outTex == 0) { GLES30.glGenTextures(1, ids, 0); outTex = ids[0]; GLES30.glGenFramebuffers(1, ids, 0); fbo = ids[0] }
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, outTex)
        GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA, w, h, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
        GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, outTex, 0)
        outW = w; outH = h
    }

    /**
     * Filters [src] (size [w] x [h], depth at [depthLoc]: 0 top, 1 bottom, 2 right, 3 left) and
     * returns the texture to draw from: the filtered one, or [src] when nothing is on.
     */
    fun apply(src: Int, w: Int, h: Int, depthLoc: Int, st: FxState): Int {
        val active = st.active
        if (active.isEmpty() || w <= 0 || h <= 0) return src
        val prog = program(active)
        if (prog == 0) return src
        if (quadVbo == 0) quadVbo = GlUtil.fullscreenQuadVbo()
        ensureTarget(w, h)

        // colour and depth halves in texture uv, v up (the same split as rgbd_lenticular.frag)
        val c: FloatArray; val d: FloatArray
        when (depthLoc) {
            0 -> { c = floatArrayOf(0f, 0f, 1f, 0.5f); d = floatArrayOf(0f, 0.5f, 1f, 1f) }
            1 -> { c = floatArrayOf(0f, 0.5f, 1f, 1f); d = floatArrayOf(0f, 0f, 1f, 0.5f) }
            2 -> { c = floatArrayOf(0f, 0f, 0.5f, 1f); d = floatArrayOf(0.5f, 0f, 1f, 1f) }
            else -> { c = floatArrayOf(0.5f, 0f, 1f, 1f); d = floatArrayOf(0f, 0f, 0.5f, 1f) }
        }
        val cw = if (depthLoc >= 2) w / 2f else w.toFloat()
        val ch = if (depthLoc >= 2) h.toFloat() else h / 2f

        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo)
        GLES30.glViewport(0, 0, w, h)
        GLES30.glUseProgram(prog)
        fun loc(n: String) = GLES30.glGetUniformLocation(prog, n)
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, src)
        GLES30.glUniform1i(loc("uTex"), 0)
        GLES30.glUniform2f(loc("uOut"), w.toFloat(), h.toFloat())
        GLES30.glUniform4f(loc("uC"), c[0], c[1], c[2], c[3])
        GLES30.glUniform4f(loc("uD"), d[0], d[1], d[2], d[3])
        GLES30.glUniform2f(loc("uHalf"), 0.5f / cw, 0.5f / ch)
        GLES30.glUniform2f(loc("uSize"), cw, ch)
        GLES30.glUniform1f(loc("uBlur"), (ch * 0.012f).coerceIn(4f, 40f))
        if (st.animated) seed = (seed + 1.37f) % 997f
        GLES30.glUniform1f(loc("uSeed"), seed)
        GLES30.glUniform1f(loc("uTime"), (SystemClock.uptimeMillis() % 3_600_000L) / 1000f)
        GLES30.glUniform1f(loc("uGrainSize"), st["grain_size"] * (ch / 1080f).coerceAtLeast(0.5f))
        GLES30.glUniform1f(loc("uGrainColor"), st["grain_color"].toFloat())
        GLES30.glUniform1f(loc("uVigSize"), 0.1f + st["vignette_size"] / 100f * 0.7f)
        GLES30.glUniform1f(loc("uBokehMode"), st["bokeh_mode"].toFloat())
        GLES30.glUniform1f(loc("uBokehDensity"), 0.15f + st["bokeh_density"] / 100f * 0.75f)
        val mono = FxDefs.MONO_COLORS[st["mono_color"]].color
        GLES30.glUniform3f(loc("uMono"), Color.red(mono) / 255f, Color.green(mono) / 255f, Color.blue(mono) / 255f)
        val grad = FxDefs.GRADIENTS[st["gmap_preset"]].colors
        val ga = FloatArray(18)
        for (i in 0 until 6) {
            val g = grad[i.coerceAtMost(grad.size - 1)]
            ga[i * 3] = Color.red(g) / 255f; ga[i * 3 + 1] = Color.green(g) / 255f; ga[i * 3 + 2] = Color.blue(g) / 255f
        }
        GLES30.glUniform3fv(loc("uGrad"), 6, ga, 0)
        GLES30.glUniform1i(loc("uGradN"), grad.size.coerceIn(2, 6))
        for (f in FxDefs.FILTERS) {
            if (f.key !in active) continue
            val a = st.amount(f) / 100f
            val (y, z) = when {
                f.group == FxDefs.Group.GLITCH -> st["${f.key}_speed"] / 100f to 0f
                f.key == "bokeh" -> st["bokeh_speed"] / 100f to st["bokeh_size"] / 100f
                f.ranged -> st["${f.key}_lo"] / 100f to st["${f.key}_hi"] / 100f
                else -> 0f to 1f
            }
            GLES30.glUniform3f(loc("f_" + f.key), a, y, z)
        }
        GlUtil.bindQuadAttrib(prog, quadVbo)
        GLES30.glDrawArrays(GLES30.GL_TRIANGLE_STRIP, 0, 4)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
        return outTex
    }

    /** GL thread. */
    fun release() {
        for (p in programs.values) if (p > 0) GLES30.glDeleteProgram(p)
        programs.clear()
        if (outTex != 0) { GLES30.glDeleteTextures(1, intArrayOf(outTex), 0); GLES30.glDeleteFramebuffers(1, intArrayOf(fbo), 0) }
        outTex = 0; fbo = 0; outW = 0; outH = 0
    }
}
