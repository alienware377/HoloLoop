package com.alienware377.hololoop.fx

/**
 * The filter maths as a GLSL ES 3.0 pass over a colour + depth picture. The colour half is
 * filtered; the depth half is copied, moved by the same glitch and pixelate distortions so the
 * 3D stays on the colour it belongs to. Ported from PurpleTV ReVive's FilterShader.
 *
 * The body works in pixel coordinates `p` of the colour half (y down), and reads it through SRC(p).
 * Filters not in the active set become zero constants, so the compiler drops their code.
 */
object FxShader {

    const val VERT = "#version 300 es\nin vec2 position;\nvoid main() { gl_Position = vec4(position, 0.0, 1.0); }\n"

    private val BODY = """
const vec3 LW = vec3(0.299, 0.587, 0.114);

float bandw(vec3 f, float L) {
    return smoothstep(f.y - 0.15, f.y, L) * (1.0 - smoothstep(f.z, f.z + 0.15, L));
}
float lum3(vec3 c) { return dot(c, LW); }
float hash(vec2 q) { vec3 p3 = fract(vec3(q.x, q.y, q.x) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float sat3(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

float lumAt(vec2 q) { return lum3(SRC(q)); }

vec3 MONO(float t) {
    return t < 0.5 ? mix(vec3(0.0), uMono, t * 2.0) : mix(uMono, vec3(1.0), (t - 0.5) * 2.0);
}
vec3 GRAD(float t) {
    float x = clamp(t, 0.0, 1.0) * float(uGradN - 1);
    int i = int(min(floor(x), float(uGradN - 2)));
    return mix(uGrad[i], uGrad[i + 1], x - float(i));
}

vec3 bokehColor(float h) {
    if (uBokehMode < 0.5) return hsv2rgb(vec3(h, 0.55, 1.0));
    if (uBokehMode < 1.5) return mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.9, 0.55), h);
    if (uBokehMode < 2.5) return mix(vec3(0.3, 0.6, 1.0), vec3(0.6, 1.0, 0.95), h);
    return mix(vec3(1.0, 0.45, 0.75), vec3(0.75, 0.5, 1.0), h);
}

// Where to read from: glitch distortions, then pixelate. Shared with the depth half.
vec2 warpQ(vec2 p, out float blockHit) {
    float a = 0.0;
    blockHit = 0.0;
    vec2 q = p;
    a = f_g_shake.x;
    if (a > 0.003) {
        float ts = floor(uTime * (3.0 + f_g_shake.y * 20.0));
        q += (vec2(hash(vec2(ts, 1.3)), hash(vec2(ts, 7.9))) - 0.5) * a * 40.0;
    }
    a = f_g_wave.x;
    if (a > 0.003) q.x += sin(p.y * 0.025 + uTime * (1.0 + f_g_wave.y * 8.0)) * a * 28.0;
    a = f_g_vhs.x;
    if (a > 0.003) {
        float sp = 0.5 + f_g_vhs.y * 2.0;
        q.x += sin(p.y * 0.045 + uTime * 3.0 * sp) * a * 5.0;
        float y0 = fract(uTime * 0.12 * sp) * uSize.y * 1.2 - uSize.y * 0.1;
        float band = 1.0 - smoothstep(0.0, uSize.y * 0.05, abs(p.y - y0));
        q.x += (hash(vec2(floor(p.y / 3.0), floor(uTime * 30.0))) - 0.5) * band * a * 50.0;
    }
    a = f_g_shift.x;
    if (a > 0.003) {
        float ts = floor(uTime * (2.0 + f_g_shift.y * 22.0));
        float bh = uSize.y * (0.015 + 0.06 * hash(vec2(ts, 4.2)));
        float band = floor(p.y / bh);
        if (hash(vec2(band, ts)) < a * 0.45) q.x += (hash(vec2(band, ts + 7.0)) - 0.5) * uSize.x * 0.2 * a;
    }
    a = f_g_blocks.x;
    if (a > 0.003) {
        float ts = floor(uTime * (2.0 + f_g_blocks.y * 18.0));
        float bsz = 32.0 + 64.0 * hash(vec2(ts, 2.1));
        vec2 cell = floor(p / bsz);
        if (hash(cell + ts * 1.31) < a * 0.22) {
            q += (vec2(hash(cell + ts + 3.3), hash(cell + ts + 5.7)) - 0.5) * bsz * 3.0;
            blockHit = 1.0;
        }
    }
    if (f_pixel.x > 0.003) {
        float bs = 2.0 + f_pixel.x * 46.0;
        q = (floor(q / bs) + 0.5) * bs;
    }
    return q;
}

vec4 filterMain(vec2 p, vec2 q, float blockHit) {
    float a = 0.0;
    float w = 0.0;
    vec3 own = SRC(q);
    if (f_chroma.x > 0.003) {
        vec2 off = vec2(f_chroma.x * 14.0, 0.0);
        own = vec3(SRC(q + off).r, own.g, SRC(q - off).b);
    }
    a = f_g_rgb.x;
    if (a > 0.003) {
        float ts = floor(uTime * (3.0 + f_g_rgb.y * 20.0));
        float j = (hash(vec2(ts, 11.0)) - 0.5) * 2.0;
        vec2 off = vec2(a * 6.0 + j * a * 22.0, (hash(vec2(ts, 13.0)) - 0.5) * a * 6.0);
        own = vec3(SRC(q + off).r, own.g, SRC(q - off).b);
    }
    a = f_g_bleed.x;
    if (a > 0.003) {
        vec3 s1 = SRC(q - vec2(4.0 + a * 10.0, 0.0));
        vec3 s2 = SRC(q - vec2(8.0 + a * 22.0, 0.0));
        own = mix(own, max(own, (s1 + s2) * 0.5), a * 0.8);
    }
    own = clamp(own, 0.0, 1.0);

    float L0 = lum3(own);

    // ---- light ----
    a = f_exposure.x;
    if (abs(a) > 0.003) own = clamp(own * pow(2.0, a * 2.0 * bandw(f_exposure, L0)), 0.0, 1.0);
    a = f_bright.x;
    if (abs(a) > 0.003) {
        w = bandw(f_bright, L0);
        vec3 up = 1.0 - pow(1.0 - own, vec3(1.0 + a * 1.5));
        vec3 dn = pow(own, vec3(1.0 - a * 1.5));
        own = mix(own, a > 0.0 ? up : dn, w);
    }
    a = f_contrast.x;
    if (abs(a) > 0.003) own = clamp(mix(own, (own - 0.5) * (1.0 + a * 1.5) + 0.5, bandw(f_contrast, L0)), 0.0, 1.0);
    a = f_highlights.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        w = smoothstep(0.45, 1.0, L) * bandw(f_highlights, L0);
        own = clamp(own * (1.0 + a * 0.6 * w), 0.0, 1.0);
    }
    a = f_shadows.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        w = (1.0 - smoothstep(0.0, 0.55, L)) * bandw(f_shadows, L0);
        own = clamp(own + a * 0.35 * w * (1.0 - own), 0.0, 1.0);
        if (a < 0.0) own = clamp(own * (1.0 + a * 0.6 * w), 0.0, 1.0);
    }
    a = f_gamma.x;
    if (abs(a) > 0.003) own = mix(own, pow(max(own, 0.0), vec3(pow(2.0, -a * 1.5))), bandw(f_gamma, L0));
    a = f_fade.x;
    if (a > 0.003) {
        w = bandw(f_fade, L0);
        own = mix(own, own * (1.0 - a * 0.35) + a * 0.22, w);
    }

    // ---- detail ----
    a = f_clarity.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        float Lb = L0;
        for (int k = 0; k < 8; k++) {
            float ang = float(k) * 0.7853981;
            vec2 d = vec2(cos(ang), sin(ang));
            Lb += lumAt(q + d * uBlur) + lumAt(q + d * uBlur * 0.5);
        }
        Lb = Lb / 17.0;
        own = clamp(own * (1.0 + a * 2.5 * (L - Lb) * bandw(f_clarity, L0) / max(L, 0.05)), 0.0, 1.0);
    }
    a = f_mtex.x;
    if (abs(a) > 0.003) {
        float r = max(uSize.y / 1080.0, 0.6) * 3.5;
        float L = lum3(own);
        float Lm = 0.0;
        for (int k = 0; k < 8; k++) {
            float ang = float(k) * 0.7853981 + 0.2;
            Lm += lumAt(q + vec2(cos(ang), sin(ang)) * r);
        }
        Lm = Lm * 0.125;
        float amt = a > 0.0 ? a * 2.2 : a;
        own = clamp(own * (1.0 + amt * (L0 - Lm) * bandw(f_mtex, L0) / max(L, 0.05)), 0.0, 1.0);
    }
    a = f_texture.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        float ln = lumAt(q + vec2(1.25, 0.0)) + lumAt(q - vec2(1.25, 0.0))
                 + lumAt(q + vec2(0.0, 1.25)) + lumAt(q - vec2(0.0, 1.25));
        float lap = L0 - ln * 0.25;
        own = clamp(own * (1.0 + a * 3.0 * lap * bandw(f_texture, L0) / max(L, 0.05)), 0.0, 1.0);
    }
    a = f_soft.x;
    if (a > 0.003) {
        vec3 acc = own;
        float r = uBlur * (0.4 + a);
        for (int k = 0; k < 8; k++) {
            float ang = float(k) * 0.7853981 + 0.39;
            vec2 d = vec2(cos(ang), sin(ang));
            acc += SRC(q + d * r) + SRC(q + d * r * 0.5);
        }
        acc = acc / 17.0;
        own = mix(own, max(own, acc) * 0.5 + acc * 0.5, a * bandw(f_soft, L0));
    }

    // ---- colour ----
    a = f_temp.x;
    if (abs(a) > 0.003) {
        w = bandw(f_temp, L0);
        own = clamp(own * mix(vec3(1.0), vec3(1.0 + a * 0.25, 1.0 + a * 0.03, 1.0 - a * 0.25), w), 0.0, 1.0);
    }
    a = f_tint.x;
    if (abs(a) > 0.003) {
        w = bandw(f_tint, L0);
        own = clamp(own * mix(vec3(1.0), vec3(1.0 + a * 0.12, 1.0 - a * 0.2, 1.0 + a * 0.12), w), 0.0, 1.0);
    }
    a = f_hue.x;
    if (abs(a) > 0.003) {
        vec3 h = rgb2hsv(own);
        h.x = fract(h.x + a * 0.5);
        own = mix(own, hsv2rgb(h), bandw(f_hue, L0));
    }
    a = f_sat.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        own = clamp(mix(vec3(L), own, 1.0 + a * bandw(f_sat, L0)), 0.0, 1.0);
    }
    a = f_vib.x;
    if (abs(a) > 0.003) {
        float L = lum3(own);
        float cs = sat3(own);
        own = clamp(mix(vec3(L), own, 1.0 + a * (1.0 - cs) * bandw(f_vib, L0)), 0.0, 1.0);
    }

    // ---- style ----
    a = f_mono.x;
    if (a > 0.003) own = mix(own, MONO(lum3(own)), a * bandw(f_mono, L0));
    a = f_gmap.x;
    if (a > 0.003) own = mix(own, GRAD(lum3(own)), a * bandw(f_gmap, L0));
    a = f_poster.x;
    if (a > 0.003) {
        float lv = floor(mix(24.0, 2.0, a));
        own = mix(own, floor(own * lv + 0.5) / lv, bandw(f_poster, L0));
    }
    a = f_invert.x;
    if (a > 0.003) own = mix(own, 1.0 - own, a * bandw(f_invert, L0));

    // ---- effects ----
    a = f_grain.x;
    if (a > 0.003) {
        vec2 g = floor(p / uGrainSize) + uSeed;
        float n = hash(g) - 0.5;
        vec3 nc = uGrainColor > 0.5 ? vec3(hash(g + 17.0), hash(g + 31.0), hash(g + 47.0)) - 0.5 : vec3(n);
        float mid = 1.0 - abs(lum3(own) * 2.0 - 1.0) * 0.6;
        own = clamp(own + nc * a * 0.35 * mid * bandw(f_grain, L0), 0.0, 1.0);
    }
    a = f_bokeh.x;
    if (a > 0.003) {
        vec3 acc = vec3(0.0);
        float sp = 0.2 + f_bokeh.y * 1.6;
        for (int k = 0; k < 4; k++) {
            float fl = float(k);
            float S = uSize.y * (0.07 + f_bokeh.z * 0.2) * (1.0 + fl * 0.45);
            vec2 drift = vec2(sin(uTime * 0.07 * sp + fl * 2.1) * S * 0.8, -uTime * S * 0.06 * sp * (1.0 + fl * 0.35));
            vec2 pp = p - drift + vec2(fl * 37.0, fl * 91.0);
            vec2 c = floor(pp / S);
            float r = hash(c + fl * 17.0);
            if (r < uBokehDensity) {
                vec2 ctr = (c + 0.5 + (vec2(hash(c + 3.1 + fl), hash(c + 7.7 + fl)) - 0.5) * 0.3) * S;
                float rad = S * (0.15 + 0.2 * hash(c + 11.3 + fl));
                float d = length(pp - ctr) / rad;
                float disc = (1.0 - smoothstep(0.8, 1.0, d)) * (0.55 + 0.45 * smoothstep(0.5, 0.95, d));
                float tw = 0.65 + 0.35 * sin(uTime * (0.6 + r * 1.7) * sp + r * 6.28);
                acc += bokehColor(hash(c + 23.0 + fl)) * disc * tw * (0.55 - fl * 0.08);
            }
        }
        own = 1.0 - (1.0 - own) * (1.0 - clamp(acc * a, 0.0, 1.0));
    }
    // ---- glitch colour effects ----
    if (blockHit > 0.5) own = mix(own, own.gbr * vec3(1.25, 0.85, 1.3), 0.6);
    a = f_g_vhs.x;
    if (a > 0.003) {
        float sp = 0.5 + f_g_vhs.y * 2.0;
        float y0 = fract(uTime * 0.12 * sp) * uSize.y * 1.2 - uSize.y * 0.1;
        float band = 1.0 - smoothstep(0.0, uSize.y * 0.05, abs(p.y - y0));
        own = mix(own, vec3(hash(floor(p / 2.0) + fract(uTime * 9.1) * 50.0)), band * a * 0.5);
        own *= 1.0 - a * 0.08;
    }
    a = f_g_swap.x;
    if (a > 0.003) {
        float ts = floor(uTime * (2.0 + f_g_swap.y * 14.0));
        float r = hash(vec2(ts, 21.0));
        if (r < a * 0.35) own = r < a * 0.17 ? own.brg : own.gbr;
    }
    a = f_g_flicker.x;
    if (a > 0.003) {
        float ts = floor(uTime * (6.0 + f_g_flicker.y * 30.0));
        own *= 1.0 - a * 0.55 * hash(vec2(ts, 31.0));
    }
    a = f_g_scan.x;
    if (a > 0.003) {
        float yy = p.y + uTime * (30.0 + f_g_scan.y * 240.0);
        float line = 0.5 + 0.5 * sin(yy * 0.7);
        float roll = 1.0 - smoothstep(0.0, uSize.y * 0.08, abs(fract(uTime * (0.08 + f_g_scan.y * 0.3)) * uSize.y - p.y));
        own *= 1.0 - a * (0.25 * line + 0.25 * roll);
    }
    a = f_g_static.x;
    if (a > 0.003) {
        float ts = floor(uTime * (4.0 + f_g_static.y * 20.0));
        float burst = 0.25 + 0.75 * step(0.65, hash(vec2(ts, 41.0)));
        float n = hash(floor(p / 2.0) + fract(uTime * 7.31) * 100.0);
        own = mix(own, vec3(n), a * burst * 0.65);
    }
    a = f_vignette.x;
    if (abs(a) > 0.003) {
        vec2 c = (p / uSize - 0.5) * vec2(uSize.x / uSize.y, 1.0);
        float r = length(c) / length(vec2(uSize.x / uSize.y, 1.0) * 0.5);
        float v = smoothstep(uVigSize, uVigSize + 0.55, r);
        own = a > 0.0 ? own * (1.0 - a * v) : mix(own, vec3(1.0), -a * v * 0.85);
    }
    return vec4(own, 1.0);
}
"""

    /**
     * The fragment shader with only the filters in [active] adjustable.
     * uC / uD: the colour and depth halves of the input in texture uv (x0, y0, x1, y1), v up.
     */
    fun frag(active: Set<String>): String = buildString {
        append("#version 300 es\nprecision highp float;\nprecision highp sampler2D;\nout vec4 fragColor;\n")
        append("uniform sampler2D uTex;\nuniform vec2 uOut;\nuniform vec4 uC;\nuniform vec4 uD;\nuniform vec2 uHalf;\n")
        append("uniform vec2 uSize;\nuniform float uBlur;\nuniform float uSeed;\nuniform float uGrainSize;\nuniform float uGrainColor;\n")
        append("uniform float uVigSize;\nuniform float uTime;\nuniform float uBokehMode;\nuniform float uBokehDensity;\n")
        append("uniform vec3 uMono;\nuniform vec3 uGrad[6];\nuniform int uGradN;\n")
        for (f in FxDefs.FILTERS) {
            if (f.key in active) append("uniform vec3 f_").append(f.key).append(";\n")
            else append("const vec3 f_").append(f.key).append(" = vec3(0.0);\n")
        }
        append("vec2 local(vec2 p) { return clamp(vec2(p.x / uSize.x, 1.0 - p.y / uSize.y), uHalf, 1.0 - uHalf); }\n")
        append("vec3 SRC(vec2 p) { return texture(uTex, uC.xy + local(p) * (uC.zw - uC.xy)).rgb; }\n")
        append(BODY)
        append("""
void main() {
    vec2 uv = gl_FragCoord.xy / uOut;
    bool inD = uv.x >= uD.x && uv.x <= uD.z && uv.y >= uD.y && uv.y <= uD.w;
    vec4 r = inD ? uD : uC;
    vec2 l = (uv - r.xy) / (r.zw - r.xy);
    vec2 p = vec2(l.x, 1.0 - l.y) * uSize;
    float hit;
    vec2 q = warpQ(p, hit);
    if (inD) { fragColor = texture(uTex, uD.xy + local(q) * (uD.zw - uD.xy)); return; }
    fragColor = filterMain(p, q, hit);
}
""")
    }
}
