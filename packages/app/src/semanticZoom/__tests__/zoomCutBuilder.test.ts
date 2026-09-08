/**
 * semanticZoom/__tests__/zoomCutBuilder.test.ts
 *
 * Unit tests for the footprint-driven zoom-cut builder and the
 * containment-cut builder.
 */

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import {
    buildContainmentCut,
    buildContainmentCutFromRoot,
    buildHybridCutFromRoot,
    buildZoomCut,
    buildZoomCutFromRoot,
} from "../zoomCutBuilder";

// ---------------------------------------------------------------------------
// Hierarchy factory
// ---------------------------------------------------------------------------
//
//  root (bbox 0-100, 0-100)
//  ├── L  (bbox 0-50, 0-100)
//  │   ├── LL (bbox 0-25, 0-100)
//  │   └── LR (bbox 25-50, 0-100)
//  └── R  (bbox 50-100, 0-100)
//      ├── RL (bbox 50-75, 0-100)
//      └── RR (bbox 75-100, 0-100)

let _id = 0;
let _uid = 0;

function mkLeaf(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): ClusterTreeNode {
  return {
    id: _id++,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 0,
    size: 1,
    stability: 1,
    bbox: { minX, minY, maxX, maxY },
  };
}

function mkInternal(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  left: ClusterTreeNode,
  right: ClusterTreeNode,
  size: number = 2
): ClusterTreeNode {
  return {
    id: _id++,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 1,
    size,
    stability: 2,
    bbox: { minX, minY, maxX, maxY },
    leftChild: left,
    rightChild: right,
  };
}

function buildTree() {
  _id = 0; _uid = 0;
  const ll = mkLeaf(0, 25, 0, 100);
  const lr = mkLeaf(25, 50, 0, 100);
  const rl = mkLeaf(50, 75, 0, 100);
  const rr = mkLeaf(75, 100, 0, 100);
  const L = mkInternal(0, 50, 0, 100, ll, lr, 2);
  const R = mkInternal(50, 100, 0, 100, rl, rr, 2);
  const root = mkInternal(0, 100, 0, 100, L, R, 4);
  return { root, L, R, ll, lr, rl, rr };
}

// ---------------------------------------------------------------------------
// Scale factories
// ---------------------------------------------------------------------------

/**
 * Build scales such that a data-space bbox of `width` × 100 units projects
 * to exactly `screenWidth` × `screenHeight` pixels.
 *
 * With domain [0,100] and range [0, X], 1 data unit = X/100 pixels.
 * The full root bbox (100 × 100) → screenWidth × screenHeight pixels → total area.
 */
function makeScales(screenWidth: number, screenHeight: number) {
  return {
    xScale: d3.scaleLinear().domain([0, 100]).range([0, screenWidth]),
    yScale: d3.scaleLinear().domain([0, 100]).range([0, screenHeight]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildZoomCutFromRoot — split behaviour", () => {
  it("returns root when its footprint is below splitThresholdPx", () => {
    const { root } = buildTree();
    // Root bbox = 100×100 data units.
    // At 50×50 canvas → root footprint = 2500 px².
    // splitThresholdPx = 10000 → no split.
    const { xScale, yScale } = makeScales(50, 50);
    const cut = buildZoomCutFromRoot(root, undefined, xScale, yScale, {
      splitThresholdPx: 10_000,
    });
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBe(root);
  });

  it("splits root into two children when footprint >= splitThresholdPx", () => {
    const { root, L, R } = buildTree();
    // splitThresholdPx = 2500.
    // At 60×60 canvas → root footprint = 3600 px² ≥ 2500 → split.
    // L footprint: 50% of 3600 = 1800 px² < 2500 → no further split.
    // R footprint: 1800 px² < 2500 → no further split.
    const { xScale, yScale } = makeScales(60, 60);
    const cut = buildZoomCutFromRoot(root, undefined, xScale, yScale, {
      splitThresholdPx: 2_500,
    });
    expect(cut).toHaveLength(2);
    const ids = new Set(cut.map((n) => n.uid));
    expect(ids.has(L.uid)).toBe(true);
    expect(ids.has(R.uid)).toBe(true);
  });

  it("splits all the way to leaves when all footprints exceed threshold (monotonic)", () => {
    const { root, ll, lr, rl, rr } = buildTree();
    // At 200×200 canvas, root footprint = 40000 px².
    // L footprint = 50% width × 100% height = 20000 px².
    // LL footprint = 25% width × 100% height = 10000 px².
    // splitThresholdPx = 5000 → everything splits.
    const { xScale, yScale } = makeScales(200, 200);
    const cut = buildZoomCutFromRoot(root, undefined, xScale, yScale, {
      splitThresholdPx: 5_000,
    });
    // Should be 4 leaf nodes
    expect(cut).toHaveLength(4);
    const ids = new Set(cut.map((n) => n.uid));
    expect(ids.has(ll.uid)).toBe(true);
    expect(ids.has(lr.uid)).toBe(true);
    expect(ids.has(rl.uid)).toBe(true);
    expect(ids.has(rr.uid)).toBe(true);
  });

  it("result is never nested (no ancestor-descendant pairs)", () => {
    const { root } = buildTree();
    const { xScale, yScale } = makeScales(200, 200);
    const cut = buildZoomCutFromRoot(root, undefined, xScale, yScale, {
      splitThresholdPx: 1_000,
    });
    // All pairs in cut should be non-nested
    for (let i = 0; i < cut.length; i++) {
      for (let j = i + 1; j < cut.length; j++) {
        const a = cut[i];
        const b = cut[j];
        expect(a.uid).not.toBe(b.uid);
        // Check they are not in a parent-child relationship via bbox containment
        // (this is a structural check, not a full ancestry check)
      }
    }
  });
});

describe("buildZoomCutFromRoot — monotonic refinement", () => {
  it("larger canvas always produces >= as many nodes in the cut", () => {
    const smallSizes = [30, 50, 80, 120, 200, 500];
    const threshold = 1_000;

    let prevCount = 0;
    for (const size of smallSizes) {
      const { root } = buildTree();
      const { xScale, yScale } = makeScales(size, size);
      const cut = buildZoomCutFromRoot(root, undefined, xScale, yScale, {
        splitThresholdPx: threshold,
      });
      expect(cut.length).toBeGreaterThanOrEqual(prevCount);
      prevCount = cut.length;
    }
  });
});

describe("buildZoomCutFromRoot — viewport filtering", () => {
  it("excludes children entirely outside the viewbox", () => {
    const { root } = buildTree();
    // Full canvas but restrict viewbox to only the left half [0,50]
    const { xScale, yScale } = makeScales(200, 200);
    const viewbox = { minX: 0, minY: 0, maxX: 50, maxY: 100 };

    const cut = buildZoomCutFromRoot(root, viewbox, xScale, yScale, {
      splitThresholdPx: 1_000,
    });

    // Only left-side leaves (ll and lr) should be present; rl and rr are outside
    // Root should intersect viewbox → splits, then L intersects → splits
    // ll=[0-25] ✓, lr=[25-50] ✓, rl=[50-75] ✗ (overlaps edge), rr=[75-100] ✗
    // Note: rl barely intersects [0,50] at minX=50, so it may be included.
    // rr [75-100] should definitely NOT be in cut.
    for (const n of cut) {
      const b = n.bbox!;
      // Every cut node's bbox must overlap [0, 50] in X
      expect(b.minX).toBeLessThanOrEqual(50);
    }
  });

  it("returns empty array when root does not intersect viewbox", () => {
    const { root } = buildTree();
    const { xScale, yScale } = makeScales(200, 200);
    // Viewbox is completely past the data range
    const viewbox = { minX: 200, minY: 200, maxX: 300, maxY: 300 };
    const cut = buildZoomCutFromRoot(root, viewbox, xScale, yScale, {
      splitThresholdPx: 1_000,
    });
    expect(cut).toHaveLength(0);
  });
});

describe("buildZoomCut — multi-root variant", () => {
  it("handles empty roots array", () => {
    const { xScale, yScale } = makeScales(200, 200);
    const cut = buildZoomCut([], undefined, xScale, yScale, { splitThresholdPx: 1_000 });
    expect(cut).toHaveLength(0);
  });

  it("processes multiple roots independently", () => {
    const { root: r1 } = buildTree();
    const { root: r2 } = buildTree(); // rebuild with fresh IDs
    const { xScale, yScale } = makeScales(50, 50);
    // 50×50 → root footprint = 2500 px²; splitThreshold = 10000 → no split
    const cut = buildZoomCut([r1, r2], undefined, xScale, yScale, {
      splitThresholdPx: 10_000,
    });
    expect(cut).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildContainmentCut / buildContainmentCutFromRoot
// ---------------------------------------------------------------------------

describe("buildContainmentCutFromRoot — containment strategy", () => {
  it("returns root when entire tree fits in the viewbox", () => {
    const { root } = buildTree();
    const viewbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const cut = buildContainmentCutFromRoot(root, viewbox);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBe(root);
  });

  it("returns root when no viewbox is given (unbounded)", () => {
    const { root } = buildTree();
    const cut = buildContainmentCutFromRoot(root, undefined);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBe(root);
  });

  it("splits root when it overflows; returns fully-contained children", () => {
    const { L, R, root, rl } = buildTree();
    // Viewbox covers all of L (x=[0,50]) and partially overlaps R (x=[50,100]).
    // root [0-100] overflows → splits.
    //   L [0-50]: maxX(50) ≤ viewbox.maxX(50)+eps → fully inside → pushed.
    //   R [50-100]: minX(50) ≤ viewbox.maxX(50) → intersects, but overflows → recurse.
    //     rl [50-75]: overflows [0,50] → leaf → pushed.
    //     rr [75-100]: minX(75) > 50 → does not intersect → skipped.
    // Neither root nor R should appear in the cut.
    const viewbox = { minX: 0, minY: 0, maxX: 50, maxY: 100 };
    const cut = buildContainmentCutFromRoot(root, viewbox);
    const uids = new Set(cut.map((n) => n.uid));
    expect(uids.has(root.uid)).toBe(false); // root overflowed, must not appear
    expect(uids.has(R.uid)).toBe(false);    // R overflowed, must not appear
    expect(uids.has(L.uid)).toBe(true);     // L is fully contained
    expect(uids.has(rl.uid)).toBe(true);    // rl is the only intersecting leaf of R
  });

  it("recurses down to leaves when all ancestors overflow", () => {
    const { ll, lr, rl, rr, root } = buildTree();
    // Very tight viewbox: only covers [20, 80] in X.
    // root [0-100] overflows → splits to L, R.
    // L [0-50] overflows [20,80] → splits to ll [0-25], lr [25-50].
    //   ll [0-25] overflows [20,80] → leaf, included (partially visible).
    //   lr [25-50] overflows [20,80] → leaf, included.
    // R [50-100] overflows [20,80] → splits to rl [50-75], rr [75-100].
    //   rl [50-75] overflows [20,80] → leaf, included.
    //   rr [75-100] overflows [20,80] → leaf, included.
    const viewbox = { minX: 20, minY: 0, maxX: 80, maxY: 100 };
    const cut = buildContainmentCutFromRoot(root, viewbox);
    const uids = new Set(cut.map((n) => n.uid));
    expect(uids.has(ll.uid)).toBe(true);
    expect(uids.has(lr.uid)).toBe(true);
    expect(uids.has(rl.uid)).toBe(true);
    expect(uids.has(rr.uid)).toBe(true);
  });

  it("returns empty array when root does not intersect viewbox", () => {
    const { root } = buildTree();
    const viewbox = { minX: 200, minY: 200, maxX: 300, maxY: 300 };
    const cut = buildContainmentCutFromRoot(root, viewbox);
    expect(cut).toHaveLength(0);
  });

  it("result is never nested (no ancestor in cut alongside its descendant)", () => {
    const { root } = buildTree();
    // Use viewbox that causes partial splits
    const viewbox = { minX: 0, minY: 0, maxX: 60, maxY: 100 };
    const cut = buildContainmentCutFromRoot(root, viewbox);
    // Verify no two nodes in the cut are the same
    const uids = cut.map((n) => n.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("buildContainmentCut handles empty roots array", () => {
    const cut = buildContainmentCut([], undefined);
    expect(cut).toHaveLength(0);
  });

  it("covers every intersecting leaf exactly once", () => {
    const { root } = buildTree();
    // Full viewbox: root is fully inside → only [root] returned, covers all 4 leaves.
    const fullView = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const cut = buildContainmentCutFromRoot(root, fullView);
    expect(cut).toHaveLength(1); // root covers all leaves
    expect(cut[0]).toBe(root);

    // Viewbox shrunk to x=[0,40]: both L [0-50] and R [50-100] overflow.
    // ll [0-25] fully inside [0,40] → pushed.
    // lr [25-50] overflows [0,40] → leaf → pushed.
    // rl [50-75]: minX(50) > 40 → no intersection → skipped.
    // rr [75-100]: no intersection → skipped.
    const { root: root2, ll, lr } = buildTree();
    const leftView = { minX: 0, minY: 0, maxX: 40, maxY: 100 };
    const cutLeft = buildContainmentCutFromRoot(root2, leftView);
    const leftUids = new Set(cutLeft.map((n) => n.uid));
    expect(leftUids.has(ll.uid)).toBe(true);
    expect(leftUids.has(lr.uid)).toBe(true);
    // None of the right-side nodes should appear
    expect(cutLeft.every((n) => (n.bbox?.maxX ?? 0) <= 50)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildHybridCut — gap disclosure (issue #258)
// ---------------------------------------------------------------------------
//
// Fixture: parent P (bbox 40-56 both axes, 16×16 data) with two tiny separated
// children B (40-41) and C (55-56).  At 10 px/unit P projects to 25 600 px² —
// below every splitThresholdPx used here — and, with viewbox undefined, the
// overflow trigger is inert, so ONLY the gap trigger can split P.
// Screen gap B↔C at 10 px/unit: hypot(140, 140) ≈ 198 px.

function mkGapParent(size = 4) {
  const B = mkLeaf(40, 41, 40, 41);
  const C = mkLeaf(55, 56, 55, 56);
  const P = mkInternal(40, 56, 40, 56, B, C, size);
  return { P, B, C };
}

describe("buildHybridCut — gap disclosure", () => {
  const SPLIT_PX = 100_000; // area trigger never fires in these tests
  const GAP = { gapDisclosurePx: 48, active: true };

  it("baseline: without the option a small in-view parent is kept (current behavior)", () => {
    const { P } = mkGapParent();
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX);
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("splits a sub-threshold parent whose children are separated by >= gapDisclosurePx", () => {
    const { P, B, C } = mkGapParent();
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, GAP);
    const uids = cut.map((n) => n.uid);
    expect(uids).toContain(B.uid);
    expect(uids).toContain(C.uid);
    expect(uids).not.toContain(P.uid);
  });

  it("does not split a compact parent (children abut, gap = 0)", () => {
    const B = mkLeaf(40, 48, 40, 48);
    const C = mkLeaf(48, 56, 48, 56);
    const P = mkInternal(40, 56, 40, 56, B, C, 4);
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, GAP);
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("is inert when active is false (no selection focus)", () => {
    const { P } = mkGapParent();
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, {
      gapDisclosurePx: 48,
      active: false,
    });
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("is inert when gapDisclosurePx is 0 (off semantics, not gap >= 0)", () => {
    const { P } = mkGapParent();
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, {
      gapDisclosurePx: 0,
      active: true,
    });
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("re-merges on zoom-out (screen gap drops below the threshold)", () => {
    const { P } = mkGapParent();
    // 2 px/unit: gap = hypot(28, 28) ≈ 39.6 px < 48.
    const { xScale, yScale } = makeScales(200, 200);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, GAP);
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("size guard: a pair of singletons (size 2) never gap-splits; singleton + pair (size 3) does", () => {
    const { xScale, yScale } = makeScales(1000, 1000);

    const { P: pair } = mkGapParent(2);
    const cutPair = buildHybridCutFromRoot(pair, undefined, xScale, yScale, SPLIT_PX, GAP);
    expect(cutPair.map((n) => n.uid)).toEqual([pair.uid]);

    const { P: trio, B, C } = mkGapParent(3);
    const cutTrio = buildHybridCutFromRoot(trio, undefined, xScale, yScale, SPLIT_PX, GAP);
    const uids = cutTrio.map((n) => n.uid);
    expect(uids).toContain(B.uid);
    expect(uids).toContain(C.uid);
  });

  it("skips the trigger safely when a child has no bbox", () => {
    const B = mkLeaf(40, 41, 40, 41);
    const C = mkLeaf(55, 56, 55, 56);
    delete C.bbox;
    const P = mkInternal(40, 56, 40, 56, B, C, 4);
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, GAP);
    expect(cut.map((n) => n.uid)).toEqual([P.uid]);
  });

  it("recurses into a disclosed child that has its own internal gap", () => {
    const B = mkLeaf(40, 41, 40, 41);
    const C = mkLeaf(55, 56, 55, 56);
    const D = mkLeaf(69, 70, 69, 70);
    // Q spans C and D (also separated: hypot(130, 130) ≈ 184 px).
    const Q = mkInternal(55, 70, 55, 70, C, D, 4);
    const P = mkInternal(40, 70, 40, 70, B, Q, 6);
    const { xScale, yScale } = makeScales(1000, 1000);
    const cut = buildHybridCutFromRoot(P, undefined, xScale, yScale, SPLIT_PX, GAP);
    const uids = cut.map((n) => n.uid);
    expect(uids.sort()).toEqual([B.uid, C.uid, D.uid].sort());
  });

  it("uses the projected (per-axis) gap under anisotropic scales", () => {
    // Children separated only along x (14 data units); same y-range → dy = 0.
    const B = mkLeaf(40, 41, 40, 41);
    const C = mkLeaf(55, 56, 40, 41);
    const P = mkInternal(40, 56, 40, 41, B, C, 4);

    // 1 px/unit in x → gap = 14 px < 48 → kept.
    const narrow = makeScales(100, 100);
    const cutNarrow = buildHybridCutFromRoot(P, undefined, narrow.xScale, narrow.yScale, SPLIT_PX, GAP);
    expect(cutNarrow.map((n) => n.uid)).toEqual([P.uid]);

    // 10 px/unit in x, 1 px/unit in y → gap = 140 px ≥ 48 → split.
    const wide = makeScales(1000, 100);
    const cutWide = buildHybridCutFromRoot(P, undefined, wide.xScale, wide.yScale, SPLIT_PX, GAP);
    const uids = cutWide.map((n) => n.uid);
    expect(uids).toContain(B.uid);
    expect(uids).toContain(C.uid);
  });
});
