import { GLSL_ALPHA_QUANTUM, GLSL_FALLOFF_PREVIEW, GLSL_FETCH_DIST, GLSL_FETCH_OPACITY } from "./glslUtils";

export const edgeFragmentShaderSource = `#version 300 es
precision highp float;
in vec3 v_colorStart;
in vec3 v_colorEnd;
in float v_lastIndex;
in float v_nextIndex;
in float v_startPct;
in float v_endPct;
in float v_t;

uniform float u_opacityThreshold;
uniform float u_minOpacity;
uniform float u_maxOpacity;
uniform bool u_applyGrayBelowThreshold;
uniform float u_opacityMix;
uniform sampler2D u_opacityFieldTex;
uniform vec2 u_opacityFieldTexDim;  // (width, height) in texels

// GPU falloff preview (issue #315): per-endpoint preview DoI, same record-index
// frozen-chain texture as the node pass. mode 0 = off ⇒ ignored, so edges
// stay byte-identical to the opacity-texture-only path.
uniform int u_falloffMode;
uniform int u_falloffShape;
uniform float u_falloffSScaled;
uniform float u_falloffInvMaxEmb;
// RELEASE CROSS-FADE (see node.frag): 0 = preview, 1 = committed texture.
uniform float u_falloffBlend;
uniform sampler2D u_distFieldTex;
uniform vec2 u_distFieldTexDim;

out vec4 outColor;

${GLSL_ALPHA_QUANTUM}
${GLSL_FETCH_OPACITY}
${GLSL_FETCH_DIST}
${GLSL_FALLOFF_PREVIEW}

void main() {
  float opacityLast = fetchOpacity(v_lastIndex);
  float opacityNext = fetchOpacity(v_nextIndex);

  // The per-endpoint preview REPLACES the committed opacity so edges track the
  // node pass during a falloff drag (issue #315), in both slider directions —
  // see node.frag for why a max() could only ever raise values. Endpoints are
  // node indices, same as the opacity lookup.
  if (u_falloffMode != 0) {
    opacityLast = mix(previewDoi(fetchFrozenChain(v_lastIndex), u_falloffShape, u_falloffSScaled, u_falloffInvMaxEmb, u_falloffMode), opacityLast, u_falloffBlend);
    opacityNext = mix(previewDoi(fetchFrozenChain(v_nextIndex), u_falloffShape, u_falloffSScaled, u_falloffInvMaxEmb, u_falloffMode), opacityNext, u_falloffBlend);
  }

  float opacityStart = mix(opacityLast, opacityNext, clamp(v_startPct, 0.0, 1.0));
  float opacityEnd   = mix(opacityLast, opacityNext, clamp(v_endPct,   0.0, 1.0));
  float opacity      = mix(opacityStart, opacityEnd, clamp(v_t, 0.0, 1.0));

  bool isGray = opacity < u_opacityThreshold;
  float colorT = mix(clamp(v_startPct, 0.0, 1.0), clamp(v_endPct, 0.0, 1.0), clamp(v_t, 0.0, 1.0));
  vec3 base = mix(v_colorStart, v_colorEnd, colorT);
  vec3 color = (u_applyGrayBelowThreshold && isGray) ? vec3(0.5) : base;

  float denom = max(1.0 - u_opacityThreshold, 1e-6);
  float tt = clamp((opacity - u_opacityThreshold) / denom, 0.0, 1.0);
  float alpha = isGray ? u_minOpacity : mix(u_minOpacity, u_maxOpacity, tt);
  if (alpha <= 0.0001) discard;
  // #315: sub-quantum floor — see GLSL_ALPHA_QUANTUM (edges are solid quads,
  // no AA coverage term to preserve).
  alpha = max(alpha, ALPHA_QUANTUM);
  // Straight (non-premultiplied) alpha output (issue #315 §10.3): RGB is the
  // literal edge color, alpha the coverage; blended with
  // blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA). See node.frag for why.
  outColor = vec4(color, alpha);
}`;
