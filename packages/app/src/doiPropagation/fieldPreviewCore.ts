// packages/app/src/doiPropagation/fieldPreviewCore.ts
//
// Pure, worker-safe core of the field drag-preview compute (issue #315).
// Given a resident distance field + trajectory pred/succ indices + the seed
// record indices, it produces the preview opacity = f(D) + seed clamp +
// trajectory chain cascade — the exact math previewFalloffOpacity runs on the
// main thread, extracted so it can run in fieldPreview.worker.ts and be
// unit-tested without a Worker.
//
// Imports ONLY falloff.ts (equally pure), so the worker bundle stays lean and
// ts-jest never trips over import.meta.

import {
  evalFalloffField,
  evalFalloffPreviewParams,
  type FalloffPreviewParams,
  type FalloffShape,
} from "./falloff";

/** The falloff shapes the field preview can evaluate — every FalloffShape
 * since the hop oracle retired (#337 PR B); kept as an alias so the worker
 * protocol types read unchanged. */
export type FieldPreviewShape = FalloffShape;

export interface FieldPreviewInput {
  /** Record-order geodesic distances (Infinity = unreachable). */
  recordDist: Float32Array;
  /** Predecessor record index per node, -1 if none. */
  predIndex: Int32Array;
  /** Successor record index per node, -1 if none. */
  succIndex: Int32Array;
  /** Record indices of the selected seeds (clamped to DoI 1). */
  seedIdx: Int32Array;
  shape: FieldPreviewShape;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
}

/**
 * Typed-array core of the trajectory chain closure — shared by
 * serverPropagation's `chainScanTrajectory(nodes, ...)` wrapper and the field
 * preview worker so both paths stay bit-identical. Two monotone passes: a
 * successor takes `future·predecessor`, a predecessor takes `past·successor`.
 * One forward + one backward pass suffice because decay < 1 makes the optimal
 * chain monotone and pred/succ point along array order per line.
 */
export function chainScanTrajectoryCore(
  values: Float32Array,
  predIndex: Int32Array,
  succIndex: Int32Array,
  past: number,
  future: number
): void {
  const n = values.length;
  if (future > 0) {
    const f = Math.min(future, 1);
    for (let i = 0; i < n; i++) {
      const p = predIndex[i];
      if (p >= 0) {
        const v = values[p] * f;
        if (v > values[i]) values[i] = v;
      }
    }
  }
  if (past > 0) {
    const b = Math.min(past, 1);
    for (let i = n - 1; i >= 0; i--) {
      const s = succIndex[i];
      if (s >= 0) {
        const v = values[s] * b;
        if (v > values[i]) values[i] = v;
      }
    }
  }
}

/**
 * Preview opacity over a resident distance field: `f(D)` + seed clamp + chain
 * cascade, written into `out` (reused when its length matches, so ping-pong
 * ticks allocate nothing). Returns the buffer that actually holds the result
 * (== `out` when reused). No node/group writes — identical values to
 * serverPropagation.previewFalloffOpacity.
 */
export function computeFieldPreview(
  input: FieldPreviewInput,
  out?: Float32Array
): Float32Array {
  const { recordDist, predIndex, succIndex, seedIdx, shape, prox, past, future, maxEmb } =
    input;
  const v = evalFalloffField(recordDist, shape, prox, maxEmb, out);
  // Seeds are ALWAYS exactly 1 (selection flags, never D=0 grid-coincidence).
  for (let i = 0; i < seedIdx.length; i++) v[seedIdx[i]] = 1;
  chainScanTrajectoryCore(v, predIndex, succIndex, past, future);
  return v;
}

// ── Frozen chain (GPU drag preview, issue #315) ──────────────────────────────
//
// WHY: the shader can evaluate `f(D)` per point but not the trajectory chain
// (two sequential scans). Composing the shader's spatial term with the
// COMMITTED field as `max(committed, f(D, p))` was therefore only ever able to
// RAISE values — the committed field already contains the committed spatial
// term, so dragging the proximity slider DOWN previewed nothing until the
// commit landed (CS 2026-07-26).
//
// The fix rests on an exact identity. `chainScanTrajectoryCore` is a max-plus
// (tropical) relaxation: every point ends up at
//
//     v_i = max over chain sources j of   value_j · decay(i, j)
//
// so with `value_j = f(D_j, p)` plus the seed clamp, ONE source per point (the
// argmax) determines its value, as that source's distance and the decay along
// the path to it. `computeFrozenChain` runs the same two passes as the preview
// and records, per point, three candidate sources whose contribution the shader
// can then re-evaluate for any proximity slider:
//
//     preview_i(p) = max( seedChain_i,  f(D_i, p),  gain_i · f(srcDist_i, p) )
//                          ↑ chain from the selection (slider-independent)
//                                       ↑ its own spatial term
//                                                    ↑ its best chain source
//
// Each term is the value of ONE admissible chain path, so the max is a LOWER
// BOUND of the exact preview at every p; and since the exact argmax at the
// freeze point is always one of the three, the preview EQUALS the exact field
// there (entering a drag changes nothing on screen). Every term is monotone in
// p, so both drag directions preview. The two endpoints are exact too: at
// slider 0 only `seedChain` survives, which IS the exact field there, and at
// slider 1 `f(D_i, 1)` floods every reachable point.
//
// Measured against the exact per-p re-propagation (200 lines × 50 points, log
// shape, past = future = 0.75, frozen at p = 0.6): mean |Δ| ≤ 0.012 below the
// freeze (0 at slider 0) and ≤ 0.018 above it, vs. 0.09–0.11 for the max()
// composition this replaced. Dropping the seedChain or own-distance term costs
// an order of magnitude at the respective end — hence three terms, not one.
//
// What remains is the frozen ARGMAX: a large proximity move can re-route which
// source wins, which the frozen triple cannot follow (it can only undershoot).
// That, and the server's proximity↔topology recursion, is the whole
// preview-vs-commit divergence (fieldPreview.contract.test.ts pins both).

/** Frozen per-point chain descriptor for the GPU preview, alongside the field's
 * own `recordDist`. `srcDist` is the geodesic distance of the point's best chain
 * source (+Infinity when unreachable), `gain` the decay product along the chain
 * to it (1 = the point's own spatial term won), `seedChain` the
 * slider-independent contribution of the selection's own trajectories. */
export interface FrozenChainLayers {
  srcDist: Float32Array;
  gain: Float32Array;
  seedChain: Float32Array;
}

/** A freeze plus the field it froze at. `values` is BIT-IDENTICAL to
 * `computeFieldPreview(input)` — the carrying passes below update `values` with
 * exactly `chainScanTrajectoryCore`'s comparisons — so a freeze and an exact
 * field come out of ONE O(n) pass. The in-drag truth lane (issue #315) needs
 * both: the layers re-anchor the shader preview, the values ARE what the
 * release commit will paint. */
export interface FrozenChainResult extends FrozenChainLayers {
  values: Float32Array;
}

/**
 * Freeze the trajectory chain for a drag: the same forward/backward passes
 * `computeFieldPreview` runs, carrying the argmax source's distance and the
 * decay to it instead of only the value, plus a second scan of the pure seed
 * chain. `evaluateFrozenChain` then reproduces `computeFieldPreview` at the
 * frozen `input.prox` and remaps live for any other proximity slider.
 */
export function computeFrozenChain(input: FieldPreviewInput): FrozenChainResult {
  const { recordDist, predIndex, succIndex, seedIdx, shape, prox, past, future, maxEmb } =
    input;
  const n = recordDist.length;
  const values = evalFalloffField(recordDist, shape, prox, maxEmb);
  const srcDist = new Float32Array(n);
  srcDist.set(recordDist);
  const gain = new Float32Array(n).fill(1);
  // Seeds are ALWAYS exactly 1 (selection flags, never D=0 grid-coincidence) —
  // same clamp as computeFieldPreview, so the argmax below sees the same field.
  const seedChain = new Float32Array(n);
  for (let i = 0; i < seedIdx.length; i++) {
    values[seedIdx[i]] = 1;
    seedChain[seedIdx[i]] = 1;
  }
  // The seed-only chain: slider-independent, and the exact field at slider 0.
  chainScanTrajectoryCore(seedChain, predIndex, succIndex, past, future);
  // Same two monotone passes as chainScanTrajectoryCore — a point that takes a
  // neighbour's decayed value inherits that neighbour's source and gain, which
  // keeps `values[i] === gain[i] · f(srcDist[i], prox)` true by induction.
  if (future > 0) {
    const f = Math.min(future, 1);
    for (let i = 0; i < n; i++) {
      const p = predIndex[i];
      if (p >= 0) {
        const v = values[p] * f;
        if (v > values[i]) {
          values[i] = v;
          srcDist[i] = srcDist[p];
          gain[i] = gain[p] * f;
        }
      }
    }
  }
  if (past > 0) {
    const b = Math.min(past, 1);
    for (let i = n - 1; i >= 0; i--) {
      const s = succIndex[i];
      if (s >= 0) {
        const v = values[s] * b;
        if (v > values[i]) {
          values[i] = v;
          srcDist[i] = srcDist[s];
          gain[i] = gain[s] * b;
        }
      }
    }
  }
  return { srcDist, gain, seedChain, values };
}

/**
 * JS twin of the GPU preview composition — `max(seedChain, f(D), gain·f(srcDist))`
 * per point, from the same precomputed params the shader gets. The parity oracle
 * for glslUtils' `previewDoi` (GLSL has no unit-test harness here).
 */
export function evaluateFrozenChain(
  recordDist: Float32Array,
  layers: FrozenChainLayers,
  params: FalloffPreviewParams,
  out?: Float32Array
): Float32Array {
  const { srcDist, gain, seedChain } = layers;
  const n = recordDist.length;
  const v = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const own = evalFalloffPreviewParams(params, recordDist[i]);
    const chain = gain[i] * evalFalloffPreviewParams(params, srcDist[i]);
    v[i] = Math.max(seedChain[i], Math.max(own, chain));
  }
  return v;
}

// ── Latest-wins scheduling (pure, testable without a worker) ────────────────
//
// The main thread keeps at most one preview tick in flight. A tick that
// arrives while one is running does not queue — it REPLACES any older pending
// params, so the worker only ever computes the freshest slider values. When a
// result returns, the stashed latest (if any) is sent next.

export interface LatestWinsState<P> {
  inFlight: boolean;
  pending: P | null;
}

export function latestWinsInitial<P>(): LatestWinsState<P> {
  return { inFlight: false, pending: null };
}

/** A new request: send immediately when idle, else stash as the pending latest
 * (dropping any older pending params). */
export function latestWinsRequest<P>(
  state: LatestWinsState<P>,
  params: P
): { state: LatestWinsState<P>; send: P | null } {
  if (!state.inFlight) {
    return { state: { inFlight: true, pending: null }, send: params };
  }
  return { state: { inFlight: true, pending: params }, send: null };
}

/** A result returned: drain the pending latest if present (still in flight),
 * else go idle. */
export function latestWinsComplete<P>(
  state: LatestWinsState<P>
): { state: LatestWinsState<P>; send: P | null } {
  if (state.pending !== null) {
    return { state: { inFlight: true, pending: null }, send: state.pending };
  }
  return { state: { inFlight: false, pending: null }, send: null };
}
