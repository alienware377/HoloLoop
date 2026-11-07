#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
in vec2 v_uv;
uniform samplerExternalOES tex;
out vec4 color;
void main() {
    color = texture(tex, v_uv);
}
