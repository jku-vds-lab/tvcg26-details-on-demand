/**
 * Tests for the frontier-backed density substitute (issue #315 A2): the
 * annealer's hit count from cut-frontier candidates instead of the boot
 * spatial indexes.
 */

import { describe, expect, it } from "@jest/globals";
import { createFrontierDensityIndex } from "./frontierDensityIndex";

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({
  minX, minY, maxX, maxY,
});

describe("createFrontierDensityIndex", () => {
  it("search answers empty (only counts are consumed)", () => {
    const idx = createFrontierDensityIndex(() => [{ bbox: box(0, 0, 1, 1), size: 5 }]);
    expect(idx.search(box(0, 0, 1, 1))).toEqual([]);
  });

  it("counts a fully contained candidate whole", () => {
    const idx = createFrontierDensityIndex(() => [{ bbox: box(2, 2, 4, 4), size: 10 }]);
    expect(idx.countIn(box(0, 0, 10, 10))).toBe(10);
  });

  it("scales by bbox overlap fraction for partial intersection", () => {
    // Candidate 2×2 at (0,0)-(2,2); query covers its right half.
    const idx = createFrontierDensityIndex(() => [{ bbox: box(0, 0, 2, 2), size: 8 }]);
    expect(idx.countIn(box(1, 0, 5, 5))).toBeCloseTo(4);
  });

  it("ignores disjoint and bbox-less candidates, sums the rest", () => {
    const idx = createFrontierDensityIndex(() => [
      { bbox: box(0, 0, 1, 1), size: 3 },
      { bbox: box(50, 50, 60, 60), size: 100 },
      { bbox: null, size: 7 },
      { size: 9 },
    ]);
    expect(idx.countIn(box(0, 0, 2, 2))).toBe(3);
  });

  it("counts a degenerate point-sized candidate inside the query", () => {
    const idx = createFrontierDensityIndex(() => [{ bbox: box(5, 5, 5, 5), size: 4 }]);
    expect(idx.countIn(box(0, 0, 10, 10))).toBe(4);
    expect(idx.countIn(box(6, 6, 10, 10))).toBe(0);
  });

  it("reads candidates live per query", () => {
    let candidates = [{ bbox: box(0, 0, 1, 1), size: 1 }];
    const idx = createFrontierDensityIndex(() => candidates);
    expect(idx.countIn(box(0, 0, 2, 2))).toBe(1);
    candidates = [{ bbox: box(0, 0, 1, 1), size: 6 }];
    expect(idx.countIn(box(0, 0, 2, 2))).toBe(6);
  });
});
