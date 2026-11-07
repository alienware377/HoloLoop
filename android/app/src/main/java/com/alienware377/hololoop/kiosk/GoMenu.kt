package com.alienware377.hololoop.kiosk

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import com.alienware377.hololoop.fx.FxDefs
import com.alienware377.hololoop.fx.FxState

/**
 * The filter menu on the Go itself, run from its three buttons like a monitor's menu:
 * back and next move (or change a value while one is picked), a press on play picks;
 * every page ends in a Back row. It is drawn flat on the glass, so it reads the same from
 * every angle; that also makes it soft, hence the big type.
 */
class GoMenu(context: Context, private val host: Host) : View(context) {

    interface Host {
        val fx: FxState
        fun setFx(s: FxState)
        /** Some input reached the menu (to restart its close timer). */
        fun touched()
        fun closed()
    }

    private abstract inner class Row {
        abstract val label: String
        open fun value(): String? = null
        /** Picking it opens another page. */
        open val opens = false
        /** A value you change with back and next once it is picked. */
        open val field: FxDefs.Field? = null
        open val help: String? = null
        open fun pick() {}
    }

    private inner class ActionRow(override val label: String, val v: () -> String? = { null }, val act: () -> Unit) : Row() {
        override fun value() = v()
        override fun pick() = act()
    }

    private inner class PageRow(override val label: String, val v: () -> String?, override val help: String?, val page: () -> Page) : Row() {
        override val opens = true
        override fun value() = v()
        override fun pick() { stack += Spot(page()); editing = false }
    }

    private inner class FieldRow(override val field: FxDefs.Field, override val label: String, override val help: String?) : Row() {
        override fun value() = field.text(host.fx[field.id])
        override fun pick() { editing = !editing }
    }

    private class Page(val title: String, val rows: () -> List<Row>)
    private class Spot(val page: Page, var index: Int = 0, var top: Int = 0)

    private val stack = ArrayList<Spot>()
    private var editing = false
    val isOpen get() = stack.isNotEmpty()

    // ------------------------------------------------------------------ pages

    private fun backRow() = ActionRow("Back") { back() }

    private fun mainPage() = Page("Filters") {
        listOf<Row>(ActionRow("Filters", { if (host.fx.on) "On" else "Off" }) { host.setFx(host.fx.withOn(!host.fx.on)) },
            PageRow("Ready-made looks", { null }, "Pick a look to start from. It replaces what is set now.") { looksPage() }) +
            FxDefs.Group.values().map { g ->
                PageRow(g.title, { FxDefs.FILTERS.count { it.group == g && host.fx[it.key] != 0 }.let { if (it == 0) null else "$it on" } }, null) { groupPage(g) }
            } +
            ActionRow("Close") { close() }
    }

    private fun looksPage() = Page("Ready-made looks") {
        FxDefs.PRESETS.map { p -> ActionRow(p.name) { host.setFx(host.fx.withPreset(p)); back() } } + backRow()
    }

    private fun groupPage(g: FxDefs.Group) = Page(g.title) {
        FxDefs.FILTERS.filter { it.group == g }.map { f ->
            if (f.fields.size == 1) FieldRow(f.amount, f.name, f.help)
            else PageRow(f.name, { f.amount.text(host.fx[f.key]).takeIf { host.fx[f.key] != 0 } }, f.help) { filterPage(f) }
        } + backRow()
    }

    private fun filterPage(f: FxDefs.Filter) = Page(f.name) {
        f.fields.map { fl -> FieldRow(fl, if (fl === f.amount) "Amount" else fl.label, f.help) } + backRow()
    }

    // ------------------------------------------------------------------ buttons

    fun open() {
        stack.clear(); stack += Spot(mainPage()); editing = false
        visibility = VISIBLE; invalidate(); host.touched()
    }

    fun close() {
        if (stack.isEmpty()) return
        stack.clear(); editing = false
        visibility = GONE; host.closed()
    }

    /** Back (-1) or next (+1). [repeat] counts the key's auto-repeats while held. */
    fun move(dir: Int, repeat: Int) {
        val s = stack.lastOrNull() ?: return
        host.touched()
        val rows = s.page.rows()
        val row = rows.getOrNull(s.index)
        val f = row?.field
        if (editing && f != null) {
            val cur = host.fx[f.id]
            val next = if (f.isChoice) {
                if (repeat > 0 && repeat % 4 != 0) return
                val n = f.max - f.min + 1
                f.min + ((cur - f.min + dir) % n + n) % n
            } else {
                val step = if (f.max - f.min <= 10) 1 else if (repeat > 12) 10 else 5
                (cur + dir * step).coerceIn(f.min, f.max)
            }
            if (next != cur) host.setFx(host.fx.with(f.id, next))
            invalidate(); return
        }
        if (repeat > 0 && repeat % 3 != 0) return
        s.index = ((s.index + dir) % rows.size + rows.size) % rows.size
        invalidate()
    }

    /** A short press on play: pick the row, or finish changing a value. */
    fun ok() {
        val s = stack.lastOrNull() ?: return
        host.touched()
        s.page.rows().getOrNull(s.index)?.pick()
        invalidate()
    }

    /** One step back: stop changing a value, else one page back, else close. */
    fun back() {
        host.touched()
        when {
            editing -> editing = false
            stack.size > 1 -> stack.removeAt(stack.size - 1)
            else -> { close(); return }
        }
        invalidate()
    }

    /** Settings changed somewhere else (the phone). */
    fun refresh() { if (isOpen) invalidate() }

    // ------------------------------------------------------------------ drawing

    private val panel = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(225, 10, 12, 22) }
    private val hiFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(91, 140, 255) }
    private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(60, 68, 100) }
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; typeface = Typeface.DEFAULT_BOLD }
    private val dim = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(190, 198, 220); typeface = Typeface.DEFAULT_BOLD }
    private val r = RectF()

    override fun onDraw(c: Canvas) {
        val s = stack.lastOrNull() ?: return
        val w = width.toFloat(); val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val unit = minOf(w, h * 0.6f)
        val pad = unit * 0.05f
        val rowH = unit * 0.105f
        val big = unit * 0.064f
        val small = unit * 0.046f
        val rows = s.page.rows()
        if (s.index >= rows.size) s.index = rows.size - 1
        val visible = 8
        if (s.index < s.top) s.top = s.index
        if (s.index >= s.top + visible) s.top = s.index - visible + 1
        s.top = s.top.coerceIn(0, (rows.size - visible).coerceAtLeast(0))
        val shown = rows.size.coerceAtMost(visible)

        val cur = rows.getOrNull(s.index)
        val helpText = if (editing) cur?.field?.let { if (it.isChoice) null else "Back and next change it. Press play when done." } ?: cur?.help else cur?.help
        dim.textSize = small
        val textW = (w - pad * 4).toInt().coerceAtLeast(1)
        val helpLayout = helpText?.let { StaticLayout.Builder.obtain(it, 0, it.length, dim, textW).setAlignment(Layout.Alignment.ALIGN_NORMAL).setMaxLines(4).setEllipsize(TextUtils.TruncateAt.END).build() }
        val titleH = big * 1.8f
        val hintH = small * 1.7f
        val helpH = (helpLayout?.height?.toFloat() ?: 0f) + (if (helpLayout != null) pad * 0.6f else 0f)
        val panelH = pad + titleH + shown * rowH + pad * 0.5f + helpH + hintH + pad
        val left = pad
        val right = w - pad
        val topY = ((h - panelH) / 2f).coerceAtLeast(pad)
        r.set(left, topY, right, topY + panelH)
        c.drawRoundRect(r, pad, pad, panel)

        var y = topY + pad
        text.textSize = big * 1.1f
        val crumbs = stack.joinToString("  >  ") { it.page.title }
        c.drawText(TextUtils.ellipsize(crumbs, text, right - left - pad * 2, TextUtils.TruncateAt.START).toString(), left + pad, y + big * 1.1f, text)
        y += titleH

        for (i in s.top until s.top + shown) {
            val row = rows[i]
            val sel = i == s.index
            val y0 = y + (i - s.top) * rowH
            if (sel) {
                r.set(left + pad * 0.5f, y0, right - pad * 0.5f, y0 + rowH * 0.92f)
                c.drawRoundRect(r, pad * 0.6f, pad * 0.6f, hiFill)
            }
            val base = y0 + rowH * 0.46f + big * 0.36f
            text.textSize = big
            val v = row.value()
            val f = row.field
            val editingThis = sel && editing && f != null
            var valueText = if (editingThis) "<  ${v ?: ""}  >" else if (row.opens) listOfNotNull(v, ">").joinToString("  ") else v
            dim.textSize = big
            val vw = valueText?.let { (if (sel) text else dim).measureText(it) } ?: 0f
            val label = TextUtils.ellipsize(row.label, text, right - left - pad * 3 - vw, TextUtils.TruncateAt.END).toString()
            c.drawText(label, left + pad, base, text)
            if (valueText != null) c.drawText(valueText, right - pad - vw, base, if (sel) text else dim)
            if (editingThis && !f!!.isChoice) {
                val bx0 = left + pad; val bx1 = right - pad
                val by = y0 + rowH * 0.82f
                val frac = (host.fx[f.id] - f.min).toFloat() / (f.max - f.min).coerceAtLeast(1)
                r.set(bx0, by, bx1, by + rowH * 0.06f); c.drawRoundRect(r, rowH, rowH, track)
                val zero = if (f.min < 0) (0f - f.min) / (f.max - f.min) else 0f
                val a = bx0 + (bx1 - bx0) * minOf(zero, frac); val b = bx0 + (bx1 - bx0) * maxOf(zero, frac)
                text.color = Color.WHITE
                r.set(a, by, b.coerceAtLeast(a + 2f), by + rowH * 0.06f); c.drawRoundRect(r, rowH, rowH, text)
            }
        }
        y += shown * rowH + pad * 0.5f
        if (helpLayout != null) {
            c.save(); c.translate(left + pad, y); helpLayout.draw(c); c.restore()
            y += helpH
        }
        dim.textSize = small
        val hint = when {
            editing -> "Back / Next: change    Play: done"
            else -> "Back / Next: move    Play: pick"
        }
        c.drawText(TextUtils.ellipsize(hint, dim, right - left - pad * 2, TextUtils.TruncateAt.END).toString(), left + pad, y + small * 1.2f, dim)
    }

    init { visibility = GONE; setWillNotDraw(false) }
}
