import { GLSL_FETCH_EMPHASIS } from "./glslUtils";

export const edgeQuadVertexShaderSource = `#version 300 es
in vec2 a_start;
in vec2 a_end;
in vec2 a_corner;
in vec3 a_colorStart;
in vec3 a_colorEnd;
in float a_lastIndex;
in float a_nextIndex;
in float a_startPct;
in float a_endPct;

uniform mat3 u_matrix;
uniform vec2 u_resolution;
uniform float u_edgeWidth;
uniform sampler2D u_emphasisFieldTex;
uniform vec2 u_emphasisFieldTexDim;
uniform float u_emphasisScale;

out vec3 v_colorStart;
out vec3 v_colorEnd;
out float v_lastIndex;
out float v_nextIndex;
out float v_startPct;
out float v_endPct;
out float v_t;

${GLSL_FETCH_EMPHASIS}

void main() {
  vec3 clipStart = u_matrix * vec3(a_start, 1.0);
  vec3 clipEnd   = u_matrix * vec3(a_end,   1.0);

  float t = (a_corner.x + 1.0) * 0.5;
  vec2 pos = mix(clipStart.xy, clipEnd.xy, t);

  vec2 screenStart = (clipStart.xy * 0.5 + 0.5) * u_resolution;
  vec2 screenEnd   = (clipEnd.xy   * 0.5 + 0.5) * u_resolution;
  vec2 dir = normalize(screenEnd - screenStart);
  vec2 perp = vec2(-dir.y, dir.x);

  // Scale edge width by the maximum emphasis of the two endpoint nodes.
  float emph = max(fetchEmphasis(a_lastIndex), fetchEmphasis(a_nextIndex));
  float scaledWidth = u_edgeWidth * (1.0 + u_emphasisScale * emph);
  float offsetPixels = a_corner.y * (scaledWidth * 0.5);
  vec2 offsetClip = perp * (offsetPixels * 2.0 / u_resolution);

  gl_Position = vec4(pos + offsetClip, 0.0, 1.0);

  v_colorStart = a_colorStart;
  v_colorEnd   = a_colorEnd;
  v_lastIndex  = a_lastIndex;
  v_nextIndex  = a_nextIndex;
  v_startPct   = a_startPct;
  v_endPct     = a_endPct;
  v_t          = t;
}`;
