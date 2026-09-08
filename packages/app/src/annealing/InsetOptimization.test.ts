import { describe, expect, it } from "@jest/globals";
import { scaleLinear } from "d3-scale";
import type RBush from "rbush";
import type { DataPoint, RTreeItem, SplineSegment } from "src/dataPreprocessing/dataPreprocessing";
import type { VisualElement } from "src/models/VisualElement";
import {
  computeDiffHoverNudge,
  computeVisualElementsCost,
  DerivedInset,
  generateVisualElementNeighbor,
  optimizeVisualElementsPositions,
} from "./InsetOptimization";

type Pos = { x: number; y: number };

// The stubs implement only the members the annealer touches, so they are
// funnelled through these single-purpose casts instead of scattered `as any`.
const asElement = (el: unknown) => el as VisualElement;
const asElements = (els: unknown[]) => els as VisualElement[];
const asNodeTree = (t: unknown) => t as RBush<RTreeItem<DataPoint>>;
const asEdgeTree = (t: unknown) => t as RBush<RTreeItem<SplineSegment>>;

type StubElement = {
  id: string;
  center: Pos;
  sourcePosition: Pos;
  samples: Array<unknown>;
  temperature: number;
  initialTemperature: number;
  movement: number;
  coolDown: (beta: number) => void;
  getScreenBoundingBoxFor: (
    center: Pos,
    x: (v: number) => number,
    y: (v: number) => number
  ) => { x: number; y: number; width: number; height: number };
};

function makeStubElement(id: string): StubElement {
  return {
    id,
    center: { x: 0.5, y: 0.5 },
    sourcePosition: { x: 0.5, y: 0.5 },
    // length > 1 enables R-tree density term
    samples: [{}, {}],
    temperature: 1,
    initialTemperature: 1,
    movement: 0,
    coolDown: (beta: number) => {
      void beta;
    },
    getScreenBoundingBoxFor: (center, x, y) => ({
      x: x(center.x) - 10,
      y: y(center.y) - 10,
      width: 20,
      height: 20,
    }),
  };
}

function makeTree(hitCount: number) {
  const hits = Array.from({ length: hitCount }, () => ({ data: {} }));
  return {
    search: () => hits,
  };
}

describe("optimizeVisualElementsPositions", () => {
  it("does not reuse stale R-tree density scores across optimization runs", () => {
    const x = scaleLinear().domain([0, 1]).range([0, 100]);
    const y = scaleLinear().domain([0, 1]).range([100, 0]);

    const el = makeStubElement("node-inset-0");
    const state = asElements([el]);
    const positions = new Map<string, Pos>([[el.id, { x: 0.5, y: 0.5 }]]);

    const denseNodeTree = makeTree(2);
    const denseEdgeTree = makeTree(0);

    const emptyNodeTree = makeTree(0);
    const emptyEdgeTree = makeTree(0);

    const weights = {
      wD: 0,
      wM: 0,
      wL: 0,
      wOS: 0,
      wDS: 0,
      wOI: 0,
      wDI: 0,
      wRTree: 1,
      hardInsetOverlapPenalty: 0,
      hardLeaderCrossingPenalty: 0,
      hardScatterOverlapPenalty: 0,
      hardForeignContourOverlapPenalty: 0,
      contourTargetRadiusMultiplier: 1.8,
    };

    const anneal = {
      maxIterations: 0,
      coolingRate: 0.99,
      jitterStrength: 0,
    };

    const viewbox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

    const runDense = optimizeVisualElementsPositions(
      state,
      positions,
      1,
      x,
      y,
      weights,
      asNodeTree(denseNodeTree),
      asEdgeTree(denseEdgeTree),
      viewbox,
      anneal
    );

    const runEmpty = optimizeVisualElementsPositions(
      state,
      positions,
      1,
      x,
      y,
      weights,
      asNodeTree(emptyNodeTree),
      asEdgeTree(emptyEdgeTree),
      viewbox,
      anneal
    );

    expect(runDense.diagnostics.initialCost).toBeGreaterThan(0);
    expect(runEmpty.diagnostics.initialCost).toBeCloseTo(0, 8);
  });

  it("returns zero movement when selected element temperature is zero", () => {
    const x = scaleLinear().domain([0, 1]).range([0, 100]);
    const y = scaleLinear().domain([0, 1]).range([100, 0]);

    const el = makeStubElement("node-inset-cold");
    el.temperature = 0;
    el.initialTemperature = 1;
    el.samples = [{}, {}];

    const positions = new Map<string, Pos>([[el.id, { x: 0.5, y: 0.5 }]]);
    const neighbor = generateVisualElementNeighbor(
      asElements([el]),
      positions,
      1,
      { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      x,
      y,
      0.2
    );

    expect(neighbor.movement).toBe(0);
    expect(neighbor.next).toEqual(neighbor.old);
  });
});

// ---------------------------------------------------------------------------
// computeVisualElementsCost — derived diff-inset overlap penalties
// ---------------------------------------------------------------------------

describe("computeVisualElementsCost — derived insets", () => {
  // Common scales: data [0,1] → screen [0,100] on X, [100,0] on Y.
  // Each stub element has a 20×20 screen box centred on its mapped position.
  const x = scaleLinear().domain([0, 1]).range([0, 100]);
  const y = scaleLinear().domain([0, 1]).range([100, 0]);
  const emptyTree = makeTree(0);
  const weights = {
    wD: 0, wM: 0, wL: 0, wOS: 0, wDS: 0,
    wOI: 1,  // soft overlap barrier active for thorough verification
    wDI: 0,
    wRTree: 0,
    hardInsetOverlapPenalty: 5000,
    hardLeaderCrossingPenalty: 0,
    hardScatterOverlapPenalty: 0,
    hardForeignContourOverlapPenalty: 0,
    contourTargetRadiusMultiplier: 1.8,
  };

  /** Baseline cost with no derived insets. */
  function baseCost(state: unknown[], positions: Map<string, Pos>): number {
    return computeVisualElementsCost(
      asElements(state), positions, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree)
    );
  }

  /** Cost with a derived-insets list appended. */
  function derivedCost(
    state: unknown[], positions: Map<string, Pos>, derived: DerivedInset[]
  ): number {
    return computeVisualElementsCost(
      asElements(state), positions, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree),
      undefined, undefined, derived
    );
  }

  it("adds no extra cost when derivedInsets is undefined or empty", () => {
    const el = makeStubElement("node-a");
    const positions = new Map<string, Pos>([["node-a", { x: 0.5, y: 0.5 }]]);
    const state = [el];
    const base = baseCost(state, positions);
    // undefined (implicit)
    expect(baseCost(state, positions)).toBe(base);
    // explicit empty array
    expect(derivedCost(state, positions, [])).toBe(base);
  });

  it("adds no extra cost when a derived inset's parent is absent from positions", () => {
    const el = makeStubElement("node-a");
    const positions = new Map<string, Pos>([["node-a", { x: 0.5, y: 0.5 }]]);
    const state = [el];
    const derived: DerivedInset[] = [{
      element: asElement(makeStubElement("diff-1")),
      nodeIdA: "ghost-a",   // not in positions
      nodeIdB: "ghost-b",
    }];
    expect(derivedCost(state, positions, derived)).toBe(baseCost(state, positions));
  });

  it("applies hardInsetOverlapPenalty when a derived inset box overlaps a node inset", () => {
    const el = makeStubElement("node-a");
    // Place both diff-inset parents at the same spot as the node inset
    // → derived midpoint = (0.5, 0.5) → full box overlap with node-a.
    const positions = new Map<string, Pos>([
      ["node-a",        { x: 0.5, y: 0.5 }],
      ["node-parent-a", { x: 0.5, y: 0.5 }],
      ["node-parent-b", { x: 0.5, y: 0.5 }],
    ]);
    const state = [el];
    const derived: DerivedInset[] = [{
      element: asElement(makeStubElement("diff-1")),
      nodeIdA: "node-parent-a",
      nodeIdB: "node-parent-b",
    }];
    const delta = derivedCost(state, positions, derived) - baseCost(state, positions);
    expect(delta).toBeGreaterThanOrEqual(weights.hardInsetOverlapPenalty);
  });

  it("adds no penalty when the derived inset and node inset are well separated", () => {
    const el = makeStubElement("node-a");
    el.center = { x: 0.1, y: 0.5 };
    el.sourcePosition = { x: 0.1, y: 0.5 };
    // Node-a is on the far left; diff parents are far to the right
    // → derived midpoint ≈ (0.9, 0.5), boxes are ~80 px apart → no overlap.
    const positions = new Map<string, Pos>([
      ["node-a",        { x: 0.1, y: 0.5 }],
      ["node-parent-a", { x: 0.85, y: 0.5 }],
      ["node-parent-b", { x: 0.95, y: 0.5 }],
    ]);
    const state = [el];
    const derived: DerivedInset[] = [{
      element: asElement(makeStubElement("diff-1")),
      nodeIdA: "node-parent-a",
      nodeIdB: "node-parent-b",
    }];
    const delta = derivedCost(state, positions, derived) - baseCost(state, positions);
    expect(delta).toBe(0);
  });

  it("applies hardInsetOverlapPenalty when two derived inset boxes overlap each other", () => {
    // No node insets needed — this tests the diff-vs-diff branch.
    // Both derived insets share the same parents → identical midpoints → full overlap.
    const positions = new Map<string, Pos>([
      ["node-a", { x: 0.3, y: 0.5 }],
      ["node-b", { x: 0.7, y: 0.5 }],
    ]);
    const derived: DerivedInset[] = [
      { element: asElement(makeStubElement("diff-1")), nodeIdA: "node-a", nodeIdB: "node-b" },
      { element: asElement(makeStubElement("diff-2")), nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const delta = derivedCost([], positions, derived) - baseCost([], positions);
    expect(delta).toBeGreaterThanOrEqual(weights.hardInsetOverlapPenalty);
  });

  // ---- Monotonicity tests for the depth-scaled penalty ----------------------

  it("node×node: deeper overlap costs strictly more than a shallow overlap", () => {
    // Two node insets: one centred at (0.5, 0.5), the other initially very close (small overlap)
    // then moved to the same position (full overlap).  Deeper should cost more.
    const elA = makeStubElement("node-a");
    const elB = makeStubElement("node-b");
    const state = [elA, elB];

    // Shallow: centres 18 px apart → boxes (20×20) overlap by 2 px band → oiRaw ≈ 2/20 = 0.1
    const positionsShallow = new Map<string, Pos>([
      ["node-a", { x: 0.4, y: 0.5 }],
      ["node-b", { x: 0.58, y: 0.5 }],   // |Δx|=18 screen px (0.18 in data → 18 px)
    ]);
    // Deep: same position → full overlap (oiRaw = 1 clamped to 0.999999)
    const positionsDeep = new Map<string, Pos>([
      ["node-a", { x: 0.5, y: 0.5 }],
      ["node-b", { x: 0.5, y: 0.5 }],
    ]);

    const costShallow = computeVisualElementsCost(
      asElements(state), positionsShallow, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree)
    );
    const costDeep = computeVisualElementsCost(
      asElements(state), positionsDeep, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree)
    );
    expect(costShallow).toBeGreaterThanOrEqual(weights.hardInsetOverlapPenalty);
    expect(costDeep).toBeGreaterThan(costShallow);
  });

  it("diff-vs-node: deeper overlap costs strictly more than a shallow overlap", () => {
    const elNode = makeStubElement("node-a");
    const state = [elNode];

    // Derived diff-inset element (20×20 box)
    const derived: DerivedInset[] = [{
      element: asElement(makeStubElement("diff-1")),
      nodeIdA: "parent-a",
      nodeIdB: "parent-b",
    }];

    // Shallow: diff midpoint 18 px to the right of node → oiRaw ≈ 0.1
    const posShallow = new Map<string, Pos>([
      ["node-a",   { x: 0.4,  y: 0.5 }],
      ["parent-a", { x: 0.49, y: 0.5 }],   // midpoint → (0.58, 0.5) → 18 px right of node
      ["parent-b", { x: 0.67, y: 0.5 }],
    ]);
    // Deep: diff midpoint exactly on node → full overlap
    const posDeep = new Map<string, Pos>([
      ["node-a",   { x: 0.5, y: 0.5 }],
      ["parent-a", { x: 0.5, y: 0.5 }],
      ["parent-b", { x: 0.5, y: 0.5 }],
    ]);

    const costShallow = computeVisualElementsCost(
      asElements(state), posShallow, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree),
      undefined, undefined, derived
    );
    const costDeep = computeVisualElementsCost(
      asElements(state), posDeep, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree),
      undefined, undefined, derived
    );
    expect(costShallow).toBeGreaterThanOrEqual(weights.hardInsetOverlapPenalty);
    expect(costDeep).toBeGreaterThan(costShallow);
  });

  it("diff-vs-diff: deeper overlap costs strictly more than a shallow overlap", () => {
    // Two diff insets: vary parent separation to control midpoint separation.
    // Shallow: midpoints 18 px apart.  Deep: midpoints coincide.
    const derived: DerivedInset[] = [
      { element: asElement(makeStubElement("diff-1")), nodeIdA: "a1", nodeIdB: "b1" },
      { element: asElement(makeStubElement("diff-2")), nodeIdA: "a2", nodeIdB: "b2" },
    ];

    // midpoint of diff-1 at x=0.39 (screen 39), midpoint of diff-2 at x=0.57 (screen 57) → |Δ|=18
    const posShallow = new Map<string, Pos>([
      ["a1", { x: 0.29, y: 0.5 }], ["b1", { x: 0.49, y: 0.5 }],
      ["a2", { x: 0.47, y: 0.5 }], ["b2", { x: 0.67, y: 0.5 }],
    ]);
    // Same midpoint for both
    const posDeep = new Map<string, Pos>([
      ["a1", { x: 0.4, y: 0.5 }], ["b1", { x: 0.6, y: 0.5 }],
      ["a2", { x: 0.4, y: 0.5 }], ["b2", { x: 0.6, y: 0.5 }],
    ]);

    const costShallow = computeVisualElementsCost(
      asElements([]), posShallow, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree),
      undefined, undefined, derived
    );
    const costDeep = computeVisualElementsCost(
      asElements([]), posDeep, x, y, weights,
      asNodeTree(emptyTree), asEdgeTree(emptyTree),
      undefined, undefined, derived
    );
    expect(costShallow).toBeGreaterThanOrEqual(weights.hardInsetOverlapPenalty);
    expect(costDeep).toBeGreaterThan(costShallow);
  });

  // ---- Existing round-1 tests (unchanged assertions) -------------------------

  it("diff-vs-diff cost disappears when parent nodes are spread so midpoints no longer overlap", () => {
    // diff-1: parents at (0.1, 0.5) and (0.3, 0.5) → midpoint at (0.2, 0.5) → screen x=20
    // diff-2: parents at (0.7, 0.5) and (0.9, 0.5) → midpoint at (0.8, 0.5) → screen x=80
    // Box width 20 px → [10,30] vs [70,90] → no overlap.
    const positions = new Map<string, Pos>([
      ["a1", { x: 0.1, y: 0.5 }], ["b1", { x: 0.3, y: 0.5 }],
      ["a2", { x: 0.7, y: 0.5 }], ["b2", { x: 0.9, y: 0.5 }],
    ]);
    const derived: DerivedInset[] = [
      { element: asElement(makeStubElement("diff-1")), nodeIdA: "a1", nodeIdB: "b1" },
      { element: asElement(makeStubElement("diff-2")), nodeIdA: "a2", nodeIdB: "b2" },
    ];
    const delta = derivedCost([], positions, derived) - baseCost([], positions);
    expect(delta).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeDiffHoverNudge
// ---------------------------------------------------------------------------

describe("computeDiffHoverNudge", () => {
  // Helper: build a {x,y,width,height} box centred at (cx,cy).
  const centredBox = (cx: number, cy: number, w: number, h: number) => ({
    x: cx - w / 2, y: cy - h / 2, width: w, height: h,
  });

  // Trivial linear scales: 1 px per data unit.
  const pxPerDataX = 1;
  const pxPerDataY = 1;

  it("returns null when the enlarged diff does not overlap either parent", () => {
    // A at screen (0,0), B at screen (200,0); diff at midpoint (100,0).
    // Diff 20×20, parents 20×20 — parents are 80 px from midpoint, diff half-extent=10 → no overlap.
    const result = computeDiffHoverNudge({
      diffBox:  centredBox(100,  0, 20, 20),   // midpoint of 0 and 200 ✓
      boxA:     centredBox(  0,  0, 20, 20),   // rightEdge=10, diffLeft=90 → no overlap
      boxB:     centredBox(200,  0, 20, 20),   // leftEdge=190, diffRight=110 → no overlap
      screenAX: 0, screenAY: 0,
      screenBX: 200, screenBY: 0,
      pxPerDataX, pxPerDataY,
    });
    expect(result).toBeNull();
  });

  it("returns symmetric deltas when enlarged diff overlaps both parents", () => {
    // A at screen (0,0), B at screen (100,0); diff at midpoint (50,0).
    // Parents 50×50 (halfW=25), diff 60×60 (halfW=30).
    // heD+heA = 55 > halfABDist=50 → penA=penB=5. Both parents move ±5 px → ±5 data units.
    const result = computeDiffHoverNudge({
      diffBox:  centredBox( 50, 0, 60, 60),   // midpoint of 0 and 100 ✓
      boxA:     centredBox(  0, 0, 50, 50),   // rightEdge=25, diffLeft=20 → overlap
      boxB:     centredBox(100, 0, 50, 50),   // leftEdge=75, diffRight=80 → overlap
      screenAX:   0, screenAY: 0,
      screenBX: 100, screenBY: 0,
      pxPerDataX, pxPerDataY,
    });
    expect(result).not.toBeNull();
    const { dA, dB } = result!;

    // A→B axis is horizontal, so y-deltas should be zero.
    expect(dA.y).toBeCloseTo(0);
    expect(dB.y).toBeCloseTo(0);

    // Midpoint invariant: dA.x + dB.x ≈ 0 (equal magnitude, opposite directions).
    expect(dA.x + dB.x).toBeCloseTo(0);
    expect(dA.x).toBeLessThan(0);  // A moves left (−u)
    expect(dB.x).toBeGreaterThan(0); // B moves right (+u)
  });

  it("returns symmetric deltas when only one parent overlaps (small A, large B)", () => {
    // A at screen (0,0), B at screen (100,0); diff at midpoint (50,0).
    // A is small (10×10, rightEdge=5); diff leftEdge=30 → A.rightEdge(5) < diffLeft(30) → no 2D overlap.
    // B is large (80×80, leftEdge=60); diff rightEdge=70 > B.leftEdge(60) → overlap.
    // heD=20, heB=40, penB = max(0, 20+40-50) = 10. delta=10.
    const result = computeDiffHoverNudge({
      diffBox:  centredBox( 50, 0, 40, 40),   // midpoint of 0 and 100 ✓
      boxA:     centredBox(  0, 0, 10, 10),   // tiny, no overlap with diff
      boxB:     centredBox(100, 0, 80, 80),   // large, overlaps diff
      screenAX:   0, screenAY: 0,
      screenBX: 100, screenBY: 0,
      pxPerDataX, pxPerDataY,
    });
    expect(result).not.toBeNull();
    const { dA, dB } = result!;

    // Midpoint invariant (symmetric, opposite).
    expect(dA.x + dB.x).toBeCloseTo(0);
    expect(dA.x).toBeLessThan(0);
    expect(dB.x).toBeGreaterThan(0);
  });
});

