import { GLSL_ALPHA_QUANTUM } from "./glslUtils";

export const nodeFragmentShaderSource = `#version 300 es
precision highp float;
// u_falloffMode (int) is shared with node.vert, where ints default to highp;
// the fragment stage's int default differs, so pin it or program linking fails
// with a precision-mismatch error (issue #315).
precision highp int;
in vec3 v_baseColor;
in float v_opacityField;
// GPU falloff preview (issue #315): the shader-evaluated preview DoI from
// node.vert. u_falloffMode 0 = preview off ⇒ ignored, path is byte-identical.
in float v_spatialField;
uniform int u_falloffMode;
// RELEASE CROSS-FADE (issue #315, CS 2026-07-26): 0 = pure preview (the drag),
// 1 = pure committed opacity texture. Animated 0→1 over ~150 ms when a commit
// lands so the field does not step in a single frame; the fade ENDS by setting
// u_falloffMode back to 0, which is the exact committed field, not a lerp of it.
uniform float u_falloffBlend;
uniform float u_opacityThreshold;
uniform float u_minOpacity;
uniform float u_maxOpacity;
uniform bool u_applyGrayBelowThreshold;
uniform float u_nodeRadiusPx;
uniform float u_nodeOutlineWidthPx;
// When true the node outline is drawn white; otherwise black (the default).
uniform bool u_nodeOutlineWhite;
${GLSL_ALPHA_QUANTUM}
out vec4 outColor;
void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);

  // Anti-aliased circle edge: 1-pixel smooth falloff instead of a hard clip.
  float aa = fwidth(dist);
  float circleAlpha = 1.0 - smoothstep(0.5 - aa, 0.5, dist);
  if (circleAlpha <= 0.001) discard;

  // While the preview is active it REPLACES the opacity texture for gray +
  // alpha. It must not be max()'d with it: the texture holds the COMMITTED
  // field, which already contains the committed spatial term, so a max could
  // only ever raise values and dragging the proximity slider DOWN previewed
  // nothing (CS 2026-07-26). v_spatialField is the full preview DoI — the
  // frozen chain (seed clamp and trajectory cascade included) remapped through
  // the live falloff — so replacing is also the more complete signal. Preview
  // off (mode 0) ⇒ the exact v_opacityField expression as before.
  // u_falloffBlend stays 0 for the whole drag, so this is the plain preview
  // until a commit starts its cross-fade toward the texture.
  float field = (u_falloffMode != 0)
    ? mix(v_spatialField, v_opacityField, u_falloffBlend)
    : v_opacityField;

  bool isGray = field < u_opacityThreshold;
  vec3 color = (u_applyGrayBelowThreshold && isGray) ? vec3(0.5) : v_baseColor;

  float denom = max(1.0 - u_opacityThreshold, 1e-6);
  float t = clamp((field - u_opacityThreshold) / denom, 0.0, 1.0);
  float alpha = isGray ? u_minOpacity : mix(u_minOpacity, u_maxOpacity, t);
  // #315: floor a strictly-positive sub-quantum alpha BEFORE the AA coverage
  // multiply (see GLSL_ALPHA_QUANTUM for why this survives the 16F target).
  alpha = alpha > 0.0 ? max(alpha, ALPHA_QUANTUM) : 0.0;
  alpha *= circleAlpha;

  // Anti-aliased outline: smooth transition instead of a hard boundary.
  vec3 finalColor = color;
  if (u_nodeOutlineWidthPx > 0.0) {
    float innerBoundary = 0.5 - (u_nodeOutlineWidthPx / max(u_nodeRadiusPx, 1e-6));
    float outlineFraction = smoothstep(innerBoundary - aa, innerBoundary + aa, dist);
    vec3 outlineColor = u_nodeOutlineWhite ? vec3(1.0) : vec3(0.0);
    finalColor = mix(color, outlineColor, outlineFraction);
  }

  // Straight (non-premultiplied) alpha output (issue #315 §10.3): the RGB is the
  // literal point color and alpha is the coverage; the scene blends with
  // blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA). Premultiplied output
  // (color*alpha) quantized the smallest channel away first at low alpha over
  // heavy overdraw — the emerald→cyan cast CS reported. Straight alpha lets the
  // blender multiply at full precision, one rounding step per composite.
  outColor = vec4(finalColor, alpha);
}`;
