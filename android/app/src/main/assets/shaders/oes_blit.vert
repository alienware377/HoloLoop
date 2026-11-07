#version 300 es
precision highp float;
in vec2 position;
uniform mat4 stMatrix;
out vec2 v_uv;
void main() {
    vec2 uv = position * 0.5 + 0.5;
    v_uv = (stMatrix * vec4(uv, 0.0, 1.0)).xy;
    gl_Position = vec4(position, 0.0, 1.0);
}
