export const arrowVertexShaderSource = `#version 300 es
in vec2 a_tipPosition;
in float a_rotation;
in vec2 a_offset;
in vec3 a_color;
in float a_lastIndex;
in float a_nextIndex;
in float a_endPct;

uniform mat3 u_matrix;
uniform vec2 u_resolution;
uniform float u_arrowLengthPx;

out vec3 v_color;
out float v_lastIndex;
out float v_nextIndex;
out float v_endPct;

void main() {
  vec3 clipTip = u_matrix * vec3(a_tipPosition, 1.0);
  float s = sin(a_rotation);
  float c = cos(a_rotation);
  vec2 scaledOffset = a_offset * u_arrowLengthPx;
  vec2 rotatedOffset = vec2(
    scaledOffset.x * c - scaledOffset.y * s,
    scaledOffset.x * s + scaledOffset.y * c
  );
  vec2 offsetClip = (rotatedOffset / u_resolution) * 2.0;
  gl_Position = vec4(clipTip.xy + offsetClip, 0.0, 1.0);
  v_color = a_color;
  v_lastIndex = a_lastIndex;
  v_nextIndex = a_nextIndex;
  v_endPct = a_endPct;
}`;
