import { GLSL_ALPHA_QUANTUM, GLSL_FETCH_OPACITY } from "./glslUtils";

export const arrowFragmentShaderSource = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_lastIndex;
in float v_nextIndex;
in float v_endPct;

uniform float u_opacityThreshold;
uniform float u_minOpacity;
uniform float u_maxOpacity;
uniform bool u_applyGrayBelowThreshold;
uniform float u_opacityMix;
uniform sampler2D u_opacityFieldTex;
uniform vec2 u_opacityFieldTexDim;

out vec4 outColor;

${GLSL_ALPHA_QUANTUM}
${GLSL_FETCH_OPACITY}

void main() {
  float opacityLast = fetchOpacity(v_lastIndex);
  float opacityNext = fetchOpacity(v_nextIndex);
  float opacity = mix(opacityLast, opacityNext, clamp(v_endPct, 0.0, 1.0));

  bool isGray = opacity < u_opacityThreshold;
  vec3 color = (u_applyGrayBelowThreshold && isGray) ? vec3(0.5) : v_color;

  float denom = max(1.0 - u_opacityThreshold, 1e-6);
  float t = clamp((opacity - u_opacityThreshold) / denom, 0.0, 1.0);
  float alpha = isGray ? u_minOpacity : mix(u_minOpacity, u_maxOpacity, t);
  if (alpha <= 0.0001) discard;
  // #315: sub-quantum floor — see GLSL_ALPHA_QUANTUM (solid geometry, no AA
  // coverage term). Matches edge.frag / node.frag.
  alpha = max(alpha, ALPHA_QUANTUM);
  // Straight (non-premultiplied) alpha output (issue #315 §10.3): RGB is the
  // literal arrow color, alpha the coverage; blended with
  // blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA). See node.frag for why.
  outColor = vec4(color, alpha);
}`;
