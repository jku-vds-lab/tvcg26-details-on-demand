/**
 * semanticZoom/__tests__/hysteresis.test.ts
 *
 * Unit tests for the HysteresisManager.
 *
 * Key properties verified:
 * 1. A new cluster activates only when saliency ≥ activation threshold
 * 2. An active cluster deactivates only when saliency < deactivation threshold
 * 3. Budget cap: never more than `budget` clusters active
 * 4. reset() clears all state
 * 5. When candidates are empty, active set is cleared
 * 6. Fill-from-top ensures labels are shown even when thresholds can't be met
 */

import { describe, expect, it } from "@jest/globals";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { HysteresisManager } from "../hysteresis";
import type { ScoredCandidate } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _uid = 0;

function mkCandidate(saliency: number, uid?: string): ScoredCandidate {
  const u = uid ?? `0x${(_uid++).toString(16).toUpperCase()}`;
  const node: ClusterTreeNode = {
    id: _uid,
    uid: u,
    distance: 0,
    size: 1,
    stability: 1,
  };
  return {
    node,
    screenFootprint: { areaPx: 100, x0: 0, y0: 0, x1: 10, y1: 10 },
    doiMass: 1,
    doiDensity: 1,
    rescued: false,
    saliency,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HysteresisManager", () => {
  it("returns empty array when no candidates provided", () => {
    const h = new HysteresisManager();
    const result = h.update([], 5, 1.1, 0.85);
    expect(result).toHaveLength(0);
  });

  it("activates top-K candidates on first call (fill-from-top)", () => {
    const h = new HysteresisManager();
    const candidates = [
      mkCandidate(0.9),
      mkCandidate(0.8),
      mkCandidate(0.7),
      mkCandidate(0.6),
    ];
    // budget = 2: should activate top 2
    const result = h.update(candidates, 2, 1.1, 0.85);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.saliency)).toEqual([0.9, 0.8]);
  });

  it("does not exceed budget", () => {
    const h = new HysteresisManager();
    const candidates = Array.from({ length: 10 }, (_, i) =>
      mkCandidate(1 - i * 0.05)
    );
    const result = h.update(candidates, 3, 1.1, 0.85);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("retains active cluster above deactivation threshold", () => {
    const h = new HysteresisManager();
    const uidA = "CLUSTER_A";
    const uidB = "CLUSTER_B";

    // Frame 1: both activated
    const frame1 = [mkCandidate(0.9, uidA), mkCandidate(0.8, uidB)];
    h.update(frame1, 2, 1.1, 0.85);

    // Frame 2: A drops slightly but stays above deactivation threshold
    // border score = saliency of 2nd candidate = 0.75
    // deactivationThreshold = 0.75 × 0.85 ≈ 0.638
    // A's new saliency = 0.7 > 0.638 → should remain active
    const frame2 = [mkCandidate(0.75, uidB), mkCandidate(0.70, uidA)];
    const result = h.update(frame2, 2, 1.1, 0.85);
    const activeUids = new Set(result.map((c) => c.node.uid));
    expect(activeUids.has(uidA)).toBe(true);
    expect(activeUids.has(uidB)).toBe(true);
  });

  it("removes active cluster that drops below deactivation threshold", () => {
    const h = new HysteresisManager();
    const uidA = "CLUSTER_KEEP";
    const uidB = "CLUSTER_DROP";

    // Frame 1: both activated
    h.update([mkCandidate(0.9, uidA), mkCandidate(0.8, uidB)], 2, 1.1, 0.85);

    // Frame 2: B drops far below deactivation threshold
    // border score = saliency of K=2nd candidate
    // If we have 3 candidates and budget=2, border = 2nd = 0.7
    // deactivationThreshold = 0.7 × 0.85 ≈ 0.595
    // B's new saliency = 0.1 < 0.595 → should be removed
    // A's new saliency = 0.85 → should remain
    const newC = mkCandidate(0.7);
    const frame2 = [mkCandidate(0.85, uidA), mkCandidate(0.7, newC.node.uid), mkCandidate(0.1, uidB)];
    const result = h.update(frame2, 2, 1.1, 0.85);
    const activeUids = new Set(result.map((c) => c.node.uid));
    expect(activeUids.has(uidA)).toBe(true);
    expect(activeUids.has(uidB)).toBe(false);
  });

  it("new cluster requires higher saliency to activate (activation band)", () => {
    const h = new HysteresisManager();
    const uidExisting = "EXISTING";
    const uidNew = "NEW";

    // Frame 1: existing cluster activated
    h.update([mkCandidate(0.9, uidExisting)], 1, 1.1, 0.85);

    // Frame 2: new cluster appears with saliency just below border × activateFactor
    // budget=1, so border = saliency of 1st = 0.79
    // activationThreshold = 0.79 × 1.1 ≈ 0.869
    // existing cluster saliency = 0.80, new cluster saliency = 0.75
    // new cluster (0.75) < activationThreshold (0.869) → should NOT activate
    // existing cluster (0.80): deactivationThreshold = 0.79 × 0.85 ≈ 0.672
    //   0.80 > 0.672 → should remain
    const frame2 = [mkCandidate(0.80, uidExisting), mkCandidate(0.79), mkCandidate(0.75, uidNew)];
    const result = h.update(frame2, 1, 1.1, 0.85);
    const activeUids = new Set(result.map((c) => c.node.uid));
    expect(activeUids.has(uidNew)).toBe(false);
    expect(activeUids.has(uidExisting)).toBe(true);
  });

  it("reset() clears all active state", () => {
    const h = new HysteresisManager();
    const uid = "CLUSTER_X";
    h.update([mkCandidate(0.9, uid)], 1, 1.1, 0.85);
    expect(h.activeUids.size).toBe(1);

    h.reset();
    expect(h.activeUids.size).toBe(0);
  });

  it("after reset, next call re-evaluates from scratch", () => {
    const h = new HysteresisManager();
    const uid = "CLUSTER_Y";
    h.update([mkCandidate(0.9, uid)], 1, 1.1, 0.85);
    h.reset();

    const result = h.update([mkCandidate(0.5, uid)], 1, 1.1, 0.85);
    expect(result).toHaveLength(1);
    expect(result[0].node.uid).toBe(uid);
  });

  it("handles budget=0 gracefully", () => {
    const h = new HysteresisManager();
    const result = h.update([mkCandidate(0.9)], 0, 1.1, 0.85);
    expect(result).toHaveLength(0);
  });

  it("handles single candidate with budget=1", () => {
    const h = new HysteresisManager();
    const uid = "ONLY_ONE";
    const result = h.update([mkCandidate(0.5, uid)], 1, 1.1, 0.85);
    expect(result).toHaveLength(1);
    expect(result[0].node.uid).toBe(uid);
  });

  it("trims to the highest-saliency survivors when the budget shrinks", () => {
    // The reserve-within-cap pass (#261 part 3) hands this manager a
    // fluctuating remainder, so a shrinking budget must hard-cap the result.
    const h = new HysteresisManager();
    const uidA = "SHRINK_A";
    const uidB = "SHRINK_B";
    const uidC = "SHRINK_C";

    // Frame 1: all three activate at budget 3.
    const frame1 = [mkCandidate(0.9, uidA), mkCandidate(0.8, uidB), mkCandidate(0.7, uidC)];
    expect(h.update(frame1, 3, 1.1, 0.85)).toHaveLength(3);

    // Frame 2: same candidates, budget 2. All three survive the deactivation
    // check (border = 0.8, threshold ≈ 0.68), so without the trim the result
    // would exceed the budget.
    const frame2 = [mkCandidate(0.9, uidA), mkCandidate(0.8, uidB), mkCandidate(0.7, uidC)];
    const result = h.update(frame2, 2, 1.1, 0.85);
    expect(result.map((c) => c.node.uid)).toEqual([uidA, uidB]);
    // State is pruned too: the trimmed C must re-clear the activation
    // threshold to return, not sneak back in as a retained active.
    expect(h.activeUids.size).toBe(2);
    expect(h.activeUids.has(uidC)).toBe(false);
  });

  it("active UIDs set is readonly externally", () => {
    const h = new HysteresisManager();
    h.update([mkCandidate(0.9, "X")], 1, 1.1, 0.85);
    // TypeScript typing ensures this is ReadonlySet; here we just check size
    expect(h.activeUids.size).toBe(1);
  });
});
