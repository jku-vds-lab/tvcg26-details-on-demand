import { describe, expect, it } from "@jest/globals";

// Mock rbush (ESM) to avoid transform issues in Jest (pulled in via
// dataPreprocessing by the canonical-fixture imports).
jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

import { catmullRomPoint } from "../../../dataPreprocessing/catmullRom";
import {
  columnsFromPrecomputedSegments,
  computeSplineColumns,
  expandSplineColumns,
} from "../../../dataPreprocessing/splineColumns";
import type { PrecomputedSegment } from "../../../dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "../../../dataPreprocessing/dataPreprocessing";
import { attachPointColumns } from "../../../dataPreprocessing/pointColumns";
import { GeometrySystem, meanEdgeChordDataLen, uniformSamplesPerEdge } from "./GeometrySystem";

// Fixture: three trajectories, deliberately INTERLEAVED in input order so
// edge endpoint indices are non-consecutive — chain detection must rely on
// shared canonical indices, not on index adjacency. Line 1 is a single edge
// (both controls clamp), line 2 a single point (no edge).
const PTS: { x: number; y: number; line: number }[] = [
  { x: 0, y: 0, line: 0 },
  { x: 100, y: 50, line: 1 },
  { x: 10, y: 8, line: 0 },
  { x: 120, y: 42, line: 1 },
  { x: 23, y: 1, line: 0 },
  { x: -5, y: -5, line: 2 },
  { x: 31, y: -14, line: 0 },
  { x: 40, y: 3, line: 0 },
];

function makeFixture() {
  const x = PTS.map((p) => p.x);
  const y = PTS.map((p) => p.y);
  const line = PTS.map((p) => p.line);
  // Ids deliberately distinct from indices to exercise the indexById hop.
  const points = PTS.map((_, i) => ({ id: 1000 + i }));
  const cols = expandSplineColumns(computeSplineColumns(x, y, line), points);
  const indexById = new Map<number, number>(points.map((p, i) => [p.id, i]));
  return { cols, indexById };
}

describe("GeometrySystem.buildEdgeControlData", () => {
  it("control indices reproduce every segment endpoint via catmullRomPoint", () => {
    const { cols, indexById } = makeFixture();
    const ctrl = new GeometrySystem().buildEdgeControlData(cols, indexById);
    const S = uniformSamplesPerEdge(cols)!;

    expect(cols.edgeCount).toBe(5); // 4 edges on line 0 + 1 on line 1
    expect(ctrl.length).toBe(cols.edgeCount * 4);

    const at = (i: number): number[] => [PTS[i].x, PTS[i].y];

    for (let e = 0; e < cols.edgeCount; e++) {
      const p0 = at(ctrl[e * 4 + 0]);
      const p1 = at(ctrl[e * 4 + 1]);
      const p2 = at(ctrl[e * 4 + 2]);
      const p3 = at(ctrl[e * 4 + 3]);
      for (let s = 0; s < S; s++) {
        const seg = e * S + s;
        const start = catmullRomPoint(s / S, p0, p1, p2, p3);
        const end = catmullRomPoint((s + 1) / S, p0, p1, p2, p3);
        // Identical float64 math on identical inputs — exact equality.
        expect(start[0]).toBe(cols.segX0[seg]);
        expect(start[1]).toBe(cols.segY0[seg]);
        expect(end[0]).toBe(cols.segX1[seg]);
        expect(end[1]).toBe(cols.segY1[seg]);
      }
    }
  });

  it("clamps controls at trajectory boundaries and on single-edge lines", () => {
    const { cols, indexById } = makeFixture();
    const ctrl = new GeometrySystem().buildEdgeControlData(cols, indexById);

    // Edges 0-3 = line 0 (first appearance order), edge 4 = line 1.
    // First edge of line 0: p0 clamps to p1; last edge: p3 clamps to p2.
    expect(ctrl[0 * 4 + 0]).toBe(ctrl[0 * 4 + 1]);
    expect(ctrl[3 * 4 + 3]).toBe(ctrl[3 * 4 + 2]);
    // Interior edge 1 chains: p0 = previous edge's start, p3 = next edge's end.
    expect(ctrl[1 * 4 + 0]).toBe(ctrl[0 * 4 + 1]);
    expect(ctrl[1 * 4 + 3]).toBe(ctrl[2 * 4 + 2]);
    // Line 1's single edge (indices 1 → 3): both controls clamp.
    expect(ctrl[4 * 4 + 1]).toBe(1);
    expect(ctrl[4 * 4 + 2]).toBe(3);
    expect(ctrl[4 * 4 + 0]).toBe(1); // p0 = p1
    expect(ctrl[4 * 4 + 3]).toBe(3); // p3 = p2
  });

  it("marks edges with unresolved endpoints as degenerate (-1)", () => {
    const { cols, indexById } = makeFixture();
    indexById.delete(1003); // line 1's end point
    const ctrl = new GeometrySystem().buildEdgeControlData(cols, indexById);
    const degenerate: number[] = [];
    for (let e = 0; e < cols.edgeCount; e++) {
      if (ctrl[e * 4 + 1] < 0) degenerate.push(e);
    }
    expect(degenerate.length).toBe(1);
    expect(ctrl[degenerate[0] * 4 + 0]).toBe(-1);
    expect(ctrl[degenerate[0] * 4 + 3]).toBe(-1);
  });
});

describe("GeometrySystem.buildEdgeControlDataCanonical", () => {
  // Column-backed twin of makeFixture: same trajectories, ids ≠ indices, the
  // points canonical so columnsOf resolves them (issue #315 I2).
  function makeCanonicalFixture() {
    const points = PTS.map((p, i) => ({
      ...createEmptyDataPoint(),
      x: p.x,
      y: p.y,
      line: p.line,
      id: 1000 + i,
    }));
    attachPointColumns(points);
    const x = PTS.map((p) => p.x);
    const y = PTS.map((p) => p.y);
    const line = PTS.map((p) => p.line);
    const cols = expandSplineColumns(computeSplineColumns(x, y, line), points);
    const indexById = new Map<number, number>(points.map((p, i) => [p.id, i]));
    return { cols, points, indexById };
  }

  it("is byte-identical to the Map path on canonical column-backed nodes", () => {
    const { cols, points, indexById } = makeCanonicalFixture();
    const sys = new GeometrySystem();
    const canonical = sys.buildEdgeControlDataCanonical(cols, points);
    const viaMap = sys.buildEdgeControlData(cols, indexById);
    expect(canonical).not.toBeNull();
    expect(canonical).toEqual(viaMap);
  });

  it("returns null for non-column-backed nodes (caller falls back to the Map path)", () => {
    const { cols } = makeFixture();
    const plainNodes = PTS.map((p, i) => ({ ...p, id: 1000 + i })) as never[];
    expect(new GeometrySystem().buildEdgeControlDataCanonical(cols, plainNodes)).toBeNull();
  });

  it("returns null when an endpoint lies beyond the visible prefix", () => {
    const { cols, points } = makeCanonicalFixture();
    expect(
      new GeometrySystem().buildEdgeControlDataCanonical(cols, points, points.length - 1)
    ).toBeNull();
  });

  it("returns null when an endpoint id disagrees with the id column", () => {
    const { cols, points } = makeCanonicalFixture();
    cols.edgeStartId[2] = 424242; // foreign edge provenance
    expect(new GeometrySystem().buildEdgeControlDataCanonical(cols, points)).toBeNull();
  });
});

describe("meanEdgeChordDataLen (issue #315 R1a A15)", () => {
  function makePoints() {
    return PTS.map((p, i) => ({
      ...createEmptyDataPoint(),
      x: p.x,
      y: p.y,
      line: p.line,
      id: 1000 + i,
    }));
  }

  it("is identical between the columnar and row paths", () => {
    const rowPoints = makePoints();
    const colPoints = makePoints();
    attachPointColumns(colPoints);
    const x = PTS.map((p) => p.x);
    const y = PTS.map((p) => p.y);
    const line = PTS.map((p) => p.line);
    const cols = expandSplineColumns(computeSplineColumns(x, y, line), rowPoints);

    const viaRows = meanEdgeChordDataLen(cols, rowPoints);
    const viaCols = meanEdgeChordDataLen(cols, colPoints);
    expect(viaRows).toBeGreaterThan(0);
    // Same hypot over the same float64 values in the same order — exact.
    expect(viaCols).toBe(viaRows);
  });

  it("returns 0 for zero edges", () => {
    const empty = expandSplineColumns(computeSplineColumns([], [], []), []);
    expect(meanEdgeChordDataLen(empty, [])).toBe(0);
  });
});

describe("uniformSamplesPerEdge", () => {
  it("returns the shared S for expanded spline columns", () => {
    const { cols } = makeFixture();
    expect(uniformSamplesPerEdge(cols)).toBe(20);
  });

  it("returns null for empty and non-uniform columns", () => {
    expect(uniformSamplesPerEdge(null)).toBeNull();

    const seg = (startIndex: number, endIndex: number, k: number, n: number): PrecomputedSegment => ({
      x0: 0, y0: 0, x1: 1, y1: 1,
      startIndex, endIndex,
      startPercentage: k / n,
      endPercentage: (k + 1) / n,
      splineMidPoint: { x: 0.5, y: 0.5 },
      isArrowSegment: k === n - 1,
      doi: 0,
    });
    // Edge 0 has 2 segments, edge 1 has 3 — non-uniform tessellation.
    const pre: PrecomputedSegment[] = [
      seg(0, 1, 0, 2), seg(0, 1, 1, 2),
      seg(1, 2, 0, 3), seg(1, 2, 1, 3), seg(1, 2, 2, 3),
    ];
    const points = [{ id: 0 }, { id: 1 }, { id: 2 }];
    const nonUniform = columnsFromPrecomputedSegments(pre, points);
    expect(uniformSamplesPerEdge(nonUniform)).toBeNull();
  });
});
