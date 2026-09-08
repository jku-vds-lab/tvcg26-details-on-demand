// packages/app/src/gl/shaders/convergedMotion.ts
//
// Pass sources for the GPU motion lane (plan-gpu-motion-lane.md): the
// converged chain ↔ re-spread alternation of doiPropagation/convergedField.ts
// executed in fragment passes during slider MOTION, f32, always superseded by
// the exact CPU flush at rest/release. The CPU engine is the semantic
// authority — every formula here mirrors a named CPU twin:
//
//   falloffPreview (GLSL_FALLOFF_PREVIEW)  ←→ evalFalloffPreviewParams
//   falloffInvDist                          ←→ falloff.ts falloffInverse
//   chain pass                              ←→ chainJumpTables.simulateDoublingChainScan
//   chamferD closed form                    ←→ respreadDistanceSweep's path metric
//   gather bilinear + inf-guard             ←→ fieldDistanceCore.bilinearSampleDist
//
// TEXTURE LAYOUTS (uniform/attribute contract, per repo convention):
//  Record-space textures share the opacity texture's record-index W×H mapping
//  (idx = y·W + x). No vertex attributes anywhere — records address by
//  gl_VertexID (scatter) / gl_FragCoord (quads):
//   u_dist   R32F   recordDist, +Inf sanitized to the 1e30 sentinel
//   u_seed   R32F   1 = seed-clamped record (selection flags)
//   u_raster RGBA32F (fcol, frow, col, row) — fractional + rounded grid cell
//   u_jump   R32I   pointer-doubling table, level-major: texel (x, y + level·H)
//   u_v      R32F   the ping-pong field value
//  Grid-space textures use the CPU raster's dims (u_gridW × u_gridH):
//   u_grid   RGBA32F candidate source per cell: (col, row, offsetD, occupied)
//
// The scatter pass resolves co-cell sources to the MIN offset (the model's
// min-plus semantics) via the depth test: depth = offset / maxDist. The
// re-spread distance is the exact chamfer closed form — on the barrier-free
// grid (the client lane's only regime) chamfer(Δ) = √2·cellSize·min(|Δr|,|Δc|)
// + cellSize·(max−min), so the multi-source sweep reduces to a nearest-source
// problem and JUMP FLOODING approximates only the argmin topology, never the
// metric.

import { GLSL_FALLOFF_PREVIEW } from "./glslUtils";

/** Sentinel for "no source / cropped" distances — matches DIST_SENTINEL /
 * FALLOFF_DIST_SENTINEL; compares use ≥ 1e29 (sentinel/10) like the GLSL
 * preview's ≥ SENTINEL/2 guard.
 *
 * Grid candidates are PACKED RG32F — (packedCell = srow·gridW + scol,
 * offset), packedCell < 0 = empty — because the JFA is bandwidth-bound
 * (9 taps × grid × passes × rounds): halving the texel size halved the
 * measured tick time on iGPUs. packedCell stays exactly representable
 * (< 2^24) and the decode's `(p + 0.5)/W` floor is rounding-safe for
 * col ∈ [0, W). */
const GLSL_CHAMFER = /* glsl */ `
const float D_INF = 1.0e30;
float chamferD(vec2 fromCell, vec2 cand, float cellSize, float gridW) {
  if (cand.x < 0.0) return D_INF;
  float srow = floor((cand.x + 0.5) / gridW);
  float scol = cand.x - srow * gridW;
  vec2 dd = abs(fromCell - vec2(scol, srow));
  float mn = min(dd.x, dd.y);
  float mx = max(dd.x, dd.y);
  return cand.y + cellSize * (1.4142135623730951 * mn + (mx - mn));
}`;

/** f⁻¹ in metric distance space — falloff.ts falloffInverse, mode-1 only
 * (the scatter never runs at the OFF/FLOOD endpoints: no finite spatial
 * term there, exactly the CPU's spatialFinite guard). u_scaleD = s·maxEmb. */
const GLSL_FALLOFF_INV = /* glsl */ `
float falloffInvDist(float v, int shape, float scaleD) {
  if (v >= 1.0) return 0.0;
  float vc = max(v, 0.0);
  if (shape == 0) return -log(max(v, 1.0e-30)) * scaleD;          // exp
  if (shape == 1) return (1.0 - vc) * scaleD;                     // linear
  if (shape == 2) return scaleD * sqrt(-log(max(v, 1.0e-30)));    // gauss
  float R = scaleD / 5.0;
  if (shape == 3) return R * (2.0 - exp2(vc));                    // log
  float t = 0.5 - sin(asin(1.0 - 2.0 * vc) / 3.0);                // plateau
  return R * (1.0 - t);
}`;

/** Attribute-less fullscreen triangle (gl_VertexID 0..2). */
export const convergedQuadVertexSource = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

/** Init: v = f(recordDist) with the seed clamp — evalFalloffField + the
 * seed loop of computeConvergedPreview. Tail texels (idx ≥ n) read the
 * sentinel-padded dist → 0; they are never fetched by any consumer. */
export const convergedInitFragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_dist;
uniform sampler2D u_seed;
uniform int u_shape;
uniform float u_sScaled;
uniform float u_invMaxEmb;
uniform int u_mode;
${GLSL_FALLOFF_PREVIEW}
out vec4 outV;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float d = texelFetch(u_dist, tc, 0).r;
  float seed = texelFetch(u_seed, tc, 0).r;
  float v = falloffPreview(d, u_shape, u_sScaled, u_invMaxEmb, u_mode);
  outV = vec4(seed > 0.5 ? 1.0 : v, 0.0, 0.0, 1.0);
}`;

/** One doubling chain pass, BOTH directions fused: v' = max(v,
 * v[predJump_k]·future^(2^k), v[succJump_k]·past^(2^k)). Each level lets a
 * record take its pred-jump, its succ-jump, or neither, so every pure-
 * direction path is covered (binary decomposition of its hop count) and the
 * extra mixed-direction candidates never win — a forward-then-backward
 * detour's gain future^a·past^b is ≤ the pure gain for the same endpoint
 * (decays ≤ 1). One pass per level instead of two: the tick is pass-count
 * bound at record scale. Level rows stack vertically (y + level·H); a
 * gain of 0 disables that direction (the CPU's w ≤ 0 guard). */
export const convergedChainFragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_v;
uniform highp isampler2D u_jumpPred;
uniform highp isampler2D u_jumpSucc;
uniform int u_level;
uniform int u_rows;
uniform int u_texW;
uniform float u_gainF;
uniform float u_gainP;
out vec4 outV;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_v, tc, 0).r;
  ivec2 jt = ivec2(tc.x, tc.y + u_level * u_rows);
  if (u_gainF > 0.0) {
    int j = texelFetch(u_jumpPred, jt, 0).r;
    if (j >= 0) {
      v = max(v, texelFetch(u_v, ivec2(j % u_texW, j / u_texW), 0).r * u_gainF);
    }
  }
  if (u_gainP > 0.0) {
    int j = texelFetch(u_jumpSucc, jt, 0).r;
    if (j >= 0) {
      v = max(v, texelFetch(u_v, ivec2(j % u_texW, j / u_texW), 0).r * u_gainP);
    }
  }
  outV = vec4(v, 0.0, 0.0, 1.0);
}`;

/** Scatter: exactly the CPU's round sources — the records the ROUND'S CHAIN
 * raised (v > roundStart + CONV_EPS, u_vBefore = the pre-chain snapshot) —
 * enter their raster cell at offset f⁻¹(v). Raised-only is semantics, not an
 * optimization: an unraised record's cell-quantized re-entry could raise the
 * field by up to ~0.7·cellSize of falloff slope, which the CPU engine never
 * does. Co-cell min via depth = offset/maxDist, test LESS. Culled records
 * park off-clip. */
export const convergedScatterVertexSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_v;
uniform sampler2D u_vBefore;
uniform sampler2D u_raster;
uniform int u_texW;
uniform vec2 u_gridDim;
uniform int u_shape;
uniform float u_scaleD;
uniform float u_maxDist;
uniform float u_eps;
${GLSL_FALLOFF_INV}
flat out vec2 v_src;
void main() {
  ivec2 tc = ivec2(gl_VertexID % u_texW, gl_VertexID / u_texW);
  float v = texelFetch(u_v, tc, 0).r;
  float before = texelFetch(u_vBefore, tc, 0).r;
  gl_PointSize = 1.0;
  if (v <= before + u_eps) {
    v_src = vec2(-1.0, 0.0);
    gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
    return;
  }
  vec4 ras = texelFetch(u_raster, tc, 0);
  vec2 cell = ras.zw;
  float off = falloffInvDist(v, u_shape, u_scaleD);
  vec2 ndc = ((cell + 0.5) / u_gridDim) * 2.0 - 1.0;
  float z = clamp(off / max(u_maxDist, 1.0e-30), 0.0, 1.0) * 2.0 - 1.0;
  v_src = vec2(cell.y * u_gridDim.x + cell.x, off);
  gl_Position = vec4(ndc, z, 1.0);
}`;

export const convergedScatterFragmentSource = `#version 300 es
precision highp float;
flat in vec2 v_src;
out vec4 outC;
void main() {
  outC = vec4(v_src, 0.0, 0.0);
}`;

/** One jump-flooding pass over the candidate grid: keep the source minimizing
 * offset + chamfer among self + the 8 neighbours at ±u_step. */
export const convergedJfaFragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_grid;
uniform int u_step;
uniform ivec2 u_gridDim;
uniform float u_cellSize;
${GLSL_CHAMFER}
out vec4 outC;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 fc = vec2(c);
  float gw = float(u_gridDim.x);
  vec2 best = texelFetch(u_grid, c, 0).rg;
  float bestD = chamferD(fc, best, u_cellSize, gw);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 nc = c + ivec2(dx, dy) * u_step;
      if (nc.x < 0 || nc.y < 0 || nc.x >= u_gridDim.x || nc.y >= u_gridDim.y) continue;
      vec2 cand = texelFetch(u_grid, nc, 0).rg;
      float d = chamferD(fc, cand, u_cellSize, gw);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
  }
  outC = vec4(best, 0.0, 0.0);
}`;

/** Gather + fold: per record, the 4 corner cells' source distances (futility
 * crop at u_maxDist → D_INF, matching the CPU's cropped grid), the CPU's
 * bilinear lerp order, the any-corner-infinite → nearest-cell guard of
 * bilinearSampleDist, then v' = max(v, f(D)). */
export const convergedGatherFragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_v;
uniform sampler2D u_grid;
uniform sampler2D u_raster;
uniform ivec2 u_gridDim;
uniform float u_cellSize;
uniform float u_maxDist;
uniform int u_shape;
uniform float u_sScaled;
uniform float u_invMaxEmb;
uniform int u_mode;
${GLSL_FALLOFF_PREVIEW}
${GLSL_CHAMFER}
float cellD(ivec2 cell) {
  vec2 cand = texelFetch(u_grid, cell, 0).rg;
  float d = chamferD(vec2(cell), cand, u_cellSize, float(u_gridDim.x));
  return d > u_maxDist ? D_INF : d;
}
out vec4 outV;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_v, tc, 0).r;
  vec4 ras = texelFetch(u_raster, tc, 0);
  float fc = clamp(ras.x, 0.0, float(u_gridDim.x - 1));
  float fr = clamp(ras.y, 0.0, float(u_gridDim.y - 1));
  int c0 = int(floor(fc));
  int r0 = int(floor(fr));
  int c1 = min(c0 + 1, u_gridDim.x - 1);
  int r1 = min(r0 + 1, u_gridDim.y - 1);
  float wc = fc - float(c0);
  float wr = fr - float(r0);
  float v00 = cellD(ivec2(c0, r0));
  float v01 = cellD(ivec2(c1, r0));
  float v10 = cellD(ivec2(c0, r1));
  float v11 = cellD(ivec2(c1, r1));
  float d;
  if (max(max(v00, v01), max(v10, v11)) >= 1.0e29) {
    // Poisoned lerp — nearest cell, exactly bilinearSampleDist's inf-guard.
    d = cellD(ivec2(ras.zw));
    if (d >= 1.0e29) {
      outV = vec4(v, 0.0, 0.0, 1.0); // outside the futility crop: field 0
      return;
    }
  } else {
    float top = (v01 - v00) * wc + v00;
    float bot = (v11 - v10) * wc + v10;
    d = (bot - top) * wr + top;
  }
  float f2 = falloffPreview(d, u_shape, u_sScaled, u_invMaxEmb, u_mode);
  outV = vec4(max(v, f2), 0.0, 0.0, 1.0);
}`;

/** Present: copy the converged field into the renderer's opacity texture. */
export const convergedPresentFragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_v;
out vec4 outV;
void main() {
  outV = vec4(texelFetch(u_v, ivec2(gl_FragCoord.xy), 0).r, 0.0, 0.0, 1.0);
}`;

/** Truth blend (plan-gpu-motion-lane.md §5b): mix a SNAPSHOT of the field
 * currently on screen (u_v — taken at fade start) toward the worker's EXACT
 * converged field (u_exact) — rendered into the opacity texture per fade
 * frame, so the exact result fades in instead of stepping, and a fade toward
 * a field the screen already shows changes nothing (blending from the GPU
 * field instead popped back to the preview on settle-after-truth — CS feel
 * round 3). t = 1 is the exact field verbatim. */
export const convergedBlendFragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_v;
uniform sampler2D u_exact;
uniform float u_t;
out vec4 outV;
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  float from = texelFetch(u_v, tc, 0).r;
  float exact = texelFetch(u_exact, tc, 0).r;
  outV = vec4(mix(from, exact, u_t), 0.0, 0.0, 1.0);
}`;
