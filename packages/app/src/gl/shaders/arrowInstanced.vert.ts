import { GLSL_EDGE_INSTANCE_COMMON } from "./glslUtils";

// Instanced arrow heads (issue #315 phase B2).
//
// One instance per EDGE (the arrow sits on the last spline sample of each
// edge, exactly where the CPU path's segArrow flag put it). Layout:
//
//   a_offset        static 3-vertex triangle in arrow-local units
//                   (0,0),(-0.5,1),(0.5,1) — the only vertex attribute,
//                   matching the CPU buildArrowsGeometry offsets.
//   gl_InstanceID   the edge index; controls come from u_edgeCtrlTex (see
//                   GLSL_EDGE_INSTANCE_COMMON in glslUtils). Edges with
//                   unresolved endpoints (ctrl.y < 0) and zero-length last
//                   segments emit degenerate, mirroring the CPU skip.
//
// Tip = spline at t=1, rotation from the last segment's DATA-space chord
// (evaluated at (S-1)/S → 1), color = end node's color, endPct = 1 —
// all verbatim ports of buildArrowsGeometry + fillArrowColors semantics.
// arrow.frag is shared unchanged.
export const arrowInstancedVertexShaderSource = `#version 300 es
in vec2 a_offset;

uniform mat3 u_matrix;
uniform vec2 u_resolution;
uniform float u_arrowLengthPx;

uniform sampler2D u_nodePosTex;
uniform sampler2D u_nodeColorTex;
uniform sampler2D u_edgeCtrlTex;
uniform int u_texWidthNodes;
uniform int u_texWidthEdges;
uniform int u_samplesPerEdge;

out vec3 v_color;
out float v_lastIndex;
out float v_nextIndex;
out float v_endPct;

${GLSL_EDGE_INSTANCE_COMMON}

void main() {
  vec4 ctrl = fetchEdgeCtrl(gl_InstanceID);
  if (ctrl.y < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 p0 = fetchNodePos(int(ctrl.x + 0.5));
  vec2 p1 = fetchNodePos(int(ctrl.y + 0.5));
  vec2 p2 = fetchNodePos(int(ctrl.z + 0.5));
  vec2 p3 = fetchNodePos(int(ctrl.w + 0.5));

  float S = float(u_samplesPerEdge);
  vec2 segStart = catmullRom((S - 1.0) / S, p0, p1, p2, p3);
  vec2 tip = catmullRom(1.0, p0, p1, p2, p3);
  vec2 d = tip - segStart;
  if (d == vec2(0.0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float rotation = atan(d.y, d.x) + 1.5707963267948966;

  vec3 clipTip = u_matrix * vec3(tip, 1.0);
  float s = sin(rotation);
  float c = cos(rotation);
  vec2 scaledOffset = a_offset * u_arrowLengthPx;
  vec2 rotatedOffset = vec2(
    scaledOffset.x * c - scaledOffset.y * s,
    scaledOffset.x * s + scaledOffset.y * c
  );
  vec2 offsetClip = (rotatedOffset / u_resolution) * 2.0;
  gl_Position = vec4(clipTip.xy + offsetClip, 0.0, 1.0);

  v_color = fetchNodeColor(int(ctrl.z + 0.5));
  v_lastIndex = ctrl.y;
  v_nextIndex = ctrl.z;
  v_endPct = 1.0;
}`;
