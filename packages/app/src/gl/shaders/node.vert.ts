import { GLSL_FALLOFF_PREVIEW, GLSL_FETCH_DIST, GLSL_FETCH_OPACITY } from "./glslUtils";

export const nodeVertexShaderSource = `#version 300 es
in vec2 a_position;
in vec3 a_baseColor;
in float a_opacityField;
in float a_emphasisField;
uniform float u_nodeRadiusPx;
uniform float u_emphasisScale;
uniform mat3 u_matrix;

// GPU falloff preview (issue #315). The frozen-chain field is a second RGBA32F
// texture with the SAME record-index W×H mapping as the opacity field
// (D, source distance, chain gain, seed chain); the node index is gl_VertexID
// (nodes draw as gl.POINTS 0..nodeCount-1, i.e. record order).
// mode 0 = preview off ⇒ v_spatialField stays 0 and node.frag ignores it, so
// the non-preview path is byte-identical to before.
uniform int u_falloffMode;
uniform int u_falloffShape;
uniform float u_falloffSScaled;
uniform float u_falloffInvMaxEmb;
uniform sampler2D u_distFieldTex;
uniform vec2 u_distFieldTexDim;

// GPU motion lane (plan-gpu-motion-lane.md): while a converged motion tick
// owns the opacity TEXTURE (the edges/arrows' source of truth already), the
// node pass reads it too instead of the CPU-uploaded VBO attribute — the
// texture is GPU-written, the VBO is stale until the next exact CPU flush.
// 0 keeps the attribute path byte-identical to before.
uniform int u_opacityFromTex;
uniform sampler2D u_opacityFieldTex;
uniform vec2 u_opacityFieldTexDim;

out vec3 v_baseColor;
out float v_opacityField;
out float v_spatialField;

${GLSL_FETCH_DIST}
${GLSL_FALLOFF_PREVIEW}
${GLSL_FETCH_OPACITY}

void main() {
  vec3 pos = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  gl_PointSize = u_nodeRadiusPx * (1.0 + u_emphasisScale * a_emphasisField);
  v_baseColor = a_baseColor;
  v_opacityField = u_opacityFromTex != 0
    ? fetchOpacity(float(gl_VertexID))
    : a_opacityField;

  // Preview DoI evaluated here so a drag tick costs uniform writes, not a
  // 4 MB opacity re-upload (issue #315): the frozen trajectory chain remapped
  // through the live falloff (see previewDoi). Inactive ⇒ 0.
  float sp = 0.0;
  if (u_falloffMode != 0) {
    vec4 fc = fetchFrozenChain(float(gl_VertexID));
    sp = previewDoi(fc, u_falloffShape, u_falloffSScaled, u_falloffInvMaxEmb, u_falloffMode);
  }
  v_spatialField = sp;
}`;
