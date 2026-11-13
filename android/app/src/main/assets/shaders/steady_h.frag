#version 300 es
// Steady edges, first half of the motion search (see steady.frag). For each depth pixel: the
// biggest colour change at the 5 spots 3 px apart along its row that steady.frag looks at.
// steady.frag then takes the biggest of 5 of these, 3 rows apart, instead of reading 25 pairs.
// Written to a float texture, so the values are exactly the ones steady.frag would get itself.
precision highp float;
precision highp sampler2D;
uniform sampler2D cur;     // this frame (colour + depth), v=0 is the bottom
uniform sampler2D prev;    // the last steadied frame, same layout
uniform int depthLoc;      // 0 top, 1 bottom, 2 right, 3 left
uniform vec2 texel;        // 1 / frame size in pixels
out vec4 color;            // r = the row's motion

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = gl_FragCoord.xy * texel;
  vec2 off = depthLoc == 0 ? vec2(0.0, -0.5) : depthLoc == 1 ? vec2(0.0, 0.5) : depthLoc == 2 ? vec2(-0.5, 0.0) : vec2(0.5, 0.0);
  vec2 c = uv + off;
  vec2 lo = (depthLoc == 3 ? vec2(0.5, 0.0) : depthLoc == 1 ? vec2(0.0, 0.5) : vec2(0.0)) + 1.5 * texel;
  vec2 hi = (depthLoc == 2 ? vec2(0.5, 1.0) : depthLoc == 0 ? vec2(1.0, 0.5) : vec2(1.0)) - 1.5 * texel;
  float motion = 0.0;
  for (int i = -2; i <= 2; i++) {
    vec2 q = clamp(c + (vec2(float(i), 0.0) * 3.0 + 0.5) * texel, lo, hi);
    motion = max(motion, abs(luma(texture(cur, q).rgb) - luma(texture(prev, q).rgb)));
  }
  color = vec4(motion, 0.0, 0.0, 1.0);
}
