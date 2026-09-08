// src/doiPropagation/falloff.ts
//
// Spatial falloff family for field-engine DoI (issue #315 A3 field-first
// v2, plan-315-a3-server-doi.md §8). The server ships the geodesic
// distance field D once per selection; the falloff radio + proximity
// slider re-evaluate `v = f(D)` HERE, locally, with zero round trips.
// The formulas must stay equal to the server's (doi_field.py falloff
// family) — the server applies the same f to the same D for doiMass /
// visibleRanges, and drift would flip threshold membership.
//
// SLIDER SEMANTICS (CS spec 2026-07-24): slider 0 = spatial propagation
// OFF (seeds only); slider 1 = 100% DoI reaches the FURTHEST point of
// the projection (maxEmbeddingDistance = the diameter) — no falloff at
// all. The shape governs only the in-between profile. Realized as a
// per-shape scale s(p) = p/(1−p) over normalized distance u = D/M:
//   exp:    v = exp(−u/s)
//   linear: v = max(0, 1 − u/s)     (hard edge at u = s)
//   gauss:  v = exp(−(u/s)²)        (plateau, then a fast drop)
// s(0) = 0 ⇒ off; s(1) = ∞ ⇒ v = 1 everywhere reachable. At p = 0.5,
// s = 1: linear spans exactly the projection. (The "hop" graph-engine
// shape retired with the hop oracle, #337 PR B.)
//
// Two COMPACT-SUPPORT shapes (CS 2026-07-24) stay LOCAL through most of the
// slider and only reach the projection's corners near the top — a soft
// version of a hard cut-off radius, unlike exp/gauss whose infinite tails
// give every point some DoI at any p > 0. Both use a bounded radius in
// diameter units SLOWED so u = 1 is only reachable from p = 5/6 ≈ 0.83:
//   r = s / 5      (p ≥ 1 ⇒ r = ∞ ⇒ v = 1 for every finite D; p ≤ 0 ⇒ 0)
//   log:     v = log2(2 − u/r) for u < r, else 0   (concave; holds high,
//            then falls increasingly fast to the bounded radius)
//   plateau: t = clamp(1 − u/r, 0, 1); v = t²(3 − 2t)   (Hermite smoothstep:
//            flat plateau, an S-curve cliff at r, flat approach to 0)
//
// (Historical note: exp's rate was originally the paper-limit
// α = (1+√(−2·ln p))/M — the continuum limit of hop propagation, which
// is why exp is the default shape — but that mapping left the far point
// at ~0.37 even at p = 1; the UX family above replaces it.)

export type FalloffShape =
  | "exp"
  | "linear"
  | "gauss"
  | "log"
  | "plateau";

/** Field shapes the client can evaluate over a distance field. */
export const FIELD_FALLOFF_SHAPES = [
  "exp",
  "linear",
  "gauss",
  "log",
  "plateau",
] as const;

/** The per-shape scale: p/(1−p), clamped so p ≤ 0 → 0 (off) and
 * p ≥ 1 → Infinity (no falloff). Mirrors doi_field.py exactly. */
export function falloffScale(prox: number): number {
  if (prox <= 0) return 0;
  if (prox >= 1) return Infinity;
  return prox / (1 - prox);
}

/** Scalar falloff value at geodesic distance `dist` (≥ 0; Infinity = the
 * void-separated unreachable case → 0 for every shape and any slider). */
export function falloffValue(
  dist: number,
  shape: FalloffShape,
  prox: number,
  maxEmb: number
): number {
  const s = falloffScale(prox);
  // Slider 0 = spatial propagation OFF for EVERYTHING — including D=0.
  // The distance field is grid-quantized, so a non-selected point sharing
  // a seed's cell has D=0; treating that as 1 leaked DoI at p=0 (CS repro:
  // line query + prox 0 + past/future spread through coincident points).
  // Seeds get their 1.0 from the caller's selection clamp, never from D.
  if (s === 0) return 0;
  if (dist <= 0) return 1;
  if (!isFinite(dist) || maxEmb <= 0) return 0;
  const u = dist / maxEmb;
  if (!isFinite(s)) return 1;
  switch (shape) {
    case "exp":
      return Math.exp(-u / s);
    case "linear":
      return u >= s ? 0 : 1 - u / s;
    case "gauss": {
      const q = u / s;
      return Math.exp(-q * q);
    }
    case "log": {
      // Compact support: r = s/5 (diameter units); v = log2(2 − u/r), 0 past r.
      const q = (5 * u) / s; // u/r
      return q < 1 ? Math.log2(2 - q) : 0;
    }
    case "plateau": {
      // Compact support: Hermite smoothstep t²(3−2t) over t = 1 − u/r, r = s/5.
      const t = 1 - (5 * u) / s; // 1 − u/r
      const tc = t <= 0 ? 0 : t >= 1 ? 1 : t;
      return tc * tc * (3 - 2 * tc);
    }
  }
}

/**
 * f⁻¹ in metric distance space — folds a chain-raised DoI value `v` back to
 * the effective distance it entered the falloff at (doi_field.py's
 * `Falloff.inverse` closures). The converged alternation re-seeds a raised
 * state as a spatial source at this offset, so its influence CONTINUES the
 * falloff from where it left off instead of restarting it. Plateau's f⁻¹ is
 * set-valued on the flat top; the closed form takes the infimum of the
 * preimage (bias = slight over-coloring, one-sided). Guards mirror the
 * python: non-spatial (s = 0) and flood (s = ∞ / maxEmb ≤ 0) return 0,
 * v ≥ 1 → 0, and v ≤ 0 lands on the shape's support distance (finite for
 * linear/log/plateau).
 */
export function falloffInverse(
  v: number,
  shape: FalloffShape,
  prox: number,
  maxEmb: number
): number {
  const s = falloffScale(prox);
  if (s === 0 || !isFinite(s) || maxEmb <= 0) return 0;
  const scale = s * maxEmb;
  if (v >= 1) return 0;
  switch (shape) {
    case "exp":
      // v = exp(−D/scale)  ⇒  D = −ln(v)·scale
      return -Math.log(Math.max(v, 1e-300)) * scale;
    case "linear":
      // v = 1 − D/scale  ⇒  D = (1 − v)·scale
      return (1 - Math.max(v, 0)) * scale;
    case "gauss":
      // v = exp(−(D/scale)²)  ⇒  D = scale·√(−ln v)
      return scale * Math.sqrt(-Math.log(Math.max(v, 1e-300)));
    case "log": {
      // v = log2(2 − D/R), R = scale/5  ⇒  D = R·(2 − 2^v)
      const R = scale / 5;
      const vc = v < 0 ? 0 : v;
      return R * (2 - Math.pow(2, vc));
    }
    case "plateau": {
      // v = t²(3 − 2t), t = 1 − D/R  ⇒  t = ½ − sin(asin(1 − 2v)/3)
      const R = scale / 5;
      const vc = v < 0 ? 0 : v;
      const t = 0.5 - Math.sin(Math.asin(1 - 2 * vc) / 3);
      return R * (1 - t);
    }
  }
}

// ── GPU-preview twin (issue #315, plan-315-a3 T1 GPU-preview path) ──────────
//
// The proximity/falloff drag evaluates `v = f(D)` IN THE SHADER (glslUtils'
// GLSL_FALLOFF_PREVIEW) so a drag tick is a handful of uniform writes instead
// of a 4 MB opacity re-upload — the distance field D is static during a drag,
// only the falloff params change. To keep the GPU exactly equal to the CPU
// twin above, the shader takes PRECOMPUTED params (shape code + per-shape
// scale) rather than re-deriving them; `computeFalloffPreviewParams` produces
// them and `evalFalloffPreviewParams` is the byte-for-byte JS mirror of the
// GLSL, pinned against `falloffValue` by a jest parity test.
//
// The shader evaluates f at TWO distances per point and takes a max with a
// constant — the FROZEN CHAIN of fieldPreviewCore's `computeFrozenChain`:
//   v = max(seedChain, f(D), gain · f(srcDist))
// which reproduces the trajectory cascade at the frozen past/future while
// staying monotone in the proximity slider, so a drag previews in BOTH
// directions. With no chain (past = future = 0) every extra term collapses and
// this is literally `v = f(D)`.

/** Numeric shape codes shared with GLSL (glslUtils' falloffPreview switch). */
export const FALLOFF_PREVIEW_SHAPE_CODE: Record<
  FalloffShape,
  number
> = {
  exp: 0,
  linear: 1,
  gauss: 2,
  log: 3,
  plateau: 4,
};

/** Unreachable-distance sentinel. `recordDist`'s +Infinity is uploaded as this
 * (R32F-representable); GLSL reads `D >= SENTINEL/2` as DoI 0. Mirrors the
 * `DIST_SENTINEL` constant in glslUtils. */
export const FALLOFF_DIST_SENTINEL = 1e30;


/**
 * Preview uniforms for the GPU falloff. `mode`: 1 = normal, 2 = OFF endpoint
 * (slider ≤ 0 ⇒ 0 everywhere), 3 = FLOOD endpoint (slider ≥ 1 ⇒ 1 for every
 * reachable point). `sScaled` is the per-shape scale — s for exp/linear/gauss,
 * s/5 (= r) for the compact-support log/plateau — precomputed so the GLSL
 * switch stays one divide. `invMaxEmb` normalizes D to u = D/M.
 */
export interface FalloffPreviewParams {
  shapeCode: number;
  sScaled: number;
  invMaxEmb: number;
  mode: 1 | 2 | 3;
}

/** Build the shader preview params from a field shape + slider + diameter.
 * Mirrors `falloffScale` (endpoints) and the compact-support r = s/5. */
export function computeFalloffPreviewParams(
  shape: FalloffShape,
  prox: number,
  maxEmb: number
): FalloffPreviewParams {
  const s = falloffScale(prox);
  const mode: 1 | 2 | 3 = s === 0 ? 2 : !isFinite(s) ? 3 : 1;
  const compact = shape === "log" || shape === "plateau";
  return {
    shapeCode: FALLOFF_PREVIEW_SHAPE_CODE[shape],
    // s/5 for compact shapes; for the OFF/FLOOD endpoints the shader ignores
    // sScaled, so 0/Infinity here is inert.
    sScaled: compact ? s / 5 : s,
    invMaxEmb: maxEmb > 0 ? 1 / maxEmb : 0,
    mode,
  };
}

/** Byte-for-byte JS mirror of glslUtils' `falloffPreview` — the parity oracle
 * for the shader (GLSL has no unit test harness here). Given the precomputed
 * params + a distance, returns the same value the GPU computes. */
export function evalFalloffPreviewParams(
  p: FalloffPreviewParams,
  dist: number
): number {
  if (dist >= FALLOFF_DIST_SENTINEL * 0.5) return 0; // unreachable
  if (p.mode === 2) return 0; // OFF endpoint: 0 for all, including D=0
  if (dist <= 0) return 1; // seed / grid-coincident cell
  if (p.mode === 3) return 1; // FLOOD endpoint: reachable ⇒ 1
  const q = (dist * p.invMaxEmb) / p.sScaled; // u/s (or u/r for compact shapes)
  switch (p.shapeCode) {
    case 0:
      return Math.exp(-q);
    case 1:
      return Math.max(0, Math.min(1, 1 - q));
    case 2:
      return Math.exp(-q * q);
    case 3:
      return q < 1 ? Math.log2(2 - q) : 0;
    default: {
      const t = Math.max(0, Math.min(1, 1 - q));
      return t * t * (3 - 2 * t);
    }
  }
}

/**
 * Vectorized `v = f(D)` over a distance field (record OR leaf order —
 * pure element-wise). Reuses `out` when its length matches, so slider
 * drags at 1M allocate nothing after the first tick.
 */
export function evalFalloffField(
  dist: Float32Array,
  shape: FalloffShape,
  prox: number,
  maxEmb: number,
  out?: Float32Array
): Float32Array {
  const n = dist.length;
  const v = out && out.length === n ? out : new Float32Array(n);
  const s = falloffScale(prox);
  // Endpoint fast paths shared by every shape: off => 0 for EVERYTHING
  // (the caller clamps actual seeds; D=0 is grid-coincidence, not
  // seedhood), no falloff => 1 for every reachable point.
  if (s === 0) {
    v.fill(0);
    return v;
  }
  if (maxEmb <= 0) {
    for (let i = 0; i < n; i++) v[i] = dist[i] <= 0 ? 1 : 0;
    return v;
  }
  if (!isFinite(s)) {
    for (let i = 0; i < n; i++) v[i] = isFinite(dist[i]) ? 1 : 0;
    return v;
  }
  const invSM = 1 / (s * maxEmb); // u/s == dist * invSM
  if (shape === "exp") {
    for (let i = 0; i < n; i++) {
      const d = dist[i];
      v[i] = d <= 0 ? 1 : isFinite(d) ? Math.exp(-d * invSM) : 0;
    }
    return v;
  }
  if (shape === "linear") {
    for (let i = 0; i < n; i++) {
      const d = dist[i];
      const q = d * invSM;
      v[i] = d <= 0 ? 1 : !isFinite(d) || q >= 1 ? 0 : 1 - q;
    }
    return v;
  }
  if (shape === "log") {
    const invR = 5 * invSM; // u/r = dist * invR  (r = s/5)
    for (let i = 0; i < n; i++) {
      const d = dist[i];
      if (d <= 0) { v[i] = 1; continue; }
      if (!isFinite(d)) { v[i] = 0; continue; }
      const q = d * invR;
      v[i] = q < 1 ? Math.log2(2 - q) : 0;
    }
    return v;
  }
  if (shape === "plateau") {
    const invR = 5 * invSM; // 1 − u/r = 1 − dist * invR  (r = s/5)
    for (let i = 0; i < n; i++) {
      const d = dist[i];
      if (d <= 0) { v[i] = 1; continue; }
      if (!isFinite(d)) { v[i] = 0; continue; }
      const t = 1 - d * invR;
      const tc = t <= 0 ? 0 : t >= 1 ? 1 : t;
      v[i] = tc * tc * (3 - 2 * tc);
    }
    return v;
  }
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d <= 0) { v[i] = 1; continue; }
    if (!isFinite(d)) { v[i] = 0; continue; }
    const q = d * invSM;
    v[i] = Math.exp(-q * q);
  }
  return v;
}
