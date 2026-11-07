#version 300 es
// RGBD (colour + depth) light field through the Go's lenses.
// Each subpixel's view is synthesised straight from colour + depth. View value
// vl in [0,1], 0 = leftmost camera; a camera on the left sees things nearer than
// the focal plane shifted right, so screen point x shows source s = x - k*(z-focus).
// The view ray is marched from near (z=1) to far (z=0) and the FIRST surface hit
// wins (parallax occlusion mapping): near objects cover far ones and revealed
// gaps fill with background instead of a ghost copy. The search runs once per
// pixel at the green subpixel's view; red and blue reuse the depth it found.
// Kept in step with HoloLoop's PC player (src/player/shaders.js).
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
in vec2 v_screen_uv;

uniform sampler2D tex;       // colour + depth in one picture, v=0 is the bottom
uniform float pitch;
uniform float slope;
uniform float center;
uniform float subpixelSize;
uniform vec4 tile;           // x*y = view count used for the half-view offset
uniform bool filter_edge;
uniform int invView;         // 1 = reverse view order (device)

uniform int depth_loc;       // 0 top, 1 bottom, 2 right, 3 left
uniform int depth_inversion; // 1 = white is far
uniform float depthiness;    // max parallax, fraction of the picture width
uniform float focus;         // depth value that sits on the glass
uniform int iterations;      // ray-march steps
uniform int edgeFix;         // 3D edge fixing, see the block below (0 = off, the original look)
uniform vec3 mapU;           // shown picture q (0..1) -> colour uv: u = dot(mapU,(q,1)), v = dot(mapV,(q,1))
uniform vec3 mapV;           // (crop, pan, zoom and quarter turns from the framing)
uniform vec4 contentRect;    // the real picture in the colour half (U0, V0, U1, V1), no black bars

out vec4 color;

vec2 colorUV(vec2 uv) {
    if (depth_loc == 0) return vec2(uv.x, uv.y * 0.5);
    if (depth_loc == 1) return vec2(uv.x, uv.y * 0.5 + 0.5);
    if (depth_loc == 2) return vec2(uv.x * 0.5, uv.y);
    return vec2(uv.x * 0.5 + 0.5, uv.y);
}
vec2 depthUV(vec2 uv) {
    if (depth_loc == 0) return vec2(uv.x, uv.y * 0.5 + 0.5);
    if (depth_loc == 1) return vec2(uv.x, uv.y * 0.5);
    if (depth_loc == 2) return vec2(uv.x * 0.5 + 0.5, uv.y);
    return vec2(uv.x * 0.5, uv.y);
}
// ---- 3D edge fixing (shared by the PC player and the phone app) -------------------------
// edgeFix: 0 off (the original look), 1 clean colours, 2 clean + fill gaps,
//          3 fill gaps + calmer sides, 4 best quality (slow)
uniform vec2 colorTexel;    // one pixel of the colour picture in colour uv: 1/(width, height) of the REAL video

vec2 pxUV() { return colorTexel.x > 0.0 ? colorTexel : vec2(0.001); }
// one colour pixel along the parallax direction, in shown-picture widths (follows crop, zoom and quarter turns)
float texelQ() { return 1.0 / max(length(vec2(mapU.x, mapV.x) / pxUV()), 1.0); }

vec2 qmap(vec2 q) { return vec2(dot(mapU, vec3(q, 1.0)), dot(mapV, vec3(q, 1.0))); }
vec2 inRect(vec2 uv) {
    // off keeps the old tiny inset; the fixes stay 1.5 px clear of the colour|depth seam (video blur leaks across it)
    vec2 inset = edgeFix == 0 ? vec2(0.0005) : 1.5 * pxUV();
    return clamp(uv, contentRect.xy + inset, contentRect.zw - inset);
}

// depth at a point q of the SHOWN picture
float depthAt(vec2 q) {
    float d = texture(tex, depthUV(inRect(qmap(q)))).r;
    return depth_inversion == 1 ? 1.0 - d : d;
}

// one colour channel at column sx of the shown picture
float colourAt(float sx, float y, int ch) {
    vec2 m = qmap(vec2(sx, y));
    float c = texture(tex, colorUV(inRect(m)))[ch];
    if (edgeFix >= 2) {
        // window frame: past the real picture edge is black, not the last column repeated
        vec2 o = max(contentRect.xy - m, m - contentRect.zw) / pxUV();   // pixels outside (negative = inside)
        c *= clamp(0.5 - max(o.x, o.y), 0.0, 1.0);
    }
    return c;
}

// Mode 4: every subpixel marches its OWN view ray (one loop, three reads per step so the GPU
// overlaps them), then fills its own revealed gap. Colour planes agree by construction.
vec3 rgbdExact(vec2 uv, vec3 k) {
    float n = float(max(iterations, 2));
    vec3 b = vec3(0.0), found = vec3(0.0);
    for (int i = 1; i <= 48; i++) {
        if (float(i) > n) break;
        float zi = 1.0 - float(i) / n;
        vec3 s = uv.x - k * (zi - focus);
        vec3 d = vec3(depthAt(vec2(s.r, uv.y)), depthAt(vec2(s.g, uv.y)), depthAt(vec2(s.b, uv.y)));
        vec3 now = step(vec3(zi), d) * (1.0 - found);      // channels hitting for the first time
        b = mix(b, vec3(zi), now);
        found += now;
        if (min(found.r, min(found.g, found.b)) > 0.5) break;
    }
    vec3 a = b + 1.0 / n;                                 // a: no hit yet, b: hit (the step before)
    for (int j = 0; j < 5; j++) {
        vec3 m = 0.5 * (a + b);
        vec3 s = uv.x - k * (m - focus);
        vec3 h = step(m, vec3(depthAt(vec2(s.r, uv.y)), depthAt(vec2(s.g, uv.y)), depthAt(vec2(s.b, uv.y))));
        b = mix(b, m, h);
        a = mix(m, a, h);
    }
    float tq = texelQ();
    vec3 c;
    for (int ch = 0; ch < 3; ch++) {
        float kc = k[ch], zc = b[ch];
        float e = uv.x - kc * (zc - focus);                 // where this channel's ray ended
        float sx = e;
        if (abs(kc) > 1e-5) {
            float dir = kc >= 0.0 ? 1.0 : -1.0;               // rays slide this way going deeper; a gap's background is at -dir
            float dB = depthAt(vec2(e - dir * 5.0 * tq, uv.y));
            float dF = depthAt(vec2(e + dir * 5.0 * tq, uv.y));
            float hole = smoothstep(0.03, 0.08, dF - zc) * smoothstep(0.04, 0.08, dF - dB);
            if (hole > 0.0) {
                float zBg = min(dB, zc);
                float sFill = e - dir * max(abs(kc) * (zc - zBg), 2.0 * tq);   // background mirrored about the edge
                if (depthAt(vec2(sFill, uv.y)) > zBg + 0.1) sFill = e - dir * 2.0 * tq;  // never pull another near thing in
                sx = mix(e, sFill, hole);
            }
        }
        c[ch] = colourAt(sx, uv.y, ch);
    }
    return c;
}

// RGBD: view value vl in [0,1], 0 = leftmost camera. Screen point x shows source s = x - k*(z - focus).
// The green subpixel's ray is marched near to far and the FIRST surface wins (parallax occlusion mapping).
vec3 rgbdColor(vec2 uv, vec3 vl) {
    vec3 u = 0.5 - vl;
    // calmer sides (mode 3): ease the parallax off toward the cone edges, the centre stays nearly linear
    vec3 k = (edgeFix == 3 ? u * (1.0 - 0.8 * u * u) : u) * depthiness;
    if (edgeFix == 4) return rgbdExact(uv, k);
    float kg = k.g;
    float z = 0.0;
    if (abs(kg) > 1e-5) {
        float n = float(max(iterations, 2));
        float a = 1.0, b = 0.0;               // a: no hit yet, b: hit
        bool hit = false;
        // march near to far and only REMEMBER the step that hits; refine once after the loop
        // (inside the loop a GPU wave can repeat the 5 refine reads once per different hit step
        // among its pixels, and neighbouring pixels are different views). Same result as before.
        // The z = 1 step only ever hits pure-white depth, so the fixes skip it (one read saved).
        for (int i = (edgeFix == 0 ? 0 : 1); i <= 48; i++) {
            if (float(i) > n) break;
            float zi = 1.0 - float(i) / n;
            b = zi;
            if (depthAt(vec2(uv.x - kg * (zi - focus), uv.y)) >= zi) { hit = true; break; }
            a = zi;
        }
        if (hit) {
            for (int j = 0; j < 5; j++) {
                float m = 0.5 * (a + b);
                if (depthAt(vec2(uv.x - kg * (m - focus), uv.y)) >= m) b = m; else a = m;
            }
        }
        z = hit ? b : 0.0;
    } else z = depthAt(uv);

    vec3 c;
    if (edgeFix == 0) {               // off: red and blue reuse green's depth (the original look)
        for (int ch = 0; ch < 3; ch++) {
            vec2 s = inRect(qmap(vec2(uv.x - k[ch] * (z - focus), uv.y)));
            c[ch] = texture(tex, colorUV(s))[ch];
        }
        return c;
    }

    float sg = uv.x - kg * (z - focus);       // where green's ray ended
    float dir = kg >= 0.0 ? 1.0 : -1.0;       // rays slide this way going deeper; a gap's background is at -dir
    float tq = texelQ();

    // fill modes: did green's ray hit the SIDE of a depth step (a revealed gap)? look 5 px either side
    float hole = 0.0, dF = z, zBg = z;
    bool shortFill = false;
    if (edgeFix >= 2 && abs(kg) > 1e-5) {
        float dB = depthAt(vec2(sg - dir * 5.0 * tq, uv.y));
        dF = depthAt(vec2(sg + dir * 5.0 * tq, uv.y));
        hole = smoothstep(0.03, 0.08, dF - z) * smoothstep(0.04, 0.08, dF - dB);
        zBg = min(dB, z);
        if (hole > 0.0) {   // never mirror another near thing into the gap
            float sFill = sg - dir * max(abs(kg) * (z - zBg), 2.0 * tq);
            shortFill = depthAt(vec2(sFill, uv.y)) > zBg + 0.1;
        }
    }

    for (int ch = 0; ch < 3; ch++) {
        float kc = k[ch];
        float sx = uv.x - kc * (z - focus);      // the original: green's depth
        if (ch != 1) {
            // does this channel's OWN ray end on that surface? one fixed-point step: z -> d0 -> d1
            float d0 = depthAt(vec2(sx, uv.y));
            float s1 = uv.x - kc * (d0 - focus);
            float d1 = depthAt(vec2(s1, uv.y));
            float dz = d0 - z;
            if (abs(d1 - d0) < max(0.03, 0.5 * abs(dz))) {
                // it settles: the same surface, or the nearer/farther one its own ray really meets; one secant step onto it
                float m = abs(dz) > 1e-3 ? (d1 - d0) / dz : 0.0;
                sx = uv.x - kc * (z + dz / clamp(1.0 - m, 1.0, 8.0) - focus);
            } else {
                // its own ray fell into its own revealed gap
                sx = (edgeFix == 1 && kc * kg > 0.0) ? sg : (d0 < d1 ? sx : s1);   // clean colours: green's spot; fill: the nearer background
            }
        }
        if (hole > 0.0 && kc * kg > 0.0) {
            // green is in a gap: solve this channel on a clean step (top dF, floor zBg, edge at sg)
            float sTop = uv.x - kc * (dF - focus);
            float sGap = sTop;                                   // its ray clears the top: it sees the subject
            if (dir * (sTop - sg) < 0.0) {
                float uc = abs((uv.x - sg) - kc * (zBg - focus));  // how far from the edge its ray meets the background
                sGap = sg - dir * (shortFill ? 2.0 * tq : clamp(uc, 2.0 * tq, max(abs(kg) * (z - zBg), 2.0 * tq)));   // mirror the background into the gap
            }
            sx = mix(sx, sGap, hole);
        }
        c[ch] = colourAt(sx, uv.y, ch);
    }
    return c;
}
// ---- end 3D edge fixing ------------------------------------------------------------------

// Which view each subpixel shows, 0..1 across the cone (0 = leftmost camera).
vec3 subpixelViews(vec2 s, float nViews) {
    vec3 x = s.x + subpixelSize * vec3(0.0, 1.0, 2.0);
    vec3 phase = (x + s.y * slope) * pitch - center + 0.5 / nViews;
    vec3 v = clamp(1.0 - fract(phase), 0.00001, 0.99999);
    return invView == 1 ? 1.0 - v : v;
}

float seamFade(float v) { return smoothstep(0.06, 0.15, min(v, 1.0 - v)); }

void main() {
    vec3 vl = subpixelViews(v_screen_uv, max(tile.x * tile.y, 1.0));

    // while a quarter turn animates, the corners of the shown picture fall outside the video: black
    vec2 muv = qmap(v_uv);
    bool onPicture = all(greaterThanEqual(muv, contentRect.xy)) && all(lessThanEqual(muv, contentRect.zw));
    vec3 col = onPicture ? rgbdColor(v_uv, vl) : vec3(0.0);
    if (filter_edge) col *= vec3(seamFade(vl.r), seamFade(vl.g), seamFade(vl.b));
    color = vec4(col, 1.0);
}
