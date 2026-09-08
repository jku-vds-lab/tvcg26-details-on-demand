// Mock rbush (ESM, pulled in via dataPreprocessing) to avoid transform issues.
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

import { catmullRomPoint } from "./catmullRom";
import { createEmptyDataPoint, DataPoint } from "./dataPreprocessing";
import { computeSegmentColumnsForPoints } from "./splineColumns";
import { computeSplineGeometry, SplineGeometryPoint } from "./splineGeometry";

const mkPoints = (
  coords: Array<[number, number]>,
  line = 0
): SplineGeometryPoint[] => coords.map(([x, y]) => ({ x, y, line }));

describe("computeSplineGeometry", () => {
  it("produces no geometry for single-point lines", () => {
    const result = computeSplineGeometry([
      { x: 0, y: 0, line: 0 },
      { x: 5, y: 5, line: 1 },
    ]);
    expect(result.segments).toHaveLength(0);
    expect(result.trajectoryMidpoints).toHaveLength(0);
    expect(result.nextEdgeCenter.size).toBe(0);
  });

  it("emits samplesPerEdge segments per edge and one midpoint per edge", () => {
    const points = mkPoints([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 3],
    ]);
    const result = computeSplineGeometry(points);
    expect(result.segments).toHaveLength(3 * 20);
    expect(result.trajectoryMidpoints).toHaveLength(3);
    // Index-based references into the input array.
    expect(result.segments[0].startIndex).toBe(0);
    expect(result.segments[0].endIndex).toBe(1);
    expect(result.trajectoryMidpoints[2].startIndex).toBe(2);
    expect(result.trajectoryMidpoints[2].endIndex).toBe(3);
  });

  it("matches the exact Catmull-Rom sampling of the legacy in-app path", () => {
    const coords: Array<[number, number]> = [
      [0, 0],
      [1, 2],
      [3, 1],
      [4, 4],
    ];
    const points = mkPoints(coords);
    const result = computeSplineGeometry(points);

    // Recompute the second edge (i = 1) by hand with the shared kernel.
    const p0 = coords[0];
    const p1 = coords[1];
    const p2 = coords[2];
    const p3 = coords[3];
    const edgeSegments = result.segments.filter((s) => s.startIndex === 1);
    expect(edgeSegments).toHaveLength(20);
    for (let s = 0; s < 20; s++) {
      const [ex0, ey0] = catmullRomPoint(s / 20, p0, p1, p2, p3);
      const [ex1, ey1] = catmullRomPoint((s + 1) / 20, p0, p1, p2, p3);
      expect(edgeSegments[s].x0).toBeCloseTo(ex0, 12);
      expect(edgeSegments[s].y0).toBeCloseTo(ey0, 12);
      expect(edgeSegments[s].x1).toBeCloseTo(ex1, 12);
      expect(edgeSegments[s].y1).toBeCloseTo(ey1, 12);
      expect(edgeSegments[s].startPercentage).toBeCloseTo(s / 20, 12);
      expect(edgeSegments[s].isArrowSegment).toBe(s === 19);
    }

    // Same segment count and endpoint multiset as the columnar fallback path.
    const fallbackPoints: DataPoint[] = coords.map(([x, y], i) => ({
      ...createEmptyDataPoint(),
      x,
      y,
      line: 0,
      id: i,
    }));
    const cols = computeSegmentColumnsForPoints(fallbackPoints);
    expect(cols.segmentCount).toBe(result.segments.length);
    const key = (x0: number, y0: number, x1: number, y1: number) =>
      `${x0.toFixed(9)},${y0.toFixed(9)},${x1.toFixed(9)},${y1.toFixed(9)}`;
    const colKeys = new Set<string>();
    for (let s = 0; s < cols.segmentCount; s++) {
      colKeys.add(key(cols.segX0[s], cols.segY0[s], cols.segX1[s], cols.segY1[s]));
    }
    expect(new Set(result.segments.map((s) => key(s.x0, s.y0, s.x1, s.y1)))).toEqual(colKeys);
  });

  it("records the first segment straddling the halfway mark as nextEdgeCenter", () => {
    const points = mkPoints([
      [0, 0],
      [10, 0],
    ]);
    const result = computeSplineGeometry(points);
    const straddle = result.segments.find(
      (s) => s.startPercentage <= 0.5 && s.endPercentage >= 0.5
    )!;
    expect(result.nextEdgeCenter.get(0)).toEqual(straddle.splineMidPoint);
    expect(result.trajectoryMidpoints[0].midPoint).toEqual(straddle.splineMidPoint);
  });

  it("groups interleaved lines by their line value with global indices", () => {
    const points: SplineGeometryPoint[] = [
      { x: 0, y: 0, line: 0 },
      { x: 0, y: 10, line: 1 },
      { x: 1, y: 0, line: 0 },
      { x: 1, y: 10, line: 1 },
    ];
    const result = computeSplineGeometry(points);
    expect(result.segments).toHaveLength(2 * 20);
    const starts = result.trajectoryMidpoints.map((m) => [m.startIndex, m.endIndex]);
    expect(starts).toContainEqual([0, 2]);
    expect(starts).toContainEqual([1, 3]);
  });

  it("carries the start point action onto segments and midpoints", () => {
    const points: SplineGeometryPoint[] = [
      { x: 0, y: 0, line: 0, action: "L" },
      { x: 1, y: 0, line: 0, action: "R" },
    ];
    const result = computeSplineGeometry(points);
    expect(result.segments[0].action).toBe("L");
    expect(result.trajectoryMidpoints[0].action).toBe("L");
  });
});
