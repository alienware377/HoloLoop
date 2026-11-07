#version 300 es
// Full-screen quad for the lenticular passes. quad_scale (fit / fill / zoom) is worked
// out on the CPU; v_uv runs over the picture and v_screen_uv over the panel.
precision highp float;

in vec2 position;
uniform vec2 quad_scale;
uniform vec2 crop_pos;

out vec2 v_uv;
out vec2 v_screen_uv;

void main() {
    vec2 p = position * quad_scale - crop_pos;
    v_uv = position * 0.5 + 0.5;
    v_screen_uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
