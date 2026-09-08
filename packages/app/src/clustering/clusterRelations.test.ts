import { describe, expect, it } from "@jest/globals";
import type { DataPoint, TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";
import { clusterOf, consolidateRelations, extractClusterRelations } from "./clusterRelations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = 0;
function makePoint(opts: {
  insetClusterId?: string;
  annotationClusterId?: string;
}): DataPoint {
  const id = nextId++;
  return {
    x: 0,
    y: 0,
    line: 0,
    algo: "",
    id,
    action: "",
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    insetClusterId: opts.insetClusterId,
    annotationClusterId: opts.annotationClusterId,
  } as DataPoint;
}

function makeMidpoint(
  startPoint: DataPoint,
  endPoint: DataPoint,
  action = "A"
): TrajectoryMidpoint {
  return {
    id: nextId++,
    midPoint: {
      x: (startPoint.x + endPoint.x) / 2,
      y: (startPoint.y + endPoint.y) / 2,
    },
    startPoint,
    endPoint,
    action,
    DoI: 1,
  };
}

// ---------------------------------------------------------------------------
// clusterOf
// ---------------------------------------------------------------------------

describe("clusterOf", () => {
  it("returns insetClusterId when it is in the active inset set", () => {
    const pt = makePoint({ insetClusterId: "0x1" });
    expect(clusterOf(pt, new Set(["0x1"]), new Set())).toBe("0x1");
  });

  it("returns annotationClusterId when inset is absent but annotation is active", () => {
    const pt = makePoint({ annotationClusterId: "0x2" });
    expect(clusterOf(pt, new Set(), new Set(["0x2"]))).toBe("0x2");
  });

  it("prefers inset cluster over annotation cluster when both are present", () => {
    const pt = makePoint({ insetClusterId: "0x1", annotationClusterId: "0x2" });
    expect(clusterOf(pt, new Set(["0x1"]), new Set(["0x2"]))).toBe("0x1");
  });

  it("returns null when the point is not in any active cluster", () => {
    const pt = makePoint({ insetClusterId: "0x1" });
    expect(clusterOf(pt, new Set(), new Set())).toBeNull();
  });

  it("returns null when the point has no cluster assignments", () => {
    const pt = makePoint({});
    expect(clusterOf(pt, new Set(["0x1"]), new Set(["0x2"]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractClusterRelations
// ---------------------------------------------------------------------------

describe("extractClusterRelations", () => {
  it("extracts a simple one-hop A→B relation", () => {
    const ptA = makePoint({ insetClusterId: "0xA" });
    const ptB = makePoint({ insetClusterId: "0xB" });
    const m = makeMidpoint(ptA, ptB);

    const inset = new Set(["0xA", "0xB"]);
    const ann = new Set<string>();
    const sizes = new Map([["0xA", 10], ["0xB", 10]]);

    const rels = extractClusterRelations([m], inset, ann, sizes);
    expect(rels).toHaveLength(1);
    expect(rels[0].uidA).toBe("0xA");
    expect(rels[0].uidB).toBe("0xB");
    expect(rels[0].support).toBe(1);
  });

  it("carries midSamples from m.midPoint — length matches support, values match", () => {
    const ptA = makePoint({ insetClusterId: "0xA" });
    const ptB = makePoint({ insetClusterId: "0xB" });
    const m = makeMidpoint(ptA, ptB);
    // Override midPoint to a distinct value so we can verify it's threaded through
    m.midPoint = { x: 7, y: 11 };

    const rels = extractClusterRelations(
      [m],
      new Set(["0xA", "0xB"]),
      new Set(),
      new Map([["0xA", 10], ["0xB", 10]])
    );
    expect(rels[0].midSamples).toHaveLength(1);
    expect(rels[0].midSamples[0]).toEqual({ x: 7, y: 11 });
  });

  it("ignores midpoints where start and end are in the same cluster", () => {
    const ptA1 = makePoint({ insetClusterId: "0xA" });
    const ptA2 = makePoint({ insetClusterId: "0xA" });
    const m = makeMidpoint(ptA1, ptA2);

    const rels = extractClusterRelations(
      [m],
      new Set(["0xA"]),
      new Set(),
      new Map([["0xA", 10]])
    );
    expect(rels).toHaveLength(0);
  });

  it("ignores midpoints where either endpoint is not in any active cluster", () => {
    const ptA = makePoint({ insetClusterId: "0xA" });
    const ptNoise = makePoint({});
    const m = makeMidpoint(ptA, ptNoise);

    const rels = extractClusterRelations(
      [m],
      new Set(["0xA"]),
      new Set(),
      new Map([["0xA", 10]])
    );
    expect(rels).toHaveLength(0);
  });

  it("accumulates action histogram correctly", () => {
    const ptA = makePoint({ insetClusterId: "0xA" });
    const ptB = makePoint({ insetClusterId: "0xB" });
    const m1 = makeMidpoint(ptA, ptB, "left");
    const m2 = makeMidpoint(ptA, ptB, "right");
    const m3 = makeMidpoint(ptA, ptB, "left");

    const rels = extractClusterRelations(
      [m1, m2, m3],
      new Set(["0xA", "0xB"]),
      new Set(),
      new Map([["0xA", 10], ["0xB", 10]])
    );
    expect(rels[0].actionHistogram).toEqual({ left: 2, right: 1 });
  });

  it("ranks high-support relation above low-support relation", () => {
    // Cluster C→D has 100% purity but tiny support (1 transition)
    // Cluster A→B has more support (20 transitions) and equal purity
    const ptC = makePoint({ insetClusterId: "0xC" });
    const ptD = makePoint({ insetClusterId: "0xD" });

    const inset = new Set(["0xA", "0xB", "0xC", "0xD"]);
    const sizes = new Map([
      ["0xA", 50], ["0xB", 50], ["0xC", 5], ["0xD", 5],
    ]);
    const midpointsAB = Array.from({ length: 20 }, () => {
      const s = makePoint({ insetClusterId: "0xA" });
      const e = makePoint({ insetClusterId: "0xB" });
      return makeMidpoint(s, e);
    });
    const midpointsCD = [makeMidpoint(ptC, ptD)];
    const allMidpoints = [...midpointsAB, ...midpointsCD];

    const rels = extractClusterRelations(allMidpoints, inset, new Set(), sizes);
    expect(rels.length).toBeGreaterThanOrEqual(2);
    // A→B should rank above C→D (support factor dominates when purity is equal)
    const abIdx = rels.findIndex((r) => r.uidA === "0xA" && r.uidB === "0xB");
    const cdIdx = rels.findIndex((r) => r.uidA === "0xC" && r.uidB === "0xD");
    expect(abIdx).toBeLessThan(cdIdx);
  });

  it("does not produce relations from midpoints with no active cluster assignments", () => {
    const ptNoise1 = makePoint({});
    const ptNoise2 = makePoint({});
    const m = makeMidpoint(ptNoise1, ptNoise2);

    const rels = extractClusterRelations([m], new Set(["0xA"]), new Set(), new Map());
    expect(rels).toHaveLength(0);
  });

  it("works with annotation clusters in addition to inset clusters", () => {
    const ptA = makePoint({ annotationClusterId: "0xA" });
    const ptB = makePoint({ annotationClusterId: "0xB" });
    const m = makeMidpoint(ptA, ptB);

    const rels = extractClusterRelations(
      [m],
      new Set(),
      new Set(["0xA", "0xB"]),
      new Map([["0xA", 10], ["0xB", 10]])
    );
    expect(rels).toHaveLength(1);
    expect(rels[0].uidA).toBe("0xA");
    expect(rels[0].uidB).toBe("0xB");
  });

  it("exposes sizeA and sizeB from clusterSizes map", () => {
    const ptA = makePoint({ insetClusterId: "0xA" });
    const ptB = makePoint({ insetClusterId: "0xB" });
    const m = makeMidpoint(ptA, ptB);
    const rels = extractClusterRelations(
      [m],
      new Set(["0xA", "0xB"]),
      new Set(),
      new Map([["0xA", 7], ["0xB", 13]])
    );
    expect(rels[0].sizeA).toBe(7);
    expect(rels[0].sizeB).toBe(13);
  });

  it("returns relations sorted by score descending", () => {
    // Build two relations with clearly different scores
    // Relation 1: 10 transitions, 100% purity, large clusters
    // Relation 2: 1 transition, 100% purity, large clusters
    const midpoints: TrajectoryMidpoint[] = [];
    for (let i = 0; i < 10; i++) {
      midpoints.push(
        makeMidpoint(
          makePoint({ insetClusterId: "0xA" }),
          makePoint({ insetClusterId: "0xB" })
        )
      );
    }
    midpoints.push(
      makeMidpoint(
        makePoint({ insetClusterId: "0xC" }),
        makePoint({ insetClusterId: "0xD" })
      )
    );

    const inset = new Set(["0xA", "0xB", "0xC", "0xD"]);
    const sizes = new Map([
      ["0xA", 20], ["0xB", 20], ["0xC", 20], ["0xD", 20],
    ]);
    const rels = extractClusterRelations(midpoints, inset, new Set(), sizes);

    for (let i = 1; i < rels.length; i++) {
      expect(rels[i - 1].score).toBeGreaterThanOrEqual(rels[i].score);
    }
  });
});

// ---------------------------------------------------------------------------
// consolidateRelations
// ---------------------------------------------------------------------------

describe("consolidateRelations", () => {
  function makeRelation(
    uidA: string,
    uidB: string,
    support: number,
    score: number,
    sizeA = 10,
    sizeB = 10,
  ) {
    return {
      uidA,
      uidB,
      support,
      actionHistogram: { A: support },
      startSamples: [makePoint({ insetClusterId: uidA })],
      endSamples: [makePoint({ insetClusterId: uidB })],
      midSamples: [{ x: 0, y: 0 }],
      score,
      sizeA,
      sizeB,
    };
  }

  it("collapses A→B and B→A into one record", () => {
    const rels = [makeRelation("0xA", "0xB", 10, 0.8), makeRelation("0xB", "0xA", 5, 0.4)];
    const cons = consolidateRelations(rels);
    expect(cons).toHaveLength(1);
    expect(cons[0].uidA).toBe("0xA");
    expect(cons[0].uidB).toBe("0xB");
    expect(cons[0].forwardSupport).toBe(10); // 0xA→0xB is canonical forward
    expect(cons[0].backwardSupport).toBe(5);
    expect(cons[0].score).toBeCloseTo(0.8 + 0.4);
  });

  it("canonical key is stable regardless of input order", () => {
    const r1 = [makeRelation("0xB", "0xA", 3, 0.3), makeRelation("0xA", "0xB", 7, 0.7)];
    const r2 = [makeRelation("0xA", "0xB", 7, 0.7), makeRelation("0xB", "0xA", 3, 0.3)];
    const c1 = consolidateRelations(r1);
    const c2 = consolidateRelations(r2);
    expect(c1[0].uidA).toBe(c2[0].uidA);
    expect(c1[0].uidB).toBe(c2[0].uidB);
  });

  it("one-directional relation produces zero reverse support", () => {
    const rels = [makeRelation("0xA", "0xB", 10, 0.8)];
    const cons = consolidateRelations(rels);
    expect(cons).toHaveLength(1);
    expect(cons[0].backwardSupport).toBe(0);
    expect(cons[0].backwardScore).toBe(0);
    expect(cons[0].forwardScore).toBeCloseTo(0.8);
  });

  it("dominant direction (higher score) provides samples", () => {
    // 0xB→0xA has higher score, so its samples should be used
    const weakFwd = makeRelation("0xA", "0xB", 1, 0.1);
    const strongBwd = makeRelation("0xB", "0xA", 20, 0.9);
    const cons = consolidateRelations([weakFwd, strongBwd]);
    // strongBwd.startSamples are 0xB points — they become the glyph source
    expect(cons[0].startSamples).toBe(strongBwd.startSamples);
  });

  it("sorts by combined score descending", () => {
    const rels = [
      makeRelation("0xA", "0xB", 1, 0.1),
      makeRelation("0xC", "0xD", 10, 0.9),
    ];
    const cons = consolidateRelations(rels);
    expect(cons[0].uidA).toBe("0xC");
    expect(cons[1].uidA).toBe("0xA");
  });

  it("independent pairs are not merged", () => {
    const rels = [
      makeRelation("0xA", "0xB", 5, 0.5),
      makeRelation("0xC", "0xD", 5, 0.5),
    ];
    const cons = consolidateRelations(rels);
    expect(cons).toHaveLength(2);
  });

  it("empty input returns empty array", () => {
    expect(consolidateRelations([])).toHaveLength(0);
  });

  it("midSamples from the dominant direction are carried through to the consolidated result", () => {
    const weakFwd = makeRelation("0xA", "0xB", 1, 0.1);
    const strongBwd = makeRelation("0xB", "0xA", 20, 0.9);
    // Override strongBwd.midSamples to a distinct value
    strongBwd.midSamples = [{ x: 3, y: 5 }];
    const cons = consolidateRelations([weakFwd, strongBwd]);
    expect(cons[0].midSamples).toEqual([{ x: 3, y: 5 }]);
  });

  it("sizeA/sizeB propagate from fwd relation in canonical order", () => {
    // fwd = 0xA→0xB (sizeA=5, sizeB=15), no backward
    const rels = [makeRelation("0xA", "0xB", 10, 0.8, 5, 15)];
    const cons = consolidateRelations(rels);
    expect(cons[0].sizeA).toBe(5);
    expect(cons[0].sizeB).toBe(15);
  });

  it("sizeA/sizeB are canonical-order even when only bwd relation present", () => {
    // bwd = 0xB→0xA (uidA=0xB has size 99, uidB=0xA has size 3)
    // canonical pair: uidA=0xA, uidB=0xB → sizeA=3, sizeB=99
    const rels = [makeRelation("0xB", "0xA", 5, 0.4, 99, 3)];
    const cons = consolidateRelations(rels);
    expect(cons[0].uidA).toBe("0xA");
    expect(cons[0].uidB).toBe("0xB");
    expect(cons[0].sizeA).toBe(3);  // canonical A = 0xA, which was bwd.sizeB
    expect(cons[0].sizeB).toBe(99); // canonical B = 0xB, which was bwd.sizeA
  });
});

// ---------------------------------------------------------------------------
// freehand assignments (freehand-pinned clusters relate like active clusters)
// ---------------------------------------------------------------------------

describe("extractClusterRelations — freehand assignments", () => {
  it("forms relations between two freehand insets connected by midpoints", () => {
    const a1 = makePoint({});
    const a2 = makePoint({});
    const b1 = makePoint({});
    const b2 = makePoint({});
    const freehand = new Map<number, string>([
      [a1.id, "fh-1"],
      [a2.id, "fh-1"],
      [b1.id, "fh-2"],
      [b2.id, "fh-2"],
    ]);
    const sizes = new Map([
      ["fh-1", 2],
      ["fh-2", 2],
    ]);

    const rels = extractClusterRelations(
      [makeMidpoint(a1, b1), makeMidpoint(a2, b2)],
      new Set(),
      new Set(),
      sizes,
      freehand
    );

    expect(rels).toHaveLength(1);
    expect(rels[0].uidA).toBe("fh-1");
    expect(rels[0].uidB).toBe("fh-2");
    expect(rels[0].support).toBe(2);
    expect(rels[0].score).toBeGreaterThan(0);
  });

  it("freehand membership takes priority over the automated cluster assignment", () => {
    const a = makePoint({ insetClusterId: "0x1" });
    const b = makePoint({ insetClusterId: "0x2" });
    const freehand = new Map<number, string>([[a.id, "fh-1"]]);
    const sizes = new Map([
      ["fh-1", 1],
      ["0x1", 5],
      ["0x2", 5],
    ]);

    const rels = extractClusterRelations(
      [makeMidpoint(a, b)],
      new Set(["0x1", "0x2"]),
      new Set(),
      sizes,
      freehand
    );

    expect(rels).toHaveLength(1);
    expect(rels[0].uidA).toBe("fh-1");
    expect(rels[0].uidB).toBe("0x2");
  });

  it("without freehand assignments behaves exactly as before", () => {
    const a = makePoint({ insetClusterId: "0x1" });
    const b = makePoint({ insetClusterId: "0x2" });
    const sizes = new Map([
      ["0x1", 1],
      ["0x2", 1],
    ]);

    const rels = extractClusterRelations(
      [makeMidpoint(a, b)],
      new Set(["0x1", "0x2"]),
      new Set(),
      sizes
    );

    expect(rels).toHaveLength(1);
    expect(rels[0].uidA).toBe("0x1");
    expect(rels[0].uidB).toBe("0x2");
  });
});
