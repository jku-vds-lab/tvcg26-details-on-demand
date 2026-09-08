// Mock rbush (ESM) with a functional linear-scan tree — the parity assertions
// need real search results, not a stub.
jest.mock("rbush", () => ({
  __esModule: true,
  default: class {
    private items: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    load(items: never[]) { this.items.push(...items); return this; }
    insert(item: never) { this.items.push(item); return this; }
    search(box: { minX: number; minY: number; maxX: number; maxY: number }) {
      return this.items.filter(
        (i) => !(i.maxX < box.minX || i.minX > box.maxX || i.maxY < box.minY || i.minY > box.maxY)
      );
    }
  },
}));

import { describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "./dataPreprocessing";
import { EdgeSegmentIndex } from "./segmentIndex";
import {
  attachSegmentPointState,
  computeCompactColumnsForPoints,
  computeSegmentColumnsForPoints,
  edgeFallbackCenter,
  evalEdgeAt,
  updateEdgeColumnDois,
} from "./splineColumns";
import { uniformSamplesPerEdge } from "../gl/core/systems/GeometrySystem";

// Interleaved trajectories (as in GeometrySystem.edgeControl.test.ts) so the
// compact path's chain detection is exercised on non-consecutive indices.
const RAW: { x: number; y: number; line: number }[] = [
  { x: 0, y: 0, line: 0 },
  { x: 100, y: 50, line: 1 },
  { x: 10, y: 8, line: 0 },
  { x: 120, y: 42, line: 1 },
  { x: 23, y: 1, line: 0 },
  { x: -5, y: -5, line: 2 },
  { x: 31, y: -14, line: 0 },
  { x: 40, y: 3, line: 0 },
];

function makePoints(): DataPoint[] {
  return RAW.map((p, i) => ({
    ...p,
    id: 500 + i,
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    action: `a${p.line}`,
  })) as unknown as DataPoint[];
}

describe("compact segment columns parity with expanded columns", () => {
  it("edge arrays and virtual segment geometry match exactly", () => {
    const pts = makePoints();
    const expanded = computeSegmentColumnsForPoints(pts);
    const compact = computeCompactColumnsForPoints(pts);
    const S = compact.virtualSamplesPerEdge!;

    expect(uniformSamplesPerEdge(compact)).toBe(S);
    expect(compact.edgeCount).toBe(expanded.edgeCount);
    expect(compact.segmentCount).toBe(expanded.segmentCount);
    expect(Array.from(compact.edgeStart)).toEqual(Array.from(expanded.edgeStart));
    expect(Array.from(compact.edgeEnd)).toEqual(Array.from(expanded.edgeEnd));
    expect(Array.from(compact.edgeStartId)).toEqual(Array.from(expanded.edgeStartId));
    expect(Array.from(compact.edgeEndId)).toEqual(Array.from(expanded.edgeEndId));
    expect(Array.from(compact.edgeSegOffset)).toEqual(Array.from(expanded.edgeSegOffset));

    for (let e = 0; e < expanded.edgeCount; e++) {
      for (let s = 0; s < S; s++) {
        const seg = e * S + s;
        const a = evalEdgeAt(compact, pts, e, s / S);
        const b = evalEdgeAt(compact, pts, e, (s + 1) / S);
        expect(a.x).toBe(expanded.segX0[seg]);
        expect(a.y).toBe(expanded.segY0[seg]);
        expect(b.x).toBe(expanded.segX1[seg]);
        expect(b.y).toBe(expanded.segY1[seg]);
      }
    }
  });

  it("attachSegmentPointState produces identical nextEdgeCenter and export copy", async () => {
    const ptsA = makePoints();
    const ptsB = makePoints();
    const expanded = computeSegmentColumnsForPoints(ptsA);
    const compact = computeCompactColumnsForPoints(ptsB);

    const { exportSegments: exportA } = await attachSegmentPointState(ptsA, expanded, { keepExportCopy: true });
    const { exportSegments: exportB } = await attachSegmentPointState(ptsB, compact, { keepExportCopy: true });

    for (let i = 0; i < ptsA.length; i++) {
      expect(ptsB[i].nextEdgeCenter).toEqual(ptsA[i].nextEdgeCenter);
    }
    expect(exportB).toEqual(exportA);
  });

  it("edgeFallbackCenter matches the expanded middle-segment midpoint", () => {
    const pts = makePoints();
    const expanded = computeSegmentColumnsForPoints(pts);
    const compact = computeCompactColumnsForPoints(pts);
    for (let e = 0; e < expanded.edgeCount; e++) {
      expect(edgeFallbackCenter(compact, e, pts)).toEqual(edgeFallbackCenter(expanded, e));
    }
    expect(() => edgeFallbackCenter(compact, 0)).toThrow();
  });

  it("EdgeSegmentIndex returns identical filtered segment hits", () => {
    const pts = makePoints();
    const expanded = computeSegmentColumnsForPoints(pts);
    const compact = computeCompactColumnsForPoints(pts);
    updateEdgeColumnDois(expanded, pts);
    updateEdgeColumnDois(compact, pts);

    const idxA = new EdgeSegmentIndex(expanded).filtered(0.5);
    const idxB = new EdgeSegmentIndex(compact, pts).filtered(0.5);

    const boxes = [
      { minX: -10, minY: -20, maxX: 50, maxY: 60 },
      { minX: 5, minY: 0, maxX: 25, maxY: 10 },
      { minX: 90, minY: 40, maxX: 130, maxY: 55 },
      { minX: 1000, minY: 1000, maxX: 1001, maxY: 1001 },
    ];
    for (const box of boxes) {
      expect([...idxB.search(box)].sort((a, b) => a - b)).toEqual(
        [...idxA.search(box)].sort((a, b) => a - b)
      );
    }

    expect(() => new EdgeSegmentIndex(compact)).toThrow();
  });
});
