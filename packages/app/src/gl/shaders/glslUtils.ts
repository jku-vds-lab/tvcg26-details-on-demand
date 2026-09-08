/**
 * Shared GLSL snippets injected into shaders that need per-node field
 * texture lookups.  Import the appropriate snippet for the field you need.
 *
 * GLSL_FETCH_OPACITY prerequisites in the consuming shader:
 *   uniform sampler2D u_opacityFieldTex;
 *   uniform vec2      u_opacityFieldTexDim;   // (width, height) in texels
 *
 * GLSL_FETCH_EMPHASIS prerequisites in the consuming shader:
 *   uniform sampler2D u_emphasisFieldTex;
 *   uniform vec2      u_emphasisFieldTexDim;  // (width, height) in texels
 */
/**
 * One 8-bit quantum used as a per-point alpha floor (issue #315). Even with
 * the RGBA16F scene target, a sub-quantum alpha's per-draw blend increment
 * can fall below half-float representability near a light clear color
 * (eps ≈ 4.9e-4 at 1.0), rounding away channel-unevenly — flicker + hue
 * drift. Consumers floor a strictly-positive per-point alpha to this quantum
 * (an exact 0 stays 0). Declared at global scope; `${GLSL_ALPHA_QUANTUM}`
 * injects `ALPHA_QUANTUM` into a fragment shader.
 */
export const GLSL_ALPHA_QUANTUM = /* glsl */ `
const float ALPHA_QUANTUM = 1.0 / 255.0;`;

export const GLSL_FETCH_OPACITY = /* glsl */ `
float fetchOpacity(float idx) {
  float w = u_opacityFieldTexDim.x;
  float h = u_opacityFieldTexDim.y;
  float i = floor(idx + 0.5);
  float y = floor(i / w);
  float x = i - y * w;
  vec2 uv = (vec2(x + 0.5, y + 0.5) / u_opacityFieldTexDim);
  return texture(u_opacityFieldTex, uv).r;
}`;

/**
 * Per-node FROZEN-CHAIN lookup for the GPU falloff preview (issue #315).
 * RGBA32F, row-major, same record-index W×H mapping as the opacity field:
 *   .r = D         — the point's own geodesic distance (DIST_SENTINEL = unreachable)
 *   .g = srcDist   — the geodesic distance of its best trajectory-chain source
 *   .b = gain      — the decay product along the chain to that source (1 = none)
 *   .a = seedChain — the selection's chain contribution (slider-independent)
 * `previewDoi` below composes them; see doiPropagation/fieldPreviewCore.ts
 * `computeFrozenChain` for why those four numbers suffice and why they make the
 * preview symmetric in the slider.
 * Prerequisites in the consuming shader:
 *   uniform sampler2D u_distFieldTex;
 *   uniform vec2      u_distFieldTexDim;   // (width, height) in texels
 */
export const GLSL_FETCH_DIST = /* glsl */ `
vec4 fetchFrozenChain(float idx) {
  float w = u_distFieldTexDim.x;
  float i = floor(idx + 0.5);
  float y = floor(i / w);
  float x = i - y * w;
  vec2 uv = (vec2(x + 0.5, y + 0.5) / u_distFieldTexDim);
  return texture(u_distFieldTex, uv);
}`;

/**
 * GPU spatial-falloff preview (issue #315 GPU-preview path, plan-315-a3 T1).
 *
 * WHY: during a proximity/falloff drag the frozen-chain pair (srcDist, gain) is
 * STATIC (uploaded once per field revision + chain-slider value into
 * u_distFieldTex); only the falloff params change. Evaluating `v = f(srcDist)`
 * HERE turns a drag tick into a few uniform writes instead of the ~4 MB R32F
 * opacity re-upload the worker path costs — the guaranteed-60fps preview.
 *
 * The CPU twin is falloff.ts (`falloffValue` / `evalFalloffPreviewParams`) —
 * these MUST stay bit-equal; `falloffPreviewParity.test.ts` pins it. Params are
 * precomputed CPU-side (`computeFalloffPreviewParams`) so this stays branch +
 * one divide:
 *   mode:  0 inactive (preview off — callers pass 0 and the term is ignored,
 *          keeping the opacity-texture-only path byte-identical), 1 normal,
 *          2 OFF endpoint (slider ≤ 0 ⇒ 0 everywhere, including D=0),
 *          3 FLOOD endpoint (slider ≥ 1 ⇒ 1 for every reachable point).
 *   shape: 0 exp, 1 linear, 2 gauss, 3 log, 4 plateau.
 *   sScaled: per-shape scale — s = p/(1−p) for exp/linear/gauss, s/5 (= r) for
 *          the compact-support log/plateau.
 *   invMaxEmb: 1/maxEmbeddingDistance (normalizes D to u = D/M).
 * DIST_SENTINEL encodes an unreachable (void-separated) point: recordDist's
 * +Infinity is uploaded as this, and D >= SENTINEL/2 reads as DoI 0.
 *
 * `previewDoi` is the composition every preview pass uses, and the whole reason
 * a drag previews in BOTH slider directions: the three frozen candidate sources
 * of `computeFrozenChain`, re-evaluated at the live slider and maxed. Its JS
 * twin is `evaluateFrozenChain`; keep them equal.
 */
export const GLSL_FALLOFF_PREVIEW = /* glsl */ `
const float DIST_SENTINEL = 1.0e30;
float falloffPreview(float d, int shape, float sScaled, float invMaxEmb, int mode) {
  if (d >= DIST_SENTINEL * 0.5) return 0.0;         // unreachable
  if (mode == 2) return 0.0;                        // OFF endpoint: 0 for all, incl D=0
  if (d <= 0.0) return 1.0;                         // seed / grid-coincident cell
  if (mode == 3) return 1.0;                        // FLOOD endpoint: reachable -> 1
  float q = (d * invMaxEmb) / sScaled;              // u/s (or u/r for compact shapes)
  if (shape == 0) return exp(-q);                   // exp:    exp(-u/s)
  if (shape == 1) return clamp(1.0 - q, 0.0, 1.0);  // linear: max(0, 1 - u/s)
  if (shape == 2) return exp(-q * q);               // gauss:  exp(-(u/s)^2)
  if (shape == 3) return q < 1.0 ? log2(2.0 - q) : 0.0; // log: log2(2 - u/r), 0 past r
  float t = clamp(1.0 - q, 0.0, 1.0);               // plateau: smoothstep t^2(3-2t)
  return t * t * (3.0 - 2.0 * t);
}

float previewDoi(vec4 fc, int shape, float sScaled, float invMaxEmb, int mode) {
  float own = falloffPreview(fc.r, shape, sScaled, invMaxEmb, mode);
  float chain = fc.b * falloffPreview(fc.g, shape, sScaled, invMaxEmb, mode);
  return max(fc.a, max(own, chain));
}`;

/**
 * Shared GLSL for the instanced edge/arrow vertex shaders (issue #315
 * phase B2). Prerequisites in the consuming shader:
 *   uniform sampler2D u_nodePosTex;    // RG32F, one texel per node (x,y)
 *   uniform sampler2D u_nodeColorTex;  // RGBA32F, rgb = node base color
 *   uniform sampler2D u_edgeCtrlTex;   // RGBA32F, per edge: node indices of
 *                                      // Catmull-Rom controls p0,p1,p2,p3
 *   uniform int u_texWidthNodes;       // texel row width of node textures
 *   uniform int u_texWidthEdges;       // texel row width of edge ctrl texture
 * catmullRom is the GLSL port of dataPreprocessing/catmullRom.ts
 * catmullRomPoint — keep in sync.
 */
export const GLSL_EDGE_INSTANCE_COMMON = /* glsl */ `
vec2 fetchNodePos(int i) {
  return texelFetch(u_nodePosTex, ivec2(i % u_texWidthNodes, i / u_texWidthNodes), 0).rg;
}

vec3 fetchNodeColor(int i) {
  return texelFetch(u_nodeColorTex, ivec2(i % u_texWidthNodes, i / u_texWidthNodes), 0).rgb;
}

vec4 fetchEdgeCtrl(int e) {
  return texelFetch(u_edgeCtrlTex, ivec2(e % u_texWidthEdges, e / u_texWidthEdges), 0);
}

vec2 catmullRom(float t, vec2 p0, vec2 p1, vec2 p2, vec2 p3) {
  float t2 = t * t;
  float t3 = t2 * t;
  return 0.5 * (2.0 * p1
    + (-p0 + p2) * t
    + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
    + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
}`;

/**
 * Shared GLSL snippet for per-node emphasis field texture lookups.
 * Used in edgeQuad.vert to scale edge width by endpoint emphasis.
 * Emphasis ∈ [0,1]; scaled by u_emphasisScale uniform in the consuming shader.
 */
export const GLSL_FETCH_EMPHASIS = /* glsl */ `
float fetchEmphasis(float idx) {
  float w = u_emphasisFieldTexDim.x;
  float h = u_emphasisFieldTexDim.y;
  float i = floor(idx + 0.5);
  float y = floor(i / w);
  float x = i - y * w;
  vec2 uv = (vec2(x + 0.5, y + 0.5) / u_emphasisFieldTexDim);
  return texture(u_emphasisFieldTex, uv).r;
}`;
