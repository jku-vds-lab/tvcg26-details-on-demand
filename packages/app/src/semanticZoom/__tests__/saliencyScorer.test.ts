/**
 * semanticZoom/__tests__/saliencyScorer.test.ts
 *
 * Unit tests for the saliency-based candidate scoring.
 *
 * Key properties verified:
 * 1. labelMinFraction filters out candidates with footprint too small (relative to viewport)
 * 2. Sorting is deterministic (same input → same order)
 * 3. Tie-breaking by uid is consistent
 * 4. DoI mass, stability, and footprint terms contribute correctly
 * 5. Returns empty array when no candidates pass filtering
 */

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { computeDoiMass, scoreCandidates } from "../saliencyScorer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _uid = 0;

function mkNode(
  id: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  stability: number,
  size: number = 1,
  children: number[] = []
): ClusterTreeNode {
  return {
    id,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 1,
    size,
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

// Scale: data [0,100] → screen [0,1000]  (10 px per unit)
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const viewportArea = 1_000_000; // 1000×1000 px²

// ---------------------------------------------------------------------------
// computeDoiMass tests
// ---------------------------------------------------------------------------

describe("computeDoiMass", () => {
  it("returns zero for empty member list", () => {
    expect(computeDoiMass([], [])).toBe(0);
  });

  it("sums DoI values for provided member indices", () => {
    const nodes = [mkPoint(0, 0.2), mkPoint(1, 0.5), mkPoint(2, 0.3)];
    expect(computeDoiMass([0, 2], nodes)).toBeCloseTo(0.5);
  });

  it("ignores out-of-range indices gracefully", () => {
    const nodes = [mkPoint(0, 0.5)];
    // index 99 does not exist; should not throw, treat as 0
    expect(computeDoiMass([0, 99], nodes)).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates tests
// ---------------------------------------------------------------------------

describe("scoreCandidates", () => {

  it("returns empty array when zoomCut is empty", () => {
    const result = scoreCandidates(
      [],
      (_n) => [],
      [],
      xScale,
      yScale,
      viewportArea,
      undefined,
      { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 }
    );
    expect(result).toHaveLength(0);
  });

  it("filters out candidates below labelMinFraction × splitThresholdPx", () => {
    // nodeA footprint = 50×50 data = 500×500 px = 250000 px²
    // nodeB footprint = 2×2 data = 20×20 px = 400 px²
    // labelMinFraction = 0.1, splitThresholdPx = 5000 → effective threshold = 500 px²
    //   nodeA: 250000 ≥ 500 → passes
    //   nodeB:    400  < 500 → filtered
    const nA = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const nB = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 1, [2]);
    const pts = [mkPoint(0, 0.8), mkPoint(1, 0.9), mkPoint(2, 0.1)];

    const membersOf = (n: ClusterTreeNode) => n.children ?? [];

    const result = scoreCandidates(
      [nA, nB],
      membersOf,
      pts,
      xScale,
      yScale,
      viewportArea,
      undefined,
      { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 }
    );
    expect(result).toHaveLength(1);
    expect(result[0].node.uid).toBe(nA.uid);
  });

  it("sorts candidates by saliency descending", () => {
    // nodeA: stability=10, doi=1.7, footprint=large → highest saliency
    // nodeB: stability=1,  doi=0.1, footprint=small → lower saliency
    const nA = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const nB = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 1, [2]);
    const pts = [mkPoint(0, 0.8), mkPoint(1, 0.9), mkPoint(2, 0.1)];

    const result = scoreCandidates(
      [nA, nB],
      (n) => n.children ?? [],
      pts,
      xScale,
      yScale,
      viewportArea,
      undefined,
      { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 }
    );
    expect(result).toHaveLength(2);
    expect(result[0].saliency).toBeGreaterThanOrEqual(result[1].saliency);
    // nA should be first given its much higher stability, doi mass, and footprint
    expect(result[0].node.uid).toBe(nA.uid);
  });

  it("is deterministic: identical inputs produce identical output", () => {
    const nA = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const nB = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 1, [2]);
    const pts = [mkPoint(0, 0.8), mkPoint(1, 0.9), mkPoint(2, 0.1)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 };

    const r1 = scoreCandidates([nA, nB], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg);
    const r2 = scoreCandidates([nA, nB], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg);

    expect(r1.map((c) => c.node.uid)).toEqual(r2.map((c) => c.node.uid));
    r1.forEach((c, i) => expect(c.saliency).toBeCloseTo(r2[i].saliency));
  });

  it("all saliency scores lie in [0, 1] when weights sum to 1", () => {
    const nodes = [
      mkNode(0, { minX: 0,  minY: 0,  maxX: 50, maxY: 50 }, 5, 1, [0]),
      mkNode(1, { minX: 50, minY: 50, maxX: 70, maxY: 70 }, 2, 1, [1]),
    ];
    const pts = [mkPoint(0, 0.5), mkPoint(1, 0.3)];
    // weights sum to 1.0
    const cfg = { stabilityWeight: 0.4, doiMassWeight: 0.4, footprintWeight: 0.2, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 };

    const result = scoreCandidates(
      nodes,
      (n) => n.children ?? [],
      pts,
      xScale,
      yScale,
      viewportArea,
      undefined,
      cfg
    );

    result.forEach((c) => {
      expect(c.saliency).toBeGreaterThanOrEqual(0);
      expect(c.saliency).toBeLessThanOrEqual(1 + 1e-9);
    });
  });

  it("rescues a sub-min-area cluster with high DoI density and whitespace", () => {
    // Big low-DoI cluster (passes area gate) + tiny all-selected cluster
    // (400 px² < 500 px² gate). Non-uniform DoI frame → rescue eligible.
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const rescuedResult = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    expect(rescuedResult.map((c) => c.node.uid)).toContain(tiny.uid);
    const tinyScored = rescuedResult.find((c) => c.node.uid === tiny.uid)!;
    expect(tinyScored.doiDensity).toBeCloseTo(1.0);

    // Same scene but the density threshold is unreachable → tiny is dropped.
    const strict = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined,
      { ...cfg, chainDoiThreshold: 1.01 },
      () => 1.0
    );
    expect(strict.map((c) => c.node.uid)).not.toContain(tiny.uid);

    // No whitespace callback → never rescued.
    const noProbe = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg
    );
    expect(noProbe.map((c) => c.node.uid)).not.toContain(tiny.uid);
  });

  it("does not rescue when the local neighborhood is crowded", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const crowded = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 0.3 // below RESCUE_WHITESPACE_MIN (0.5)
    );
    expect(crowded.map((c) => c.node.uid)).not.toContain(tiny.uid);
  });

  it("does not rescue singletons", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const single = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 1, [2]);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const r = scoreCandidates(
      [big, single], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    expect(r.map((c) => c.node.uid)).not.toContain(single.uid);
  });

  it("flags rescued candidates so the reserved slot pool can find them", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const r = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    expect(r.find((c) => c.node.uid === big.uid)!.rescued).toBe(false);
    expect(r.find((c) => c.node.uid === tiny.uid)!.rescued).toBe(true);
  });

  it("rescues a singleton only with trajectory through-flow evidence", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const single = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 1, [2]);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    // Through-flow true (stark-transition point on a selected trajectory) → rescued.
    const through = scoreCandidates(
      [big, single], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0,
      undefined,
      () => true
    );
    expect(through.map((c) => c.node.uid)).toContain(single.uid);

    // Through-flow false (lasso straggler / trajectory endpoint) → not rescued.
    const stray = scoreCandidates(
      [big, single], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0,
      undefined,
      () => false
    );
    expect(stray.map((c) => c.node.uid)).not.toContain(single.uid);

    // The callback must not affect multi-point rescue: a 2-member cluster
    // rescues regardless of what the singleton test would say.
    const pair = mkNode(2, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pairPts = [mkPoint(0, 0.1), mkPoint(1, 0.1), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const multi = scoreCandidates(
      [big, pair], (n) => n.children ?? [], pairPts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0,
      undefined,
      () => false
    );
    expect(multi.map((c) => c.node.uid)).toContain(pair.uid);
  });

  it("is inert under uniform DoI: no rescue, saliency identical to zero-weight run", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 1.0), mkPoint(1, 1.0), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const withWeight = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    // Uniform DoI (no selection) → rescue never fires even with whitespace 1.
    expect(withWeight.map((c) => c.node.uid)).not.toContain(tiny.uid);

    const zeroWeight = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined,
      { ...cfg, doiDensityWeight: 0 },
      () => 1.0
    );
    expect(withWeight.map((c) => c.node.uid)).toEqual(zeroWeight.map((c) => c.node.uid));
    withWeight.forEach((c, i) => expect(c.saliency).toBe(zeroWeight[i].saliency));
  });

  it("rescues under uniform DoI when the caller signals selection focus (rescueEligible)", () => {
    // Full-bundle lasso regime: the hierarchy only contains selected points,
    // all DoI = 1 (uniform).  DoI non-uniformity carries no signal, so the
    // caller passes rescueEligible = true (derived from the DoI-filtered
    // hierarchy).  Density ≥ threshold passes trivially at 1.0.
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 1.0), mkPoint(1, 1.0), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const r = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0,
      true
    );
    expect(r.map((c) => c.node.uid)).toContain(tiny.uid);

    // The score term must STAY inert under uniform DoI even while the
    // eligibility gate is open: saliencies byte-identical to a zero-weight run.
    const zeroWeight = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined,
      { ...cfg, doiDensityWeight: 0 },
      () => 1.0,
      true
    );
    expect(r.map((c) => c.node.uid)).toEqual(zeroWeight.map((c) => c.node.uid));
    r.forEach((c, i) => expect(c.saliency).toBe(zeroWeight[i].saliency));

    // rescueEligible = false forces the gate shut regardless of DoI shape.
    const forcedOff = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0,
      false
    );
    expect(forcedOff.map((c) => c.node.uid)).not.toContain(tiny.uid);
  });

  it("applies the density term as an absolute (non-normalized) value", () => {
    // Equal doiMass (1.8), equal stability, equal bbox — only density differs:
    // c1 = 2 members @ 0.9 → density 0.9; c2 = 4 members @ 0.45 → density 0.45.
    // A background point makes the frame non-uniform.
    const c1 = mkNode(0, { minX: 0, minY: 0, maxX: 30, maxY: 30 }, 5, 2, [0, 1]);
    const c2 = mkNode(1, { minX: 50, minY: 50, maxX: 80, maxY: 80 }, 5, 4, [2, 3, 4, 5]);
    const bg = mkNode(2, { minX: 90, minY: 90, maxX: 99, maxY: 99 }, 5, 1, [6]);
    const pts = [
      mkPoint(0, 0.9), mkPoint(1, 0.9),
      mkPoint(2, 0.45), mkPoint(3, 0.45), mkPoint(4, 0.45), mkPoint(5, 0.45),
      mkPoint(6, 0.0),
    ];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const r = scoreCandidates(
      [c1, c2, bg], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    const s1 = r.find((c) => c.node.uid === c1.uid)!;
    const s2 = r.find((c) => c.node.uid === c2.uid)!;
    // stability and doiMass terms cancel (identical raw values) with footprint
    // weight 0, so the difference is exactly the absolute density term.
    expect(s1.saliency - s2.saliency).toBeCloseTo(0.4 * (0.9 - 0.45), 10);
  });

  it("keeps large low-density clusters eligible via the area gate (union)", () => {
    const big = mkNode(0, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, 10, 2, [0, 1]);
    const tiny = mkNode(1, { minX: 60, minY: 60, maxX: 62, maxY: 62 }, 1, 2, [2, 3]);
    const pts = [mkPoint(0, 0.0), mkPoint(1, 0.0), mkPoint(2, 1.0), mkPoint(3, 1.0)];
    const cfg = { stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2, labelMinFraction: 0.1, splitThresholdPx: 5_000, doiDensityWeight: 0.4, chainDoiThreshold: 0.9 };

    const r = scoreCandidates(
      [big, tiny], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, cfg,
      () => 1.0
    );
    // Density-0 big cluster stays in via area; density-1 tiny comes in via rescue.
    expect(r.map((c) => c.node.uid).sort()).toEqual([big.uid, tiny.uid].sort());
  });

  it("tie-breaks by uid string for determinism", () => {
    // Two identical clusters that only differ in uid
    // Make both have very similar metrics by using same bbox and stability
    const n1 = mkNode(0, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1, 1, [0]);
    const n2 = mkNode(1, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1, 1, [0]);

    const pts = [mkPoint(0, 1.0)];

    const r = scoreCandidates(
      [n1, n2],
      (n) => n.children ?? [],
      pts,
      xScale,
      yScale,
      viewportArea,
      undefined,
      { stabilityWeight: 0.34, doiMassWeight: 0.33, footprintWeight: 0.33, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 }
    );
    // Same order on repeated calls
    const r2 = scoreCandidates(
      [n1, n2],
      (n) => n.children ?? [],
      pts,
      xScale,
      yScale,
      viewportArea,
      undefined,
      { stabilityWeight: 0.34, doiMassWeight: 0.33, footprintWeight: 0.33, labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0, chainDoiThreshold: 0.9 }
    );
    expect(r.map((c) => c.node.uid)).toEqual(r2.map((c) => c.node.uid));
  });
});
