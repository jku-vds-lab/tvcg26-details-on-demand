/**
 * semanticZoom/__tests__/chainRescue.test.ts
 *
 * Service-level tests for chain rescue (issue #258): a selected trajectory
 * flowing A→B→C→D with small B, C must activate all four clusters so the
 * chain's diff insets can appear, while no selection keeps the classic
 * size-biased activation.
 *
 * Two regimes are covered (see saliencyScorer's module header):
 *  - Decayed propagation: non-uniform DoI marks the chain; the cut reaches
 *    B/C via the area triggers and the density gate rescues them.
 *  - Uniform selection (the flagship scenario): a full-bundle lasso gives
 *    every clustered point DoI = 1 and B/C hide inside a sub-threshold
 *    parent P — only gap disclosure (selection-gated) carves them into the
 *    cut, and `selectionActive` makes them rescue-eligible.
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { SemanticZoomService } from "../semanticZoomService";
import type { SemanticZoomConfig, Viewbox } from "../types";

// ---------------------------------------------------------------------------
// Fixture: root → (A, I1); I1 → (B, I2); I2 → (C, D)
// A and D are large (pass the min-area gate), B and C are tiny 1×1-data
// clusters (fail it). All internal bboxes are big enough to split.
// ---------------------------------------------------------------------------

let _uid = 0;

function mkNode(
  id: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  stability: number,
  children: number[] = []
): ClusterTreeNode {
  return {
    id,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 1,
    size: Math.max(children.length, 1),
    stability,
    children,
    bbox,
  };
}

function mkPoint(idx: number, doi: number): DataPoint {
  return {
    x: idx,
    y: idx,
    line: 0,
    algo: "a",
    id: idx,
    action: "",
    DoI: doi,
    doiGroup: "annotation",
    nextEdgeCenter: { x: idx, y: idx },
  };
}

// Data [0,100] → screen [0,1000] (10 px per data unit).
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const viewbox: Viewbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

const config: SemanticZoomConfig = {
  splitThresholdPx: 34_500,
  labelMinFraction: 0.1, // min area gate = 3450 px²
  stabilityWeight: 0.3,
  doiMassWeight: 0.5,
  footprintWeight: 0.2,
  doiDensityWeight: 0.4,
  chainDoiThreshold: 0.9,
  gapDisclosurePx: 48,
  chainRescueBudget: 0, // reserve off by default in these tests; phase-D cases opt in
  hysteresisActivateFactor: 1.1,
  hysteresisDeactivateFactor: 0.85,
};

interface Fixture {
  root: ClusterTreeNode;
  A: ClusterTreeNode;
  B: ClusterTreeNode;
  C: ClusterTreeNode;
  D: ClusterTreeNode;
  membersOf: (n: ClusterTreeNode) => number[];
  points: DataPoint[];
}

/**
 * Build the A→B→C→D tree. `chainDoi` sets the DoI of B/C members; A/D
 * members get `bulkDoi`. Equal values ⇒ uniform frame ⇒ rescue inert.
 */
function mkFixture(bulkDoi: number, chainDoi: number): Fixture {
  // Leaves: A 30×30 data (90 000 px² — passes gate), B/C 1×1 data (100 px²).
  const A = mkNode(1, { minX: 0, minY: 0, maxX: 30, maxY: 30 }, 10, [0, 1, 2, 3, 4, 5]);
  const B = mkNode(2, { minX: 40, minY: 40, maxX: 41, maxY: 41 }, 0.5, [6, 7]);
  const C = mkNode(3, { minX: 55, minY: 55, maxX: 56, maxY: 56 }, 0.5, [8, 9]);
  const D = mkNode(4, { minX: 70, minY: 70, maxX: 100, maxY: 100 }, 10, [10, 11, 12, 13, 14, 15]);

  const I2 = mkNode(5, { minX: 55, minY: 55, maxX: 100, maxY: 100 }, 1, [8, 9, 10, 11, 12, 13, 14, 15]);
  I2.leftChild = C;
  I2.rightChild = D;
  const I1 = mkNode(6, { minX: 40, minY: 40, maxX: 100, maxY: 100 }, 1, [6, 7, ...I2.children!]);
  I1.leftChild = B;
  I1.rightChild = I2;
  const root = mkNode(7, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1, [...A.children!, ...I1.children!]);
  root.leftChild = A;
  root.rightChild = I1;

  const points: DataPoint[] = [];
  for (let i = 0; i < 16; i++) {
    const onChain = i >= 6 && i <= 9; // members of B and C
    points.push(mkPoint(i, onChain ? chainDoi : bulkDoi));
  }

  return { root, A, B, C, D, membersOf: (n) => n.children ?? [], points };
}

// ---------------------------------------------------------------------------
// Fixture 2 (the flagship bug): root → (A, R1); R1 → (P, D); P → (B, C).
// P's bbox (16×16 data = 25 600 px²) is BELOW splitThresholdPx and fully in
// view, so the area triggers never split it — B and C only enter the cut via
// gap disclosure.  All points have uniform DoI = 1 (full-bundle lasso).
// ---------------------------------------------------------------------------

interface GapFixture extends Fixture {
  P: ClusterTreeNode;
}

function mkGapFixture(): GapFixture {
  // A 30×30 data (90 000 px²) and D 30×30 data both pass the min-area gate.
  const A = mkNode(1, { minX: 0, minY: 0, maxX: 30, maxY: 30 }, 10, [0, 1, 2, 3, 4, 5]);
  const B = mkNode(2, { minX: 40, minY: 40, maxX: 41, maxY: 41 }, 0.5, [6, 7]);
  const C = mkNode(3, { minX: 55, minY: 55, maxX: 56, maxY: 56 }, 0.5, [8, 9]);
  const D = mkNode(4, { minX: 70, minY: 70, maxX: 100, maxY: 100 }, 10, [10, 11, 12, 13, 14, 15]);

  // P spans (40,40)-(56,56): 160×160 px = 25 600 px² < 34 500 → no area split.
  // Screen gap B↔C: hypot(140, 140) ≈ 198 px ≥ gapDisclosurePx 48.
  const P = mkNode(5, { minX: 40, minY: 40, maxX: 56, maxY: 56 }, 1, [6, 7, 8, 9]);
  P.leftChild = B;
  P.rightChild = C;
  // R1 spans (40,40)-(100,100): 360 000 px² ≥ 34 500 → splits into P and D.
  const R1 = mkNode(6, { minX: 40, minY: 40, maxX: 100, maxY: 100 }, 1, [...P.children!, ...D.children!]);
  R1.leftChild = P;
  R1.rightChild = D;
  const root = mkNode(7, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1, [...A.children!, ...R1.children!]);
  root.leftChild = A;
  root.rightChild = R1;

  const points: DataPoint[] = [];
  for (let i = 0; i < 16; i++) points.push(mkPoint(i, 1.0));

  return { root, A, B, C, D, P, membersOf: (n) => n.children ?? [], points };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chain rescue (service level)", () => {
  beforeEach(() => {
    _uid = 0;
  });

  it("activates the full A→B→C→D chain when B/C are small but fully selected", () => {
    const f = mkFixture(0.5, 1.0);
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0
    );

    const active = result.activeClusterIds;
    expect(active.has(f.A.uid)).toBe(true);
    expect(active.has(f.B.uid)).toBe(true);
    expect(active.has(f.C.uid)).toBe(true);
    expect(active.has(f.D.uid)).toBe(true);
  });

  it("keeps the classic size-biased activation under uniform DoI", () => {
    const f = mkFixture(0.5, 0.5);
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0
    );

    const active = result.activeClusterIds;
    expect(active.has(f.A.uid)).toBe(true);
    expect(active.has(f.D.uid)).toBe(true);
    expect(active.has(f.B.uid)).toBe(false);
    expect(active.has(f.C.uid)).toBe(false);
  });

  it("still caps the active set at the budget", () => {
    const f = mkFixture(0.5, 1.0);
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, config, 1,
      () => 1.0
    );

    expect(result.activeCandidates.length).toBeLessThanOrEqual(2);
  });

  it("busts the result cache when chain-rescue params change", () => {
    const f = mkFixture(0.5, 1.0);
    const service = new SemanticZoomService();

    const first = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0
    );
    expect(first.activeClusterIds.has(f.B.uid)).toBe(true);

    // Unreachable threshold: with a stale cache B would remain active.
    const second = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, { ...config, chainDoiThreshold: 1.01 }, 1,
      () => 1.0
    );
    expect(second.activeClusterIds.has(f.B.uid)).toBe(false);
    expect(second.activeClusterIds.has(f.C.uid)).toBe(false);
  });
});

describe("gap disclosure — uniform-selection regime (the flagship #258 scenario)", () => {
  beforeEach(() => {
    _uid = 0;
  });

  it("activates the full chain when B/C hide inside a sub-threshold parent (uniform DoI = 1)", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0,
      true // selectionActive: hierarchy built from a DoI-filtered subset
    );

    const active = result.activeClusterIds;
    expect(active.has(f.A.uid)).toBe(true);
    expect(active.has(f.B.uid)).toBe(true);
    expect(active.has(f.C.uid)).toBe(true);
    expect(active.has(f.D.uid)).toBe(true);
    // P was carved out of the cut entirely — it must not own the points.
    expect(result.zoomCut.map((n) => n.uid)).not.toContain(f.P.uid);
  });

  it("keeps the classic cut without a selection (P stays merged, B/C absent)", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0
      // selectionActive omitted → false; uniform DoI → focus inactive
    );

    expect(result.zoomCut.map((n) => n.uid)).toContain(f.P.uid);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(false);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(false);
  });

  it("re-coarsens on zoom-out (screen gap drops below the threshold)", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    // 2 px per data unit: B↔C screen gap = hypot(28, 28) ≈ 39.6 px < 48.
    const xOut = d3.scaleLinear().domain([0, 100]).range([0, 200]);
    const yOut = d3.scaleLinear().domain([0, 100]).range([0, 200]);

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xOut, yOut, 200, 200,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0,
      true
    );

    expect(result.activeClusterIds.has(f.B.uid)).toBe(false);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(false);
  });

  it("still caps the active set at the budget", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, config, 1,
      () => 1.0,
      true
    );

    expect(result.activeCandidates.length).toBeLessThanOrEqual(2);
  });

  it("busts the result cache when gapDisclosurePx changes", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const first = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, config, 1,
      () => 1.0,
      true
    );
    expect(first.activeClusterIds.has(f.B.uid)).toBe(true);

    // Unreachable gap: with a stale cache B would remain active.
    const second = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, { ...config, gapDisclosurePx: 10_000 }, 1,
      () => 1.0,
      true
    );
    expect(second.activeClusterIds.has(f.B.uid)).toBe(false);
    expect(second.activeClusterIds.has(f.C.uid)).toBe(false);
  });

  it("rescues a singleton stark-transition point only with through-flow evidence", () => {
    // root → (A, P); P → (B_singleton, C_pair). P is 14×14 data = 19 600 px²
    // (below splitThresholdPx) but size 3 with a ~178 px child gap → gap
    // disclosure carves B and C out. B is a 1-member leaf.
    const A = mkNode(1, { minX: 0, minY: 0, maxX: 30, maxY: 30 }, 10, [0, 1, 2, 3, 4, 5]);
    const B = mkNode(2, { minX: 42, minY: 42, maxX: 42.4, maxY: 42.4 }, 0.5, [6]);
    const C = mkNode(3, { minX: 55, minY: 55, maxX: 56, maxY: 56 }, 0.5, [7, 8]);
    const P = mkNode(5, { minX: 42, minY: 42, maxX: 56, maxY: 56 }, 1, [6, 7, 8]);
    P.leftChild = B;
    P.rightChild = C;
    const root = mkNode(7, { minX: 0, minY: 0, maxX: 100, maxY: 100 }, 1, [...A.children!, ...P.children!]);
    root.leftChild = A;
    root.rightChild = P;
    const points: DataPoint[] = [];
    for (let i = 0; i < 9; i++) points.push(mkPoint(i, 1.0));
    const membersOf = (n: ClusterTreeNode) => n.children ?? [];

    // Through-flow true for B → the singleton activates alongside A and C.
    const service = new SemanticZoomService();
    const through = service.computeActiveClusterIds(
      root, viewbox, xScale, yScale, 1000, 1000,
      membersOf, points, 7, config, 1,
      () => 1.0,
      true,
      (n) => n.uid === B.uid
    );
    expect(through.activeClusterIds.has(A.uid)).toBe(true);
    expect(through.activeClusterIds.has(B.uid)).toBe(true);
    expect(through.activeClusterIds.has(C.uid)).toBe(true);

    // Through-flow false for B (lasso straggler) → B stays out, C still in.
    const service2 = new SemanticZoomService();
    const stray = service2.computeActiveClusterIds(
      root, viewbox, xScale, yScale, 1000, 1000,
      membersOf, points, 7, config, 1,
      () => 1.0,
      true,
      () => false
    );
    expect(stray.activeClusterIds.has(B.uid)).toBe(false);
    expect(stray.activeClusterIds.has(C.uid)).toBe(true);
  });

  it("gapDisclosurePx = 0 disables the trigger entirely", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 7, { ...config, gapDisclosurePx: 0 }, 1,
      () => 1.0,
      true
    );

    expect(result.zoomCut.map((n) => n.uid)).toContain(f.P.uid);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(false);
  });
});

describe("reserved chain-rescue slots — within-cap reserve (#258 phase D, #261 part 3)", () => {
  beforeEach(() => {
    _uid = 0;
  });

  // Budget 2 is saturated by A and D (both pass the area gate and outrank
  // every rescued fragment on all classic saliency terms), reproducing the
  // real-world starvation: rescued B/C never reach the budget-fill step.
  // Since #261 part 3 the reserve draws from WITHIN the total budget:
  // rescued fragments displace the lowest-ranked base clusters instead of
  // adding slots on top, so |active| never exceeds the budget.

  it("documents the starvation: with no reserve, rescued fragments lose every slot", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, { ...config, chainRescueBudget: 0 }, 1,
      () => 1.0,
      true
    );

    expect(result.activeClusterIds.has(f.A.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(false);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(false);
  });

  it("honours the total cap: the reserve displaces base clusters instead of adding slots", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, { ...config, chainRescueBudget: 2 }, 1,
      () => 1.0,
      true
    );

    // Reserve takes both slots; nothing is left for the base pool.
    expect(result.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.A.uid)).toBe(false);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(false);
    expect(result.activeCandidates).toHaveLength(2);
  });

  it("displaces only the lowest-ranked base cluster when the budget has headroom", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 3, { ...config, chainRescueBudget: 2 }, 1,
      () => 1.0,
      true
    );

    // Reserve = {B, C}; the single remaining base slot goes to A
    // (A and D tie on saliency, uid tie-break prefers A).
    expect(result.activeClusterIds.has(f.A.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(false);
    expect(result.activeCandidates).toHaveLength(3);
  });

  it("activates the full chain when the budget covers base + reserve", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 4, { ...config, chainRescueBudget: 2 }, 1,
      () => 1.0,
      true
    );

    expect(result.activeClusterIds.has(f.A.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(true);
    expect(result.activeCandidates).toHaveLength(4);
  });

  it("returns unused reserve slots to the base pool", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    // chainRescueBudget 3 but only 2 rescued candidates exist → the reserve
    // takes 2 slots, not 3, and the base pool keeps both A and D.
    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 4, { ...config, chainRescueBudget: 3 }, 1,
      () => 1.0,
      true
    );

    expect(result.activeClusterIds.has(f.A.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(true);
    expect(result.activeCandidates).toHaveLength(4);
  });

  it("caps the reserve pool at chainRescueBudget (deterministic pick)", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 3, { ...config, chainRescueBudget: 1 }, 1,
      () => 1.0,
      true
    );

    // Equal-saliency rescued fragments tie-break by uid: B wins the one slot;
    // the two base slots go to A and D.
    expect(result.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.C.uid)).toBe(false);
    expect(result.activeClusterIds.has(f.A.uid)).toBe(true);
    expect(result.activeClusterIds.has(f.D.uid)).toBe(true);
    expect(result.activeCandidates).toHaveLength(3);
  });

  it("budget 0 deactivates everything, even with an active reserve (#261 part 5: no-annotations mode)", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const result = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 0, { ...config, chainRescueBudget: 4 }, 1,
      () => 1.0,
      true
    );

    expect(result.activeCandidates).toHaveLength(0);
    expect(result.activeClusterIds.size).toBe(0);
  });

  it("keeps the reserve inert when no rescued candidates exist (crb > 0 ≡ crb = 0)", () => {
    // No selection ⇒ no rescue eligibility ⇒ the reserve pass must not
    // change anything relative to a plain single-pass budget.
    const f = mkGapFixture();
    const withReserve = new SemanticZoomService().computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, { ...config, chainRescueBudget: 4 }, 1,
      () => 1.0
    );
    _uid = 0;
    const g = mkGapFixture();
    const withoutReserve = new SemanticZoomService().computeActiveClusterIds(
      g.root, viewbox, xScale, yScale, 1000, 1000,
      g.membersOf, g.points, 2, { ...config, chainRescueBudget: 0 }, 1,
      () => 1.0
    );

    expect(Array.from(withReserve.activeClusterIds).sort()).toEqual(
      Array.from(withoutReserve.activeClusterIds).sort()
    );
  });

  it("busts the result cache when chainRescueBudget changes", () => {
    const f = mkGapFixture();
    const service = new SemanticZoomService();

    const first = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, { ...config, chainRescueBudget: 0 }, 1,
      () => 1.0,
      true
    );
    expect(first.activeClusterIds.has(f.B.uid)).toBe(false);

    const second = service.computeActiveClusterIds(
      f.root, viewbox, xScale, yScale, 1000, 1000,
      f.membersOf, f.points, 2, { ...config, chainRescueBudget: 2 }, 1,
      () => 1.0,
      true
    );
    expect(second.activeClusterIds.has(f.B.uid)).toBe(true);
    expect(second.activeClusterIds.has(f.C.uid)).toBe(true);
  });
});
