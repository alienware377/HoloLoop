package com.alienware377.hololoop.fx

import org.json.JSONObject

/**
 * The video filters for the Go: what each one is, the settings it has, the colour choices the
 * style filters use, and a few ready-made looks. The same maths as PurpleTV ReVive's filters
 * (see [FxShader]), minus the ones that need a picture or a live stream to measure.
 */
object FxDefs {

    enum class Group(val title: String) {
        LIGHT("Light"), DETAIL("Detail"), COLOR("Colour"), STYLE("Style"), EFFECTS("Effects"), GLITCH("Glitch")
    }

    /**
     * One adjustable setting. Sliders run [min]..[max]; a choice stores the index into [choices].
     * [id] is where it is stored in [FxState].
     */
    class Field(val id: String, val label: String, val min: Int, val max: Int, val def: Int, val choices: List<String>? = null) {
        val isChoice get() = choices != null
        fun text(v: Int): String = choices?.getOrNull(v) ?: if (min < 0 && v > 0) "+$v" else "$v"
    }

    /**
     * @param bipolar the amount runs -100..100 around 0; otherwise 0..100.
     * @param ranged offers a tone range (shadows to highlights).
     */
    class Filter(
        val key: String, val name: String, val group: Group, val help: String,
        val bipolar: Boolean = true, val ranged: Boolean = true,
    ) {
        val amount = Field(key, name, if (bipolar) -100 else 0, 100, 0)
        /** Everything you can set on this filter, the amount first. */
        val fields: List<Field> by lazy { listOf(amount) + extras(this) }
    }

    val FILTERS = listOf(
        // ---- Light ----
        Filter("exposure", "Exposure", Group.LIGHT,
            "Everything lighter or darker together, like a camera's aperture."),
        Filter("bright", "Brightness", Group.LIGHT,
            "Lighter or darker while protecting the brightest parts a little."),
        Filter("contrast", "Contrast", Group.LIGHT,
            "Darks darker and lights lighter for more punch. Lower it to soften a harsh picture."),
        Filter("highlights", "Highlights", Group.LIGHT,
            "Brightens or tames only the bright parts, like sky and lamps."),
        Filter("shadows", "Shadows", Group.LIGHT,
            "Lifts or deepens only the dark parts, to see into dark corners."),
        Filter("gamma", "Gamma", Group.LIGHT,
            "Bends the middle tones lighter or darker; pure black and white stay put."),
        Filter("fade", "Fade", Group.LIGHT,
            "Lifts the blacks into a soft, matte, film-like look.", bipolar = false),
        // ---- Detail ----
        Filter("clarity", "Clarity", Group.DETAIL,
            "Makes shapes and faces stand out without changing the overall brightness."),
        Filter("mtex", "Texture", Group.DETAIL,
            "Brings out skin, fabric and hair detail. Lower it to smooth skin."),
        Filter("texture", "Sharpen", Group.DETAIL,
            "Sharpens fine detail. Lower it to smooth out blocky compression."),
        Filter("soft", "Soft focus", Group.DETAIL,
            "A dreamy blur. Lovely on the highlights only, for a glow.", bipolar = false),
        // ---- Colour ----
        Filter("temp", "Temperature", Group.COLOR,
            "Warmer (more orange) or cooler (more blue)."),
        Filter("tint", "Tint", Group.COLOR,
            "Towards magenta or green, to fix a colour cast."),
        Filter("hue", "Hue", Group.COLOR,
            "Spins every colour around the colour wheel."),
        Filter("sat", "Saturation", Group.COLOR,
            "Stronger or weaker colours. All the way down is black and white."),
        Filter("vib", "Vibrance", Group.COLOR,
            "A gentler saturation that keeps skin tones natural."),
        // ---- Style ----
        Filter("mono", "Monotone", Group.STYLE,
            "Shades of one colour, from black through the colour to white.", bipolar = false),
        Filter("gmap", "Gradient map", Group.STYLE,
            "Each brightness becomes a colour from a gradient: darks take the first colour, lights the last.", bipolar = false),
        Filter("poster", "Posterize", Group.STYLE,
            "Fewer colour steps for a flat, poster or cel-shaded look.", bipolar = false),
        Filter("invert", "Invert", Group.STYLE,
            "Colours flipped to their opposites, like a photo negative.", bipolar = false),
        // ---- Effects ----
        Filter("grain", "Noise", Group.EFFECTS,
            "Film grain or digital noise. A little hides compression blockiness.", bipolar = false),
        Filter("bokeh", "Moving bokeh", Group.EFFECTS,
            "Soft glowing out-of-focus lights drifting across the picture.", bipolar = false, ranged = false),
        Filter("vignette", "Vignette", Group.EFFECTS,
            "Darker edges draw your eye to the middle; lighter edges fade them.", ranged = false),
        Filter("chroma", "Colour fringe", Group.EFFECTS,
            "Red and blue split slightly apart, like a cheap lens.", bipolar = false, ranged = false),
        Filter("pixel", "Pixelate", Group.EFFECTS,
            "Big square pixels for a retro game look.", bipolar = false, ranged = false),
        // ---- Glitch (all animated; each has its own speed) ----
        Filter("g_shift", "Slice shift", Group.GLITCH,
            "Strips of the picture jump sideways, like a broken signal.", bipolar = false, ranged = false),
        Filter("g_rgb", "RGB split", Group.GLITCH,
            "Red and blue jump apart and snap back.", bipolar = false, ranged = false),
        Filter("g_vhs", "VHS tracking", Group.GLITCH,
            "A wobbly old tape with a noisy band rolling down.", bipolar = false, ranged = false),
        Filter("g_blocks", "Block corruption", Group.GLITCH,
            "Square chunks tear out of place, like a corrupted file.", bipolar = false, ranged = false),
        Filter("g_wave", "Wave", Group.GLITCH,
            "The picture ripples side to side like a heat haze.", bipolar = false, ranged = false),
        Filter("g_shake", "Shake", Group.GLITCH,
            "The whole picture jitters, like a bumped camera.", bipolar = false, ranged = false),
        Filter("g_flicker", "Flicker", Group.GLITCH,
            "The brightness stutters like a failing light.", bipolar = false, ranged = false),
        Filter("g_static", "Static", Group.GLITCH,
            "Bursts of TV snow flash over the picture.", bipolar = false, ranged = false),
        Filter("g_scan", "Rolling scanlines", Group.GLITCH,
            "Dark lines roll down like an old monitor being filmed.", bipolar = false, ranged = false),
        Filter("g_swap", "Channel swap", Group.GLITCH,
            "Now and then the colours jump to the wrong channels.", bipolar = false, ranged = false),
        Filter("g_bleed", "Colour bleed", Group.GLITCH,
            "Colours smear sideways like a worn-out cable.", bipolar = false, ranged = false),
    )

    fun filter(key: String) = FILTERS.first { it.key == key }

    // ---- colour choices ----

    class Gradient(val name: String, val colors: IntArray)

    val GRADIENTS = listOf(
        Gradient("Noir", intArrayOf(0xFF000000.toInt(), 0xFF3A3A3A.toInt(), 0xFFFFFFFF.toInt())),
        Gradient("Sepia", intArrayOf(0xFF1E1208.toInt(), 0xFF7A5230.toInt(), 0xFFF2E3C6.toInt())),
        Gradient("Sunset", intArrayOf(0xFF1B0B3A.toInt(), 0xFF8E2A6E.toInt(), 0xFFF06B3B.toInt(), 0xFFFFD27A.toInt())),
        Gradient("Cyberpunk", intArrayOf(0xFF0B0630.toInt(), 0xFF6A12B8.toInt(), 0xFFFF2E9A.toInt(), 0xFF35F0FF.toInt())),
        Gradient("Vaporwave", intArrayOf(0xFF241047.toInt(), 0xFFB4489E.toInt(), 0xFF5CE1E6.toInt(), 0xFFFFF0FA.toInt())),
        Gradient("Ocean", intArrayOf(0xFF02101F.toInt(), 0xFF0B4F7A.toInt(), 0xFF39B4C8.toInt(), 0xFFE6FFFB.toInt())),
        Gradient("Forest", intArrayOf(0xFF07140B.toInt(), 0xFF2F5A2A.toInt(), 0xFFA8C46B.toInt(), 0xFFF4F7DC.toInt())),
        Gradient("Infrared", intArrayOf(0xFF000000.toInt(), 0xFF7A0010.toInt(), 0xFFFF5A1F.toInt(), 0xFFFFF27A.toInt())),
        Gradient("Thermal", intArrayOf(0xFF000020.toInt(), 0xFF2B1BB8.toInt(), 0xFFC21FB0.toInt(), 0xFFFF4A1A.toInt(), 0xFFFFE15A.toInt(), 0xFFFFFFFF.toInt())),
        Gradient("Night vision", intArrayOf(0xFF000800.toInt(), 0xFF0E5A12.toInt(), 0xFF7DFF6A.toInt(), 0xFFE9FFE0.toInt())),
        Gradient("Duotone purple", intArrayOf(0xFF1A0B2E.toInt(), 0xFFFF8FD8.toInt())),
        Gradient("Golden hour", intArrayOf(0xFF2A1406.toInt(), 0xFFB5652A.toInt(), 0xFFFFC879.toInt(), 0xFFFFF4DC.toInt())),
        Gradient("Mint", intArrayOf(0xFF07211C.toInt(), 0xFF2E8C76.toInt(), 0xFFB8F5DC.toInt())),
    )

    class Swatch(val name: String, val color: Int)

    val MONO_COLORS = listOf(
        Swatch("Purple", 0xFFA970FF.toInt()), Swatch("Pink", 0xFFFF7EC8.toInt()), Swatch("Blue", 0xFF5B8CFF.toInt()),
        Swatch("Teal", 0xFF3CC8C0.toInt()), Swatch("Green", 0xFF6BD66B.toInt()), Swatch("Amber", 0xFFFFB347.toInt()),
        Swatch("Red", 0xFFFF5A5A.toInt()), Swatch("Sepia", 0xFFB08A5E.toInt()),
    )

    val BOKEH_COLORS = listOf("Rainbow", "Warm", "Cool", "Pink")

    private fun extras(f: Filter): List<Field> {
        val out = ArrayList<Field>()
        when {
            f.group == Group.GLITCH -> out += Field("${f.key}_speed", "Speed", 0, 100, 50)
            f.key == "mono" -> out += Field("mono_color", "Colour", 0, MONO_COLORS.size - 1, 0, MONO_COLORS.map { it.name })
            f.key == "gmap" -> out += Field("gmap_preset", "Gradient", 0, GRADIENTS.size - 1, 3, GRADIENTS.map { it.name })
            f.key == "grain" -> {
                out += Field("grain_size", "Grain size", 1, 8, 2)
                out += Field("grain_color", "Kind", 0, 1, 0, listOf("Film", "Colour"))
            }
            f.key == "vignette" -> out += Field("vignette_size", "Size", 0, 100, 50)
            f.key == "bokeh" -> {
                out += Field("bokeh_mode", "Colours", 0, BOKEH_COLORS.size - 1, 0, BOKEH_COLORS)
                out += Field("bokeh_size", "Size", 0, 100, 45)
                out += Field("bokeh_density", "How many", 0, 100, 45)
                out += Field("bokeh_speed", "Speed", 0, 100, 40)
            }
        }
        if (f.ranged) {
            out += Field("${f.key}_lo", "Tones from", 0, 100, 0)
            out += Field("${f.key}_hi", "Tones to", 0, 100, 100)
        }
        return out
    }

    private val FIELDS: Map<String, Field> by lazy { FILTERS.flatMap { it.fields }.associateBy { it.id } }
    fun field(id: String): Field? = FIELDS[id]

    // ---- ready-made looks: "filter key" to amount, or a field id to its value ----

    class Preset(val name: String, val values: Map<String, Int>)

    val PRESETS = listOf(
        Preset("Brighten dark videos", mapOf("shadows" to 35, "gamma" to 20, "bright" to 10, "vib" to 10)),
        Preset("Vivid", mapOf("vib" to 45, "sat" to 10, "contrast" to 15, "clarity" to 20)),
        Preset("Cinema", mapOf("contrast" to 20, "fade" to 15, "temp" to 8, "vignette" to 35, "grain" to 12)),
        Preset("Black and white", mapOf("sat" to -100, "contrast" to 25, "clarity" to 15, "vignette" to 25)),
        Preset("Soft glow", mapOf("soft" to 35, "soft_lo" to 60, "bright" to 10, "vib" to 15)),
        Preset("Dreamy", mapOf("soft" to 25, "bokeh" to 45, "bokeh_mode" to 3, "fade" to 10, "temp" to 6)),
        Preset("Retro tape", mapOf("g_vhs" to 35, "g_bleed" to 30, "grain" to 20, "fade" to 15, "sat" to -20)),
        Preset("Glitchy", mapOf("g_rgb" to 37, "g_rgb_speed" to 39, "g_vhs" to 36, "g_shake" to 19, "g_shake_speed" to 48,
            "g_wave" to 18, "g_wave_speed" to 100, "g_scan" to 18, "g_scan_speed" to 76, "g_flicker" to 18,
            "g_shift" to 11, "g_shift_speed" to 80, "g_static" to 11, "g_blocks" to 4)),
    )
}

/**
 * Every filter setting at one moment. Immutable, so the GL thread can hold one safely; a change
 * makes a new one. Values not stored are at their defaults.
 */
class FxState(val on: Boolean = true, private val values: Map<String, Int> = emptyMap()) {

    operator fun get(id: String): Int {
        val f = FxDefs.field(id) ?: return values[id] ?: 0
        return (values[id] ?: f.def).coerceIn(f.min, f.max)
    }

    fun with(id: String, v: Int): FxState {
        val f = FxDefs.field(id)
        val n = if (f != null) v.coerceIn(f.min, f.max) else v
        val m = HashMap(values)
        if (f != null && n == f.def) m.remove(id) else m[id] = n
        return FxState(on, m)
    }

    fun withOn(b: Boolean) = FxState(b, values)

    /** A ready-made look: everything else goes back to its default. Turns filters on. */
    fun withPreset(p: FxDefs.Preset): FxState {
        var s = FxState(true, emptyMap())
        for ((k, v) in p.values) s = s.with(k, v)
        return s
    }

    /** What the filter does right now: its amount, or 0 while filters are switched off. */
    fun amount(f: FxDefs.Filter): Int = if (on) get(f.key) else 0

    /** Keys of the filters that do something right now. */
    val active: Set<String> by lazy { FxDefs.FILTERS.filter { amount(it) != 0 }.map { it.key }.toSet() }

    /** Whether something moves by itself, so the picture has to be redrawn over time. */
    val animated: Boolean by lazy {
        active.any { k -> k.startsWith("g_") || k == "bokeh" || k == "grain" }
    }

    /** Anything set at all, whether or not filters are switched on. */
    val anySet: Boolean get() = FxDefs.FILTERS.any { get(it.key) != 0 }

    fun toJson(): String = JSONObject().apply {
        put("on", on)
        put("v", JSONObject().apply { for ((k, v) in values) put(k, v) })
    }.toString()

    override fun equals(other: Any?) = other is FxState && other.on == on && other.values == values
    override fun hashCode() = values.hashCode() * 31 + on.hashCode()

    companion object {
        fun fromJson(s: String?): FxState = runCatching {
            val o = JSONObject(s ?: return FxState())
            val v = o.optJSONObject("v")
            val m = HashMap<String, Int>()
            if (v != null) for (k in v.keys()) m[k] = v.getInt(k)
            FxState(o.optBoolean("on", true), m)
        }.getOrDefault(FxState())
    }
}
