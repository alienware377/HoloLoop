#version 300 es
// A quilt (a grid of camera views, bottom-left first) shown through the Go's lenses.
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
in vec2 v_screen_uv;

uniform sampler2D tex;
uniform float pitch;        // lens periods across the screen width
uniform float slope;        // lens tilt
uniform float center;       // lens offset
uniform float subpixelSize; // one subpixel in screen widths (negative when the panel is mirrored)
uniform vec4 tile;          // x = columns, y = rows
uniform vec2 view_portion;  // part of the texture the quilt covers
uniform bool filter_edge;   // soften the seam where the view cone wraps round
uniform int invView;        // 1 = reverse the view order

out vec4 color;

// Which view each subpixel shows, 0..1 across the cone (0 = leftmost camera).
vec3 subpixelViews(vec2 s, float nViews) {
    vec3 x = s.x + subpixelSize * vec3(0.0, 1.0, 2.0);
    vec3 phase = (x + s.y * slope) * pitch - center + 0.5 / nViews;
    vec3 v = clamp(1.0 - fract(phase), 0.00001, 0.99999);
    return invView == 1 ? 1.0 - v : v;
}

float seamFade(float v) { return smoothstep(0.06, 0.15, min(v, 1.0 - v)); }

// one channel of quilt view n at this point of the picture
float viewChannel(float n, int ch) {
    float row = floor((n + 0.5) / tile.x);
    vec2 cell = vec2(n - row * tile.x, row);
    return textureLod(tex, (cell + v_uv) / tile.xy * view_portion, 0.0)[ch];
}

void main() {
    float n = tile.x * tile.y;
    vec3 v = subpixelViews(v_screen_uv, n);
    vec3 f = v * n;
    vec3 c;
    for (int ch = 0; ch < 3; ch++) {
        float a = floor(f[ch]);
        c[ch] = mix(viewChannel(mod(a, n), ch), viewChannel(mod(a + 1.0, n), ch), f[ch] - a);
    }
    if (filter_edge) c *= vec3(seamFade(v.r), seamFade(v.g), seamFade(v.b));
    color = vec4(c, 1.0);
}
