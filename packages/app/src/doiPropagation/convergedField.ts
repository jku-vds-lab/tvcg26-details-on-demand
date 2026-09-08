// src/doiPropagation/convergedField.ts
//
// Converged DoI propagation — the paper's recursion, run to its fixed point
// on the client field lane (replaces the shipped first-order "round 0"
// single chain pass; direction confirmed on the live comparison instrument
// 2026-08-14, RESIDUAL-CAP.md / ROUNDS-VIZ.md).
//
// Model: v(x) = f(d_eff(x)) with d_eff(x) = min over all sources j of
// (offset_j + dist(x, j)). True seeds enter at offset 0; a chain-raised
// state with value v acts as a source with offset f⁻¹(v) — its influence
// CONTINUES the falloff from where it left off, it does not restart it.
// Converged = alternate (field re-spread) ↔ (chain scan along stored
// trajectories) until the max value change ≤ CONV_EPS or CONV_MAX_ROUNDS.
// Composition is min-plus in distance space (winner-takes-it) — NEVER a
// summing blur; distances propagate and f applies only at readout, which is
// what keeps every falloff shape exact. Folding `v = max(v, f(d_new))` per
// round is the same min in distance space through the monotone-decreasing f.
//
// Mirrors doi_field.apply_falloff's chain ↔ re-spread loop (max_respread=
// None semantics) on the client's plain-EDT/barrier-free geometry. KNOWN
// REFERENCE DEVIATION (2026-08-14): the python engine's per-record COO
// super-source edges get SUMMED by scipy tocsr() when raised records share
// a grid cell, weakening its re-spread on cell-dense datasets. The model's
// actual semantics is MIN over co-cell offsets (the strongest source wins),
// which is what `respreadDistanceSweep` computes — so this lane colors
// slightly MORE than the python reference numbers where raised states are
// cell-dense. Validated against the min-semantics TS instrument
// (local/convergence-compare), not the summed python fields.
//
// DESCRIBED-ONLY tuning option — per-hop chain damping (not implemented):
// scaling the chain weights to past·α / future·α with α < 1 INSIDE the
// alternation would attenuate every trajectory hop multiplicatively (the
// chain scan's cascaded multiply applies its factor once per hop, so scaling
// the factors IS per-hop damping — no restructuring needed). Unlike the
// levers below it changes the MODEL DEFINITION, not the parameterization:
// the same slider weight then means a shorter chain reach at every setting,
// and the converged fixed point itself moves. The instrument carried it as
// `convDamp` (default 1 = undamped); production keeps the definition frozen
// and reaches the same selectivity through the thumb warp + display
// thresholds instead.

import {
  evalFalloffField,
  falloffInverse,
  falloffScale,
  falloffValue,
  type FalloffShape,
} from "./falloff";
import {
  bilinearSampleDist,
  respreadDistanceSweep,
  type FieldRaster,
} from "./fieldDistanceCore";
import { chainScanTrajectoryCore } from "./fieldPreviewCore";

/** Convergence epsilon — the reference engine's conv_eps default. */
export const CONV_EPS = 1e-3;
/** Iteration ceiling; every measured real-data case converged within 9
 * rounds (ROUNDS-VIZ.md), the ceiling is head-room, not a truncation. */
export const CONV_MAX_ROUNDS = 12;
/** Futility floor for the re-spread: past the distance where f < this, a
 * re-spread contributes only sub-eps dust (for the compact log/plateau/
 * linear shapes this is exactly their support distance). */
export const CONV_RESPREAD_FLOOR = 1e-4;

/** Reusable buffers across converged runs (the DRAG PREVIEW runs the
 * alternation at ~10 Hz — per-tick allocation of the n-sized round snapshot
 * and the multi-MB sweep grid would churn the GC mid-drag). The caller owns
 * the object; fields are (re)filled here and grown on demand. Never share
 * one scratch between concurrent runs — the field lane is main-thread
 * synchronous, so its single module-level scratch is safe. */
export interface ConvergedScratch {
  before?: Float32Array;
  grid?: Float64Array;
}

export interface ConvergedFieldParams {
  shape: FalloffShape;
  /** Effective proximity p (the store value — already thumb-warped). */
  prox: number;
  maxEmb: number;
  /** Effective chain weights (the store values — already thumb-warped;
   * the engine applies them as-is, once per hop via the chain scan's
   * cascaded multiply). */
  past: number;
  future: number;
  /** Optional buffer reuse across runs — see {@link ConvergedScratch}. */
  scratch?: ConvergedScratch;
}

export interface ConvergedFieldStats {
  /** Alternation rounds run (1 = the chain raised nothing — the output is
   * byte-identical to the shipped first-order behavior). */
  rounds: number;
  /** Spatial re-spread passes run (0 on chain-inert datasets). */
  respreads: number;
  /** Max value change of the last round (0 when the chain fixed-pointed). */
  maxDelta: number;
  /** False only if the ceiling hit before maxDelta ≤ CONV_EPS. */
  converged: boolean;
}

/**
 * Chain ↔ re-spread alternation over `v` IN PLACE. `v` enters as the round-0
 * falloff + seed clamp (pre-chain) buffer and leaves converged; every write
 * is raise-only, so seeds stay 1 and the result dominates the shipped
 * first-order output pointwise. `getRaster` is called lazily — a dataset
 * whose chain raises nothing (mnist/fashion: one line per point) never
 * rasterizes and pays only the one chain scan it always paid.
 *
 * Per round: chain closure → collect chain-raised states (Δ > CONV_EPS) →
 * re-seed them spatially at offset f⁻¹(v) via the two-pass chamfer sweep →
 * fold the re-spread field back with max → repeat until the round's max
 * change ≤ CONV_EPS. Seeds-only (p ≤ 0) and flood (p ≥ 1) sliders have no
 * finite spatial term — the trailing chain still runs, matching the
 * reference engine's guards.
 */
/** Everything a converged PREVIEW compute needs — the drag-preview worker's
 * resident state plus the per-tick sliders. Mirrors the sync lane's
 * `previewFalloffOpacity` composition operation for operation, so worker and
 * sync previews (and the commit, which runs the same alternation core) are
 * value-identical. */
export interface ConvergedPreviewInput {
  recordDist: Float32Array;
  predIndex: Int32Array;
  succIndex: Int32Array;
  /** Seed clamp indices — ALWAYS exactly 1 (selection flags, never D=0). */
  seedIdx: ArrayLike<number>;
  /** Pins clamp to DoI 1 AFTER the alternation (#337; pins receive, never
   * emit). Empty/absent = none. */
  pinnedIdx?: ArrayLike<number> | null;
  /** Labeled points paint transparent in unlabeled-only mode — zeroed LAST,
   * after the pin clamp. Empty/absent = none. */
  labeledZeroIdx?: ArrayLike<number> | null;
  getRaster: () => FieldRaster;
  shape: FalloffShape;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
}

/**
 * One converged preview frame: falloff over the resident distances → seed
 * clamp → converged alternation → pin clamp → labeled zeroing. Pure and
 * worker-safe; `out` is the ping-pong reuse buffer (used when its length
 * matches), `scratch` the cross-run round/grid buffers.
 */
export function computeConvergedPreview(
  input: ConvergedPreviewInput,
  out?: Float32Array,
  scratch?: ConvergedScratch
): Float32Array {
  const v = evalFalloffField(
    input.recordDist,
    input.shape,
    input.prox,
    input.maxEmb,
    out
  );
  const seeds = input.seedIdx;
  for (let k = 0; k < seeds.length; k++) v[seeds[k]] = 1;
  runConvergedAlternationCore(v, input.predIndex, input.succIndex, input.getRaster, {
    shape: input.shape,
    prox: input.prox,
    maxEmb: input.maxEmb,
    past: input.past,
    future: input.future,
    scratch,
  });
  const pins = input.pinnedIdx;
  if (pins) for (let k = 0; k < pins.length; k++) v[pins[k]] = 1;
  const zero = input.labeledZeroIdx;
  if (zero) for (let k = 0; k < zero.length; k++) v[zero[k]] = 0;
  return v;
}

export function runConvergedAlternationCore(
  v: Float32Array,
  predIndex: Int32Array,
  succIndex: Int32Array,
  getRaster: () => FieldRaster,
  params: ConvergedFieldParams
): ConvergedFieldStats {
  const { shape, prox, maxEmb, past, future } = params;
  const scratch = params.scratch;
  const s = falloffScale(prox);
  const spatialFinite = s > 0 && isFinite(s) && maxEmb > 0;
  const n = v.length;
  const before =
    scratch?.before && scratch.before.length === n
      ? scratch.before
      : new Float32Array(n);
  if (scratch) scratch.before = before;
  let raster: FieldRaster | null = null;
  let rounds = 0;
  let respreads = 0;
  let lastDelta = 0;
  let converged = false;
  for (let iter = 0; iter < CONV_MAX_ROUNDS; iter++) {
    rounds++;
    before.set(v);
    // Chain closure is raise-only in place, so v ≥ before afterwards (the
    // reference's `max(before, doi_chain)` is implicit).
    chainScanTrajectoryCore(v, predIndex, succIndex, past, future);
    // Chain-raised states (eps-level convergence bookkeeping) become the
    // round's re-spread sources.
    const raisedIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (v[i] > before[i] + CONV_EPS) raisedIdx.push(i);
    }
    if (raisedIdx.length === 0) {
      // Fixed point: the chain raised nothing.
      lastDelta = 0;
      converged = true;
      break;
    }
    if (!spatialFinite) {
      // No spatial re-spread term at the slider endpoints; the chain above
      // already fixed-pointed the trajectory term (one closure is complete).
      converged = true;
      break;
    }
    if (raster === null) raster = getRaster();
    const k = raisedIdx.length;
    const sRows = new Int32Array(k);
    const sCols = new Int32Array(k);
    const offs = new Float64Array(k);
    for (let j = 0; j < k; j++) {
      const i = raisedIdx[j];
      sRows[j] = raster.rows[i];
      sCols[j] = raster.cols[i];
      offs[j] = falloffInverse(v[i], shape, prox, maxEmb);
    }
    const maxDist = falloffInverse(CONV_RESPREAD_FLOOR, shape, prox, maxEmb);
    const grid = respreadDistanceSweep(
      raster.W,
      raster.H,
      raster.cellSize,
      sRows,
      sCols,
      offs,
      maxDist,
      scratch?.grid
    );
    if (scratch) scratch.grid = grid;
    const { rows, cols, frows, fcols, W, H } = raster;
    for (let i = 0; i < n; i++) {
      const d = bilinearSampleDist(grid, W, H, frows[i], fcols[i], rows[i], cols[i]);
      if (!isFinite(d)) continue; // outside the futility crop: field 0
      const f2 = falloffValue(d, shape, prox, maxEmb);
      if (f2 > v[i]) v[i] = f2;
    }
    respreads++;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const dd = v[i] - before[i];
      if (dd > delta) delta = dd;
    }
    lastDelta = delta;
    if (delta <= CONV_EPS) {
      converged = true;
      break;
    }
  }
  return { rounds, respreads, maxDelta: lastDelta, converged };
}
