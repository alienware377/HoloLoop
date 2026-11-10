#version 300 es
// Steady edges: the converter's depth wobbles from frame to frame, so silhouettes
// shake at side views. Where the colour around a depth texel has not changed since
// the last frame, its depth only creeps toward the new value ([still]); where it
// changed (motion, a cut) it takes a bigger share ([moving], 1 = the new depth at once).
// The edge of something moving against the background wobbles the most, so it is
// smoothed too, only lighter, or the depth would trail behind.
// The stored depth is rounded to whole 8-bit levels on purpose: a still spot only moves
// once the new depth is a few levels away, which keeps it extra calm (the 3D shader reads r).
// Kept in step: HoloLoop PC src/player/shaders.js STEADY and the phone's steady.frag.
precision highp float;
precision highp sampler2D;
uniform sampler2D cur;     // this frame (colour + depth), v=0 is the bottom
uniform sampler2D prev;    // the last steadied frame, same layout (its colour half = last frame's colour)
uniform int depthLoc;      // 0 top, 1 bottom, 2 right, 3 left
uniform float still;       // share of the new depth a still spot takes per frame (1 = start over)
uniform float moving;      // the same where the picture moved
uniform vec2 texel;        // 1 / frame size in pixels (the pass runs at the video's real size)
out vec4 color;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 now = texture(cur, uv);
  vec2 off = depthLoc == 0 ? vec2(0.0, -0.5) : depthLoc == 1 ? vec2(0.0, 0.5) : depthLoc == 2 ? vec2(-0.5, 0.0) : vec2(0.5, 0.0);
  vec2 c = uv + off;       // the colour pixel that goes with this depth pixel
  bool inDepth = all(greaterThanEqual(c, vec2(0.0))) && all(lessThanEqual(c, vec2(1.0)));
  if (!inDepth) { color = now; return; }                       // colour half: passed through
  if (still >= 1.0) { color = vec4(vec3(now.r), 1.0); return; }

  // did the picture move within 6 px? (depth edges sit a few px off the colour edges)
  vec2 lo = (depthLoc == 3 ? vec2(0.5, 0.0) : depthLoc == 1 ? vec2(0.0, 0.5) : vec2(0.0)) + 1.5 * texel;
  vec2 hi = (depthLoc == 2 ? vec2(0.5, 1.0) : depthLoc == 0 ? vec2(1.0, 0.5) : vec2(1.0)) - 1.5 * texel;
  float motion = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      // +0.5 px: the bilinear read averages 2x2 pixels, so video grain counts less
      vec2 q = clamp(c + (vec2(float(i), float(j)) * 3.0 + 0.5) * texel, lo, hi);
      motion = max(motion, abs(luma(texture(cur, q).rgb) - luma(texture(prev, q).rgb)));
    }
  }
  float a = mix(still, moving, smoothstep(0.03, 0.10, motion));
  float z = floor(mix(texture(prev, uv).r, now.r, a) * 255.0 + 0.5) / 255.0;   // round ourselves: same on every GPU
  color = vec4(vec3(z), 1.0);
}
