import { describe, expect, it, jest } from "@jest/globals";
// dataPreprocessing.ts pulls in rbush (ESM) which jest does not transform; the
// updater under test never touches it, so stub the default export.
jest.mock("rbush", () => ({ __esModule: true, default: class {} }));
import type { DataPoint, TrajectoryMidpoint } from "./dataPreprocessing";
import { updateTrajectoryMidpointDoIs } from "./dataPreprocessing";
import { attachPointColumns } from "./pointColumns";
import type { SegmentColumns } from "./splineColumns";
import { updateEdgeColumnDois } from "./splineColumns";

// Plain points carrying a DoI field but NO column backing (object path).
function makeObjectPoints(dois: number[]): DataPoint[] {
  return dois.map((doi, i) => ({
    x: i,
    y: i,
    line: 0,
    id: 100 + i,
    DoI: doi,
  })) as unknown as DataPoint[];
}

// Same values, but wired through attachPointColumns (columnar path).
function makeColumnBackedPoints(dois: number[]): DataPoint[] {
  const pts = makeObjectPoints(dois);
  attachPointColumns(pts);
  return pts;
}

// Minimal SegmentColumns exercising only the fields updateEdgeColumnDois reads.
function makeEdgeColumns(edgeStart: number[], edgeEnd: number[]): SegmentColumns {
  return {
    edgeCount: edgeStart.length,
    edgeStart: Int32Array.from(edgeStart),
    edgeEnd: Int32Array.from(edgeEnd),
    edgeDoi: new Float32Array(edgeStart.length),
  } as unknown as SegmentColumns;
}

describe("updateEdgeColumnDois columnar vs object parity", () => {
  const dois = [0.2, 0.6, 0.9, 0.1];
  const edgeStart = [0, 1, 2, 3];
  const edgeEnd = [1, 2, 3, 99]; // last edge has an out-of-range endpoint (?? 0)

  it("produces identical edge DoIs on either backing", () => {
    const colsColumnar = makeEdgeColumns(edgeStart, edgeEnd);
    updateEdgeColumnDois(colsColumnar, makeColumnBackedPoints(dois));

    const colsObject = makeEdgeColumns(edgeStart, edgeEnd);
    updateEdgeColumnDois(colsObject, makeObjectPoints(dois));

    const expected = [
      0.5 * (0.2 + 0.6),
      0.5 * (0.6 + 0.9),
      0.5 * (0.9 + 0.1),
      0.5 * (0.1 + 0), // out-of-range endpoint reads as 0 on both paths
    ];
    expect(Array.from(colsColumnar.edgeDoi)).toEqual(
      expected.map((v) => Math.fround(v))
    );
    expect(Array.from(colsColumnar.edgeDoi)).toEqual(Array.from(colsObject.edgeDoi));
  });

  it("is a no-op when the segment columns are null", () => {
    expect(() => updateEdgeColumnDois(null, makeObjectPoints(dois))).not.toThrow();
  });
});

// Minimal midpoint referencing two endpoint points.
function makeMidpoint(start: DataPoint, end: DataPoint): TrajectoryMidpoint {
  return {
    id: 0,
    midPoint: { x: 0, y: 0 },
    startPoint: start,
    endPoint: end,
    action: "",
    DoI: 0,
  };
}

describe("updateTrajectoryMidpointDoIs columnar vs object parity", () => {
  it("means the endpoint DoIs identically on either backing", () => {
    const dois = [0.3, 0.7, 0.5];

    const columnar = makeColumnBackedPoints(dois);
    const mpsColumnar = [
      makeMidpoint(columnar[0], columnar[1]),
      makeMidpoint(columnar[1], columnar[2]),
    ];
    updateTrajectoryMidpointDoIs(mpsColumnar);

    const object = makeObjectPoints(dois);
    const mpsObject = [
      makeMidpoint(object[0], object[1]),
      makeMidpoint(object[1], object[2]),
    ];
    updateTrajectoryMidpointDoIs(mpsObject);

    expect(mpsColumnar.map((m) => m.DoI)).toEqual([0.5, 0.6]);
    expect(mpsColumnar.map((m) => m.DoI)).toEqual(mpsObject.map((m) => m.DoI));
  });

  it("falls back to the accessor for non-column-backed endpoints", () => {
    // Synthetic endpoints (no __cols/__ci) — the legacy fallback path.
    const a = { id: -1, x: 0, y: 0, line: 0, DoI: 0.8 } as unknown as DataPoint;
    const b = { id: -2, x: 0, y: 0, line: 0 } as unknown as DataPoint; // DoI missing → 0
    const mps = [makeMidpoint(a, b)];
    updateTrajectoryMidpointDoIs(mps);
    expect(mps[0].DoI).toBe(0.4);
  });
});
