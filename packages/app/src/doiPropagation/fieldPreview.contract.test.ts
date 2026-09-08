/**
 * PROXIMITY-DRAG PREVIEW CONTRACT (issue #315).
 *
 * DEFECT this file exists for (CS 2026-07-26, synth1m): with a cluster
 * selected, dragging the proximity slider UP previewed correctly, but dragging
 * it DOWN showed no change at all until the thumb was released. The GPU preview
 * composed its shader term with the COMMITTED opacity texture as
 * `max(committed, f(D, p))`, and the committed field already contains the
 * committed spatial term — so a lower preview was masked and the composition
 * could only ever raise values.
 *
 * THE CONTRACT (assert it, do not re-derive it): the drag preview is a
 * FALLOFF REMAP ON A FROZEN CHAIN — three candidate chain sources per point,
 * frozen at the drag's past/future values by `computeFrozenChain`, each
 * re-evaluated at the live proximity slider:
 *
 *     preview_i(p) = max( seedChain_i , f(D_i, p) , gain_i · f(srcDist_i, p) )
 *
 * Consequences pinned below:
 *
 *   1. At the proximity value it was frozen at, the preview EQUALS the full
 *      preview (`computeFieldPreview`) — entering a drag changes nothing.
 *   2. Every term is monotone in the slider, so BOTH directions preview live.
 *   3. Points lit through the selection's own trajectories keep that
 *      contribution at every slider value (`seedChain` is slider-independent):
 *      only the spatial term is re-shaped. At slider 0 the preview is EXACTLY
 *      the seed chain, which is exactly what a commit at 0 produces.
 *   4. It is a LOWER BOUND of the exact preview at every p (three frozen
 *      sources per point instead of the max over all of them).
 *
 * WHY THE COMMIT CAN STILL DIFFER — two distinct, additive sources:
 *   (a) FROZEN ARGMAX. The preview never re-runs the chain scan, so a proximity
 *       move large enough to re-route which source wins leaves it low (never
 *       high). Measured on a 10k synthetic (200 trajectories, log shape,
 *       past = future = 0.75, frozen at p = 0.6): mean |Δ| vs. the exact
 *       re-propagation ≤ 0.012 below the freeze and ≤ 0.018 above it, 0 at both
 *       slider endpoints — against 0.09–0.11 for the max() composition this
 *       replaced.
 *   (b) SERVER RECURSION. The commit re-propagates on the server, where
 *       proximity and topology alternate (the geodesic distances are themselves
 *       re-derived under the new parameters). The preview is a single
 *       non-recursive remap of ONE distance field — the same first-order
 *       approximation `previewFalloffOpacity` / `applyResidentFieldLocally`
 *       document, not a bug.
 *
 * Any future speed-up must keep formula (1)–(4) intact, or the drag stops
 * meaning what the commit will do.
 */

import { describe, expect, it } from "@jest/globals";
import {
  computeFalloffPreviewParams,
  evalFalloffPreviewParams,
  falloffValue,
} from "./falloff";
import {
  chainScanTrajectoryCore,
  computeFieldPreview,
  computeFrozenChain,
  evaluateFrozenChain,
  type FieldPreviewInput,
} from "./fieldPreviewCore";

// ── Fixture ──────────────────────────────────────────────────────────────────
//
// Two trajectories, 8 points, no dataset load. Line A (0..4) runs THROUGH the
// selection: index 2 is the only seed, and the line leaves the selection
// immediately (D jumps to 40/50), so 0,1,3,4 are lit by the SEED chain. Line B
// (5..7) never touches the selection but passes close by, so 5 and 6 are lit
// spatially and 7 — unreachable in the field — is lit by the chain off a
// SPATIAL source (the case a seed-chain-only base layer would lose).

const M = 10; // maxEmbeddingDistance
const P_FREEZE = 0.6;

const recordDist = Float32Array.from([50, 40, 0, 40, 50, 1, 3, Infinity]);
const predIndex = Int32Array.from([-1, 0, 1, 2, 3, -1, 5, 6]);
const succIndex = Int32Array.from([1, 2, 3, 4, -1, 6, 7, -1]);
const seedIdx = Int32Array.from([2]);

/** Points lit through the seed chain (or the seed itself): proximity-invariant
 * at and below the freeze — their spatial term is far too weak to matter. */
const SEED_CHAINED = [0, 1, 2, 3, 4];
/** Points lit spatially, or chained off a spatial source: proximity-driven. */
const SPATIAL_DRIVEN = [5, 6, 7];

const input = (prox: number): FieldPreviewInput => ({
  recordDist,
  predIndex,
  succIndex,
  seedIdx,
  shape: "exp",
  prox,
  past: 0.5,
  future: 0.5,
  maxEmb: M,
});

const frozen = computeFrozenChain(input(P_FREEZE));
const previewAt = (p: number) =>
  Array.from(
    evaluateFrozenChain(
      recordDist,
      frozen,
      computeFalloffPreviewParams("exp", p, M)
    )
  );
const exactAt = (p: number) => Array.from(computeFieldPreview(input(p)));

describe("the frozen chain the preview remaps", () => {
  it("records the best chain source, the decay gain to it, and the seed chain", () => {
    // Line A: everything hangs off the seed at index 2 (its own spatial term is
    // negligible at D = 40/50 with M = 10), so the gains are past^k / future^k
    // and the source distance is the seed's own 0.
    expect(Array.from(frozen.srcDist)).toEqual([0, 0, 0, 0, 0, 1, 3, 3]);
    expect(Array.from(frozen.gain)).toEqual([0.25, 0.5, 1, 0.5, 0.25, 1, 1, 0.5]);
    // The seed chain is the slider-independent layer: line A only.
    expect(Array.from(frozen.seedChain)).toEqual([0.25, 0.5, 1, 0.5, 0.25, 0, 0, 0]);
  });
});

describe("contract 1: the preview equals the full preview at the frozen slider value", () => {
  it("matches computeFieldPreview at p = the freeze point", () => {
    const preview = previewAt(P_FREEZE);
    const exact = exactAt(P_FREEZE);
    for (let i = 0; i < preview.length; i++) {
      expect(preview[i]).toBeCloseTo(exact[i], 6);
    }
  });

  it("is literally max(seedChain, f(D,p), gain·f(srcDist,p)), per point, at every slider value", () => {
    for (const p of [0, 0.15, 0.3, P_FREEZE, 0.8, 0.99, 1]) {
      const params = computeFalloffPreviewParams("exp", p, M);
      const preview = previewAt(p);
      for (let i = 0; i < preview.length; i++) {
        const own = evalFalloffPreviewParams(params, recordDist[i]);
        const chain = frozen.gain[i] * evalFalloffPreviewParams(params, frozen.srcDist[i]);
        // float32 storage (the preview buffer is what the texture carries)
        expect(preview[i]).toBeCloseTo(
          Math.max(frozen.seedChain[i], Math.max(own, chain)),
          7
        );
      }
    }
  });
});

describe("contract 2+3: both directions preview, and the chain keeps its own", () => {
  const committed = previewAt(P_FREEZE);

  it("previews LOWER values when the slider drops (0.6 → 0.3) where the spatial term drives", () => {
    const down = previewAt(0.3);
    for (const i of SPATIAL_DRIVEN) {
      expect(down[i]).toBeLessThan(committed[i]);
    }
    // The regression witness: the composition this replaced was
    // max(committedField, spatialTerm), which is pinned at the committed value
    // for every one of these points — i.e. no visible change on a drag DOWN.
    const spatialOnly = Array.from(recordDist).map((d) =>
      falloffValue(d, "exp", 0.3, M)
    );
    for (const i of SPATIAL_DRIVEN) {
      expect(Math.max(committed[i], spatialOnly[i])).toBeCloseTo(committed[i], 12);
    }
  });

  it("previews HIGHER values when the slider rises (0.6 → 0.8) — symmetric", () => {
    const up = previewAt(0.8);
    for (const i of SPATIAL_DRIVEN) {
      expect(up[i]).toBeGreaterThan(committed[i]);
    }
  });

  it("keeps chain-lit points at their committed DoI while the slider drops", () => {
    // Raised via the trajectory chain from a seed, not via spatial proximity:
    // only the spatial term is being re-shaped, so these must not move.
    for (const p of [0, 0.15, 0.3, 0.45]) {
      const preview = previewAt(p);
      for (const i of SEED_CHAINED) {
        expect(preview[i]).toBeCloseTo(committed[i], 12);
      }
    }
  });

  it("is monotone non-decreasing in the slider at every point", () => {
    const ladder = [0, 0.1, 0.2, 0.35, 0.5, P_FREEZE, 0.7, 0.85, 0.95, 1].map(previewAt);
    for (let step = 1; step < ladder.length; step++) {
      for (let i = 0; i < recordDist.length; i++) {
        expect(ladder[step][i]).toBeGreaterThanOrEqual(ladder[step - 1][i] - 1e-12);
      }
    }
  });

  it("is EXACT at the OFF endpoint: the preview collapses to the seed chain", () => {
    // At proximity 0 the spatial term is 0 for EVERY distance (including a
    // grid-coincident D = 0) and the exact field is the seed chain alone — so
    // the bottom of the slider previews exactly what committing there produces.
    expect(previewAt(0)).toEqual(exactAt(0));
    expect(previewAt(0)[2]).toBe(1); // the seed itself
    expect(previewAt(0)[1]).toBeCloseTo(0.5, 12); // past · seed
    expect(previewAt(0)[5]).toBe(0); // spatially lit only ⇒ off
  });
});

describe("contract 4: divergence from a full re-propagation is bounded below", () => {
  it("never exceeds the exact preview at any slider value (frozen argmax)", () => {
    for (const p of [0, 0.2, 0.4, P_FREEZE, 0.75, 0.9, 1]) {
      const preview = previewAt(p);
      const exact = exactAt(p);
      for (let i = 0; i < preview.length; i++) {
        expect(preview[i]).toBeLessThanOrEqual(exact[i] + 1e-6);
      }
    }
  });

  it("shows the argmax staleness explicitly: a big slider move re-routes sources", () => {
    // At p = 1 (flood) every reachable point is 1 and can then re-feed the chain
    // of its unreachable neighbours — a source switch the frozen triple cannot
    // follow. Reachable points are still exact (their own-distance term floods);
    // index 7 (unreachable, chained) is the one that stays low until the commit.
    const preview = previewAt(1);
    const exact = exactAt(1);
    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      expect(preview[i]).toBeCloseTo(exact[i], 6);
    }
    expect(preview[7]).toBeCloseTo(0.5, 6); // frozen: future · (index 6)
    expect(exact[7]).toBeCloseTo(0.5, 6);
  });
});

// ── contract 5: the in-drag truth lane bounds the release step ────────────────
//
// The step a slider RELEASE paints is `|frozen preview at the released value −
// the field the commit computes there|`, and the commit's field is
// `computeFieldPreview` (`applyResidentFieldLocally` is its per-node twin, and a
// shape-3 field commit ships no new distances, so the commit is that local remap).
// The in-drag lane (doiPropagation/inDragTruth.ts) re-freezes at the value being
// held, which by contract 1 makes the preview EXACT there — so the release step
// collapses to the drift accumulated since the LAST update, not since the commit.
// Asserted as bookkeeping (which freeze the preview is riding), never wall-clock.

describe("contract 5: an in-drag re-freeze collapses the release step", () => {
  /** The step the release swap would paint: max |preview(p) − commit(p)|, with
   * the preview riding a chain frozen at `frozenAt`. */
  const releaseStep = (
    frozenAt: number,
    releasedAt: number,
    shape: "exp" | "log" = "exp"
  ): number => {
    const layers = computeFrozenChain({ ...input(frozenAt), shape });
    const preview = evaluateFrozenChain(
      recordDist,
      layers,
      computeFalloffPreviewParams(shape, releasedAt, M)
    );
    const commit = computeFieldPreview({ ...input(releasedAt), shape });
    let worst = 0;
    for (let i = 0; i < preview.length; i++) {
      worst = Math.max(worst, Math.abs(preview[i] - commit[i]));
    }
    return worst;
  };

  it("is ZERO when the last re-freeze was at the released value", () => {
    // The lane's terminal state: its newest update landed at the value the user
    // then let go of. Nothing is left to jump (float32 remap rounding only).
    for (const shape of ["exp", "log"] as const) {
      expect(releaseStep(0.3, 0.3, shape)).toBeLessThan(1e-6);
      expect(releaseStep(0.85, 0.85, shape)).toBeLessThan(1e-6);
    }
  });

  it("shrinks monotonically as the last re-freeze approaches the released value", () => {
    // 0.6 is the commit; the user drags to 0.2. Each row is "the lane's last
    // update landed HERE" — the closer it landed to 0.2, the smaller the step.
    // The ladder is piecewise CONSTANT by construction, not smooth: the step only
    // changes where an argmax re-routes (here index 6 switches from its own
    // spatial term to the chain off index 5 at p ≈ 0.224), which is exactly the
    // one thing a frozen chain cannot follow. Non-increasing is therefore the
    // honest claim; landing on the released value is what makes it zero.
    const steps = [0.6, 0.5, 0.4, 0.3, 0.25, 0.2].map((frozenAt) =>
      releaseStep(frozenAt, 0.2)
    );
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-9);
    }
    // The no-lane baseline (freeze stuck at the commit) is strictly the largest,
    // and landing ON the released value is strictly zero.
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 1]);
    expect(steps[steps.length - 1]).toBeLessThan(1e-6);
  });

  it("the frozen chain carries the commit's own field in ONE pass (values)", () => {
    // What makes an in-drag update cheap enough to be worth gating on: the freeze
    // and the exact field come out of the SAME O(n) scan, so the worker never
    // pays for both. `values` must be bit-identical to computeFieldPreview, or
    // the lane would paint something the commit will not reproduce.
    for (const p of [0, 0.25, 0.6, 1]) {
      const { values } = computeFrozenChain(input(p));
      expect(Array.from(values)).toEqual(Array.from(computeFieldPreview(input(p))));
    }
  });

  it("re-freezing does not change what is on screen at the freeze value", () => {
    // The lane must be INVISIBLE except for removing drift: the moment a new
    // freeze is installed, the preview at the value it was frozen at is the same
    // number the old freeze showed there (both equal the exact field, contract 1).
    for (const p of [0.15, 0.35, 0.75]) {
      const fresh = evaluateFrozenChain(
        recordDist,
        computeFrozenChain(input(p)),
        computeFalloffPreviewParams("exp", p, M)
      );
      const exact = computeFieldPreview(input(p));
      for (let i = 0; i < fresh.length; i++) expect(fresh[i]).toBeCloseTo(exact[i], 6);
    }
  });

  it("a chain-scan twin check: the frozen values ARE the chain closure", () => {
    // Guards the identity the whole decomposition rests on — if computeFrozenChain's
    // carrying passes ever diverge from chainScanTrajectoryCore, `values` silently
    // stops being the commit's field and the lane starts painting fiction.
    const p = 0.45;
    const manual = evaluateFrozenChain(
      recordDist,
      { srcDist: recordDist, gain: new Float32Array(recordDist.length).fill(1), seedChain: new Float32Array(recordDist.length) },
      computeFalloffPreviewParams("exp", p, M)
    );
    for (let i = 0; i < seedIdx.length; i++) manual[seedIdx[i]] = 1;
    chainScanTrajectoryCore(manual, predIndex, succIndex, 0.5, 0.5);
    expect(Array.from(computeFrozenChain(input(p)).values)).toEqual(Array.from(manual));
  });
});
