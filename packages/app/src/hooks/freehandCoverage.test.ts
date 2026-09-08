import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { sharesFreehandMembers } from "./freehandCoverage";

const pts = (...ids: number[]): DataPoint[] =>
  ids.map((id) => ({ id } as unknown as DataPoint));

describe("sharesFreehandMembers", () => {
  it("true when every sample is inside the freehand union (subcluster of a freehand inset)", () => {
    expect(sharesFreehandMembers(pts(1, 2, 3), new Set([1, 2, 3, 4, 5]))).toBe(true);
  });

  it("true when the cluster shares only a single point with the freehand union", () => {
    expect(sharesFreehandMembers(pts(1, 8, 9), new Set([1, 2, 3]))).toBe(true);
  });

  it("false when the cluster is disjoint from the freehand union", () => {
    expect(sharesFreehandMembers(pts(7, 8, 9), new Set([1, 2, 3]))).toBe(false);
  });

  it("false when no freehand insets exist", () => {
    expect(sharesFreehandMembers(pts(1, 2), new Set())).toBe(false);
  });

  it("false for empty sample lists", () => {
    expect(sharesFreehandMembers([], new Set([1]))).toBe(false);
  });
});
