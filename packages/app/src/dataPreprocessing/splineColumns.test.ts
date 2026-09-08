// packages/app/src/dataPreprocessing/splineColumns.test.ts
//
// Parity guards for the columnar spline derivation (issue #315, phases A+B1).
// The columnar kernel + expansion must reproduce computeSplineGeometry (which
// is itself offline-parity-guarded against the Python generator via
// simpleDataset.integration.test.ts) segment for segment, and the
// precomputed-list conversion must round-trip the shipped values verbatim.

import { describe, expect, test } from "@jest/globals";
import type { DataPoint } from "./dataPreprocessing";
import {
  attachSegmentPointState,
  columnsFromPrecomputedSegments,
  computeCompactColumnsForPoints,
  computeSplineColumns,
  computeSegmentColumnsForPoints,
  edgeFallbackCenter,
  expandSplineColumns,
  SAMPLES_PER_EDGE,
  splineColumnSegmentCount,
  updateEdgeColumnDois,
  type SegmentColumns,
} from "./splineColumns";
import { computeSplineGeometry } from "./splineGeometry";

interface FixturePoint {
  x: number;
  y: number;
  line: number;
  action?: string;
}

// Multi-line fixture with the shapes that have bitten before: unordered line
// ids, an interleaved appearance order, a single-point line (no edges), a
// 2-point line (degenerate p0/p3 clamping), and a longer curved line.
const FIXTURE: FixturePoint[] = [
  { x: 0, y: 0, line: 7, action: "a" },
  { x: 1, y: 2, line: 7, action: "b" },
  { x: 3, y: 1, line: 7, action: "c" },
  { x: 5, y: 4, line: 7, action: "d" },
  { x: 10, y: 10, line: 3, action: "e" },
  { x: 11, y: 12, line: 3, action: "f" },
  { x: -5, y: 2, line: 99 }, // single-point line: contributes nothing
  { x: 2.5, y: -1.25, line: 7, action: "g" }, // late continuation of line 7
  { x: 20, y: 20, line: 3, action: "h" },
];

function makeDataPoints(): DataPoint[] {
  return FIXTURE.map(
    (p, i) =>
      ({
        ...p,
        id: i + 100, // ids deliberately != indices to catch index/id mixups
        DoI: (i + 1) / FIXTURE.length,
        nextEdgeCenter: { x: 0, y: 0 },
      }) as unknown as DataPoint
  );
}

function columnsFor(points: FixturePoint[], dataPoints: DataPoint[]): SegmentColumns {
  const x = new Float64Array(points.map((p) => p.x));
  const y = new Float64Array(points.map((p) => p.y));
  const line = new Float64Array(points.map((p) => p.line));
  return expandSplineColumns(computeSplineColumns(x, y, line), dataPoints);
}

describe("expandSplineColumns", () => {
  test("reproduces computeSplineGeometry segment for segment (exact floats)", () => {
    const reference = computeSplineGeometry(FIXTURE);
    const points = makeDataPoints();
    const cols = columnsFor(FIXTURE, points);

    expect(cols.segmentCount).toBe(reference.segments.length);
    expect(cols.edgeCount).toBe(reference.trajectoryMidpoints.length);

    reference.segments.forEach((ref, i) => {
      // Exact float equality: same IEEE ops in the same order.
      expect(cols.segX0[i]).toBe(ref.x0);
      expect(cols.segY0[i]).toBe(ref.y0);
      expect(cols.segX1[i]).toBe(ref.x1);
      expect(cols.segY1[i]).toBe(ref.y1);
      expect(cols.segStartPct[i]).toBeCloseTo(ref.startPercentage, 6);
      expect(cols.segEndPct[i]).toBeCloseTo(ref.endPercentage, 6);
      expect(cols.segArrow[i] === 1).toBe(!!ref.isArrowSegment);
      const e = cols.segEdge[i];
      expect(cols.edgeStart[e]).toBe(ref.startIndex);
      expect(cols.edgeEnd[e]).toBe(ref.endIndex);
      // Ids resolved off the point objects, not indices.
      expect(cols.edgeStartId[e]).toBe(points[ref.startIndex].id);
      expect(cols.edgeEndId[e]).toBe(points[ref.endIndex].id);
    });

    // CSR: segments of an edge are contiguous, samplesPerEdge each.
    for (let e = 0; e < cols.edgeCount; e++) {
      expect(cols.edgeSegOffset[e + 1] - cols.edgeSegOffset[e]).toBe(SAMPLES_PER_EDGE);
    }
    expect(splineColumnSegmentCount(computeSplineColumns(
      new Float64Array(FIXTURE.map((p) => p.x)),
      new Float64Array(FIXTURE.map((p) => p.y)),
      new Float64Array(FIXTURE.map((p) => p.line))
    ))).toBe(cols.segmentCount);
  });

  test("no edges for empty or all-singleton inputs", () => {
    expect(columnsFor([], []).segmentCount).toBe(0);
    const singles: FixturePoint[] = [
      { x: 0, y: 0, line: 1 },
      { x: 1, y: 1, line: 2 },
    ];
    expect(columnsFor(singles, makeDataPoints().slice(0, 2)).segmentCount).toBe(0);
  });
});

describe("attachSegmentPointState", () => {
  test("nextEdgeCenter straddle rule matches the reference map", async () => {
    const reference = computeSplineGeometry(FIXTURE);
    const points = makeDataPoints();
    const cols = columnsFor(FIXTURE, points);
    await attachSegmentPointState(points, cols);
    reference.nextEdgeCenter.forEach((center, startIndex) => {
      expect(points[startIndex].nextEdgeCenter).toEqual(center);
    });
  });

  test("a shipped nextEdgeCenter wins over the derived one (guard semantics)", async () => {
    const points = makeDataPoints();
    points[0].nextEdgeCenter = { x: 123, y: 456 };
    await attachSegmentPointState(points, columnsFor(FIXTURE, points));
    expect(points[0].nextEdgeCenter).toEqual({ x: 123, y: 456 });
  });

  test("export copy matches computeSplineGeometry's PrecomputedSegments", async () => {
    const reference = computeSplineGeometry(FIXTURE);
    const points = makeDataPoints();
    const cols = columnsFor(FIXTURE, points);
    const { exportSegments } = await attachSegmentPointState(points, cols, {
      keepExportCopy: true,
      batchSize: 10, // exercise chunked yields
      yieldFn: async () => {},
    });
    expect(exportSegments).toHaveLength(reference.segments.length);
    reference.segments.forEach((ref, i) => {
      const got = exportSegments![i];
      expect(got.x0).toBe(ref.x0);
      expect(got.y1).toBe(ref.y1);
      expect(got.startIndex).toBe(ref.startIndex);
      expect(got.endIndex).toBe(ref.endIndex);
      expect(got.splineMidPoint).toEqual(ref.splineMidPoint);
      expect(!!got.isArrowSegment).toBe(!!ref.isArrowSegment);
      expect(got.action).toBe(ref.action);
    });
  });

  // Non-blocking ingestion (issue #315): the nextEdgeCenter pass may be sliced
  // (sliceCenters:true) to yield every `batchSize` edges. Slicing must not
  // change any written value — including at a chunk size that does not divide
  // the edge count (FIXTURE has 6 edges; batchSize 4 yields mid-run).
  describe("sliceCenters chunk-boundary parity", () => {
    const centersOf = (points: DataPoint[]) =>
      points.map((p) => (p.nextEdgeCenter ? { ...p.nextEdgeCenter } : null));

    async function run(
      cols: SegmentColumns,
      sliceCenters: boolean,
      keepExportCopy: boolean
    ) {
      const points = makeDataPoints();
      let yields = 0;
      const { exportSegments } = await attachSegmentPointState(points, cols, {
        keepExportCopy,
        sliceCenters,
        batchSize: 4, // does not divide the 6-edge fixture
        yieldFn: async () => {
          yields += 1;
        },
      });
      return { centers: centersOf(points), exportSegments, yields };
    }

    test.each([
      ["materialized", () => columnsFor(FIXTURE, makeDataPoints())],
      ["virtual", () => computeCompactColumnsForPoints(makeDataPoints())],
    ])("sliced == unsliced nextEdgeCenter + export copy (%s columns)", async (_label, makeCols) => {
      const reference = await run(makeCols(), false, true);
      const sliced = await run(makeCols(), true, true);

      // Bit-identical written state, chunk boundary notwithstanding.
      expect(sliced.centers).toEqual(reference.centers);
      expect(sliced.exportSegments).toEqual(reference.exportSegments);
    });

    test.each([
      ["materialized", () => columnsFor(FIXTURE, makeDataPoints())],
      ["virtual", () => computeCompactColumnsForPoints(makeDataPoints())],
    ])("nextEdgeCenter pass yields only when sliced (%s columns)", async (_label, makeCols) => {
      // keepExportCopy:false ⇒ only the nextEdgeCenter pass can yield.
      const reference = await run(makeCols(), false, false);
      const sliced = await run(makeCols(), true, false);

      expect(sliced.centers).toEqual(reference.centers);
      expect(reference.yields).toBe(0); // synchronous pass
      expect(sliced.yields).toBeGreaterThan(0); // yields mid-run at batchSize 4
    });

    test("sliceCenters default (off) leaves the pass synchronous", async () => {
      const points = makeDataPoints();
      let yielded = false;
      const promise = attachSegmentPointState(points, columnsFor(FIXTURE, points), {
        batchSize: 1,
        yieldFn: async () => {
          yielded = true;
        },
      });
      // No await hit yet ⇒ centers are already written synchronously.
      expect(points[0].nextEdgeCenter).not.toEqual({ x: 0, y: 0 });
      await promise;
      expect(yielded).toBe(false);
    });
  });
});

describe("columnsFromPrecomputedSegments", () => {
  test("round-trips shipped values verbatim (incl. non-uniform runs)", () => {
    const points = makeDataPoints();
    const reference = computeSplineGeometry(FIXTURE);
    const cols = columnsFromPrecomputedSegments(reference.segments, points);

    expect(cols.segmentCount).toBe(reference.segments.length);
    reference.segments.forEach((ref, i) => {
      expect(cols.segX0[i]).toBe(ref.x0);
      expect(cols.segY1[i]).toBe(ref.y1);
      expect(cols.segStartPct[i]).toBeCloseTo(ref.startPercentage, 6);
      expect(cols.segArrow[i] === 1).toBe(!!ref.isArrowSegment);
      const e = cols.segEdge[i];
      expect(cols.edgeStart[e]).toBe(ref.startIndex);
      expect(cols.edgeEnd[e]).toBe(ref.endIndex);
    });

    // Equivalent to the expansion path on the same input.
    const expanded = columnsFor(FIXTURE, points);
    expect(cols.edgeCount).toBe(expanded.edgeCount);
    expect(Array.from(cols.edgeSegOffset)).toEqual(Array.from(expanded.edgeSegOffset));
  });
});

describe("updateEdgeColumnDois / edgeFallbackCenter", () => {
  test("edge doi is the mean of the endpoints' DoI", () => {
    const points = makeDataPoints();
    const cols = columnsFor(FIXTURE, points);
    updateEdgeColumnDois(cols, points);
    for (let e = 0; e < cols.edgeCount; e++) {
      const expected = 0.5 * (points[cols.edgeStart[e]].DoI + points[cols.edgeEnd[e]].DoI);
      expect(cols.edgeDoi[e]).toBeCloseTo(expected, 6);
    }
    expect(() => updateEdgeColumnDois(null, points)).not.toThrow();
  });

  test("edgeFallbackCenter is the middle segment's chord midpoint", () => {
    const points = makeDataPoints();
    const cols = columnsFor(FIXTURE, points);
    const s = cols.edgeSegOffset[0] + Math.floor(SAMPLES_PER_EDGE / 2);
    expect(edgeFallbackCenter(cols, 0)).toEqual({
      x: (cols.segX0[s] + cols.segX1[s]) / 2,
      y: (cols.segY0[s] + cols.segY1[s]) / 2,
    });
  });
});

describe("computeSegmentColumnsForPoints", () => {
  test("fallback derivation equals the worker-expansion path", () => {
    const points = makeDataPoints();
    const viaWorkerPath = columnsFor(FIXTURE, points);
    const viaFallback = computeSegmentColumnsForPoints(points);
    expect(viaFallback.segmentCount).toBe(viaWorkerPath.segmentCount);
    expect(Array.from(viaFallback.segX0)).toEqual(Array.from(viaWorkerPath.segX0));
    expect(Array.from(viaFallback.segY1)).toEqual(Array.from(viaWorkerPath.segY1));
    expect(Array.from(viaFallback.edgeStartId)).toEqual(Array.from(viaWorkerPath.edgeStartId));
  });
});
