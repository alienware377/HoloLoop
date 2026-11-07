package com.alienware377.hololoop.kiosk

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.RangeSlider
import com.google.android.material.slider.Slider
import com.alienware377.hololoop.R
import com.alienware377.hololoop.fx.FxDefs
import com.alienware377.hololoop.fx.FxState

/**
 * The video filters on the phone: every filter as a slider, its extras under it once it is on,
 * and the same ready-made looks as the Go's own menu. Built in code, filled into [host].
 */
class FxPanel(private val ctx: Context, private val host: Host) {

    interface Host {
        val fx: FxState
        fun setFx(s: FxState)
        fun closeFx()
    }

    private val dp = ctx.resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()
    private val refreshers = ArrayList<() -> Unit>()
    private var syncing = false

    private fun label(t: String, size: Float, color: Int, bold: Boolean = false) = TextView(ctx).apply {
        text = t; textSize = size; setTextColor(color); if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    fun build(): View {
        val col = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(px(18), px(4), px(18), px(32)) }

        // header
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(px(22), px(22), px(12), px(6)) }
        val titles = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        titles.addView(label("Video filters", 20f, TEXT, true))
        titles.addView(label("Also on the Go: press its play button twice to open the menu there.", 13f, DIM))
        head.addView(titles, LinearLayout.LayoutParams(0, -2, 1f))
        head.addView(MaterialButton(ctx, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
            text = ctx.getString(R.string.loop_close); setOnClickListener { host.closeFx() }
        })

        // master switch, looks, reset
        val bar = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val sw = MaterialSwitch(ctx).apply {
            text = "Filters on"; setTextColor(TEXT)
            setOnCheckedChangeListener { _, b -> if (!syncing) host.setFx(host.fx.withOn(b)) }
        }
        refreshers += { sw.isChecked = host.fx.on }
        bar.addView(sw, LinearLayout.LayoutParams(0, -2, 1f))
        bar.addView(MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = "Looks"
            setOnClickListener { v ->
                PopupMenu(ctx, v).apply {
                    FxDefs.PRESETS.forEachIndexed { i, p -> menu.add(0, i, i, p.name) }
                    setOnMenuItemClickListener { host.setFx(host.fx.withPreset(FxDefs.PRESETS[it.itemId])); true }
                }.show()
            }
        })
        col.addView(bar)

        for (g in FxDefs.Group.values()) {
            col.addView(label(g.title, 15f, ACCENT, true).apply { setPadding(0, px(18), 0, px(2)) })
            for (f in FxDefs.FILTERS.filter { it.group == g }) col.addView(filterBlock(f))
        }

        val scroll = ScrollView(ctx).apply { addView(col); isFillViewport = true }
        val page = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        page.addView(head)
        page.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        refresh()
        return page
    }

    private fun filterBlock(f: FxDefs.Filter): View {
        val box = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(0, px(6), 0, px(2)) }
        val top = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val name = label(f.name, 15f, TEXT, true)
        val value = label("", 14f, DIM)
        val help = label(f.help, 13f, DIM).apply { visibility = View.GONE }
        name.setOnClickListener { help.visibility = if (help.visibility == View.VISIBLE) View.GONE else View.VISIBLE }
        top.addView(name, LinearLayout.LayoutParams(0, -2, 1f)); top.addView(value)
        box.addView(top); box.addView(help)

        val slider = Slider(ctx).apply {
            valueFrom = f.amount.min.toFloat(); valueTo = f.amount.max.toFloat(); stepSize = 1f; isTickVisible = false
            // a slider around 0 would look half full at rest, so its track stays one colour
            if (f.bipolar) trackActiveTintList = trackInactiveTintList
            addOnChangeListener { _, v, user -> if (user && !syncing) host.setFx(host.fx.with(f.key, v.toInt())) }
        }
        box.addView(slider)

        val extras = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(px(14), 0, 0, px(4)) }
        val fields = f.fields.drop(1)
        var i = 0
        while (i < fields.size) {
            val fl = fields[i]
            val pair = fields.getOrNull(i + 1)
            if (fl.id.endsWith("_lo") && pair != null && pair.id.endsWith("_hi")) { extras.addView(rangeRow(fl, pair)); i += 2; continue }
            extras.addView(if (fl.isChoice) choiceRow(fl) else sliderRow(fl)); i++
        }
        box.addView(extras)

        refreshers += {
            val a = host.fx[f.key]
            if (slider.value.toInt() != a) slider.value = a.toFloat()
            value.text = if (a == 0) "Off" else f.amount.text(a)
            extras.visibility = if (a != 0 && fields.isNotEmpty()) View.VISIBLE else View.GONE
        }
        return box
    }

    private fun sliderRow(fl: FxDefs.Field): View {
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val t = label("", 13f, DIM)
        val s = Slider(ctx).apply {
            valueFrom = fl.min.toFloat(); valueTo = fl.max.toFloat(); stepSize = 1f; isTickVisible = false
            addOnChangeListener { _, v, user -> if (user && !syncing) host.setFx(host.fx.with(fl.id, v.toInt())) }
        }
        row.addView(t); row.addView(s)
        refreshers += {
            val v = host.fx[fl.id]
            if (s.value.toInt() != v) s.value = v.toFloat()
            t.text = "${fl.label}: ${fl.text(v)}"
        }
        return row
    }

    private fun rangeRow(lo: FxDefs.Field, hi: FxDefs.Field): View {
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val t = label("", 13f, DIM)
        val s = RangeSlider(ctx).apply {
            valueFrom = 0f; valueTo = 100f; stepSize = 1f; isTickVisible = false; values = listOf(0f, 100f)
            addOnChangeListener { sl, _, user ->
                if (user && !syncing) host.setFx(host.fx.with(lo.id, sl.values[0].toInt()).with(hi.id, sl.values[1].toInt()))
            }
        }
        row.addView(t); row.addView(s)
        refreshers += {
            val a = host.fx[lo.id]; val b = host.fx[hi.id]
            if (s.values[0].toInt() != a || s.values[1].toInt() != b) s.values = listOf(a.toFloat(), b.toFloat())
            t.text = if (a == 0 && b == 100) "Tones: all" else "Tones: $a to $b (shadows 0, highlights 100)"
        }
        return row
    }

    private fun choiceRow(fl: FxDefs.Field): View {
        val row = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        row.addView(label(fl.label, 13f, DIM))
        val group = ChipGroup(ctx).apply { isSingleSelection = true; isSelectionRequired = true }
        val chips = fl.choices!!.mapIndexed { i, name ->
            Chip(ctx, null, com.google.android.material.R.attr.chipStyle).apply {
                text = name; isCheckable = true; id = View.generateViewId()
                setOnClickListener { if (!syncing) host.setFx(host.fx.with(fl.id, i)) }
            }.also { group.addView(it) }
        }
        row.addView(group)
        refreshers += {
            val v = host.fx[fl.id]
            chips.getOrNull(v)?.let { if (!it.isChecked) group.check(it.id) }
        }
        return row
    }

    /** Show the settings as they are now (after a change here, on the Go, or a look). */
    fun refresh() {
        syncing = true
        try { for (r in refreshers) r() } finally { syncing = false }
    }

    private companion object {
        val TEXT = Color.parseColor("#E9ECF3")
        val DIM = Color.parseColor("#98A0B3")
        val ACCENT = Color.parseColor("#8A6BFF")
    }
}
