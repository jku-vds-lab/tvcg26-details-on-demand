import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";
import { SPOTLIGHT_DIM, relationSpotlightField } from "./relationSpotlightField";

/** Minimal DataPoint fixture — avoids importing from dataPreprocessing.ts (pulls in rbush). */
function makePoint(id: number): DataPoint {
  return {
    id,
    x: 0,
    y: 0,
    line: 0,
    algo: "",
    action: "",
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
  };
}

describe("relationSpotlightField", () => {
  const p10 = makePoint(10);
  const p20 = makePoint(20);
  const p30 = makePoint(30);
  const indexById = new Map<number, number>([[10, 0], [20, 1], [30, 2]]);
  const length = 3;

  // Float32Array stores 0.15 as ~0.15000000596 — use toBeCloseTo for DIM comparisons.
  const DIM = SPOTLIGHT_DIM;

  it("returns all-DIM for empty samples", () => {
    const field = relationSpotlightField([], indexById, length);
    expect(field[0]).toBeCloseTo(DIM);
    expect(field[1]).toBeCloseTo(DIM);
    expect(field[2]).toBeCloseTo(DIM);
  });

  it("sets both endpoint nodes to 1, others stay at DIM", () => {
    const sample: EdgeAugmentedPoint = { ...makePoint(0), edgeStart: p10, edgeEnd: p30 };
    const field = relationSpotlightField([sample], indexById, length);
    expect(field[0]).toBe(1);             // edgeStart id=10 → index 0
    expect(field[1]).toBeCloseTo(DIM);    // untouched
    expect(field[2]).toBe(1);             // edgeEnd id=30 → index 2
  });

  it("silently skips unknown ids (not in indexById)", () => {
    const sample: EdgeAugmentedPoint = { ...makePoint(0), edgeStart: makePoint(99), edgeEnd: p20 };
    const field = relationSpotlightField([sample], indexById, length);
    expect(field[0]).toBeCloseTo(DIM); // id=10 untouched
    expect(field[1]).toBe(1);          // edgeEnd id=20 → index 1
    expect(field[2]).toBeCloseTo(DIM); // untouched
  });

  it("handles sample with edgeStart only (no edgeEnd)", () => {
    const sample: EdgeAugmentedPoint = { ...makePoint(0), edgeStart: p10 };
    const field = relationSpotlightField([sample], indexById, length);
    expect(field[0]).toBe(1);
    expect(field[1]).toBeCloseTo(DIM);
    expect(field[2]).toBeCloseTo(DIM);
  });

  it("handles sample with no endpoints (all remain at DIM)", () => {
    const sample: EdgeAugmentedPoint = makePoint(0) as EdgeAugmentedPoint;
    const field = relationSpotlightField([sample], indexById, length);
    expect(field[0]).toBeCloseTo(DIM);
    expect(field[1]).toBeCloseTo(DIM);
    expect(field[2]).toBeCloseTo(DIM);
  });

  it("spotlights endpoints from multiple samples correctly", () => {
    const s1: EdgeAugmentedPoint = { ...makePoint(0), edgeStart: p10, edgeEnd: p20 };
    const s2: EdgeAugmentedPoint = { ...makePoint(0), edgeStart: p30, edgeEnd: p20 };
    const field = relationSpotlightField([s1, s2], indexById, length);
    expect(field[0]).toBe(1); // p10
    expect(field[1]).toBe(1); // p20 (touched by both samples)
    expect(field[2]).toBe(1); // p30
  });
});
