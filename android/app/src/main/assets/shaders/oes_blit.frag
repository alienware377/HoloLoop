#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
in vec2 v_uv;
uniform samplerExternalOES tex;
layout(location = 0) out vec4 color;
layout(location = 1) out vec4 depthCopy;   // r again, for the one-channel copy the 3D shader reads depth from
void main() {
    color = texture(tex, v_uv);
    depthCopy = vec4(color.r);
}
