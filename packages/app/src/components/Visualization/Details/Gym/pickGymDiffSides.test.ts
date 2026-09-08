import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { pickGymDiffSides } from "./GymDatasetRenderer";

function point(id: number): DataPoint {
  return { x: id, y: id, id } as unknown as DataPoint;
}

describe("pickGymDiffSides", () => {
  it("prefers full cluster memberships when attached (floating relation insets)", () => {
    const clusterStart = [point(10), point(11)];
    const clusterEnd = [point(20)];
    const sample = Object.assign(point(1), {
      edgeStart: point(1),
      edgeEnd: point(2),
      edgeClusterStart: clusterStart,
      edgeClusterEnd: clusterEnd,
    });
    const { starts, ends } = pickGymDiffSides([sample]);
    expect(starts).toBe(clusterStart);
    expect(ends).toBe(clusterEnd);
  });

  it("falls back to the transition endpoints (hover diffs, on-spline insets)", () => {
    const a = point(1);
    const b = point(2);
    const sample = Object.assign(point(0), { edgeStart: a, edgeEnd: b });
    const { starts, ends } = pickGymDiffSides([sample]);
    expect(starts).toEqual([a]);
    expect(ends).toEqual([b]);
  });
});
