import { GLSL_EDGE_INSTANCE_COMMON, GLSL_FETCH_EMPHASIS } from "./glslUtils";

// Instanced edge tessellation (issue #315 phase B2).
//
// One instance per spline SEGMENT — nothing per-segment exists on the CPU
// (the old path expanded 4 verts × 16 floats per segment, a ~5 GB
// allocation at 1M points). Attribute/uniform layout:
//
//   a_corner        static 4-vertex TRIANGLE_STRIP quad corner
//                   (-1,1),(-1,-1),(1,1),(1,-1) — the only vertex attribute.
//   gl_InstanceID   edge = id / u_samplesPerEdge, sample = id % u_samplesPerEdge
//                   (segments of an edge are consecutive instances, so a
//                   prefix instanceCount clips edges exactly like the old
//                   prefix segment count).
//   u_edgeCtrlTex   RGBA32F, one texel per edge: renderer node indices of the
//                   Catmull-Rom controls p0,p1,p2,p3 (clamped at trajectory
//                   ends, matching computeSplineColumns). p1 < 0 marks an
//                   edge whose endpoints aren't resident yet → emitted
//                   degenerate (offscreen).
//   u_nodePosTex    RG32F, one texel per node — data-space positions. The
//                   spline is evaluated HERE, so geometry stays
//                   O(points)+O(edges) and u_samplesPerEdge is a live uniform.
//   u_nodeColorTex  RGBA32F, one texel per node — per-node base color,
//                   replacing the CPU fillEdgeColors rewrite of the big
//                   vertex array.
//
// Width / emphasis / opacity semantics are copied verbatim from
// edgeQuad.vert; the v_* varyings match, so edge.frag is shared unchanged.
export const edgeInstancedVertexShaderSource = `#version 300 es
in vec2 a_corner;

uniform mat3 u_matrix;
uniform vec2 u_resolution;
uniform float u_edgeWidth;
uniform sampler2D u_emphasisFieldTex;
uniform vec2 u_emphasisFieldTexDim;
uniform float u_emphasisScale;

uniform sampler2D u_nodePosTex;
uniform sampler2D u_nodeColorTex;
uniform sampler2D u_edgeCtrlTex;
uniform int u_texWidthNodes;
uniform int u_texWidthEdges;
uniform int u_samplesPerEdge;

out vec3 v_colorStart;
out vec3 v_colorEnd;
out float v_lastIndex;
out float v_nextIndex;
out float v_startPct;
out float v_endPct;
out float v_t;

${GLSL_FETCH_EMPHASIS}
${GLSL_EDGE_INSTANCE_COMMON}

void main() {
  int edge = gl_InstanceID / u_samplesPerEdge;
  int s = gl_InstanceID - edge * u_samplesPerEdge;

  vec4 ctrl = fetchEdgeCtrl(edge);
  if (ctrl.y < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 p0 = fetchNodePos(int(ctrl.x + 0.5));
  vec2 p1 = fetchNodePos(int(ctrl.y + 0.5));
  vec2 p2 = fetchNodePos(int(ctrl.z + 0.5));
  vec2 p3 = fetchNodePos(int(ctrl.w + 0.5));

  float S = float(u_samplesPerEdge);
  float startPct = float(s) / S;
  float endPct = float(s + 1) / S;
  vec2 segStart = catmullRom(startPct, p0, p1, p2, p3);
  vec2 segEnd = catmullRom(endPct, p0, p1, p2, p3);

  vec3 clipStart = u_matrix * vec3(segStart, 1.0);
  vec3 clipEnd   = u_matrix * vec3(segEnd,   1.0);

  float t = (a_corner.x + 1.0) * 0.5;
  vec2 pos = mix(clipStart.xy, clipEnd.xy, t);

  vec2 screenStart = (clipStart.xy * 0.5 + 0.5) * u_resolution;
  vec2 screenEnd   = (clipEnd.xy   * 0.5 + 0.5) * u_resolution;
  vec2 dir = normalize(screenEnd - screenStart);
  vec2 perp = vec2(-dir.y, dir.x);

  // Scale edge width by the maximum emphasis of the two endpoint nodes.
  float emph = max(fetchEmphasis(ctrl.y), fetchEmphasis(ctrl.z));
  float scaledWidth = u_edgeWidth * (1.0 + u_emphasisScale * emph);
  float offsetPixels = a_corner.y * (scaledWidth * 0.5);
  vec2 offsetClip = perp * (offsetPixels * 2.0 / u_resolution);

  gl_Position = vec4(pos + offsetClip, 0.0, 1.0);

  v_colorStart = fetchNodeColor(int(ctrl.y + 0.5));
  v_colorEnd   = fetchNodeColor(int(ctrl.z + 0.5));
  v_lastIndex  = ctrl.y;
  v_nextIndex  = ctrl.z;
  v_startPct   = startPct;
  v_endPct     = endPct;
  v_t          = t;
}`;
