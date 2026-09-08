import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { colorDiff54 } from "./rubiksUtils";

/** Build a minimal DataPoint with all 54 stickers set to a single Rubiks color code. */
function makeUniformRubiksPoint(color: string): DataPoint {
  const faceNames = ["up", "left", "front", "right", "down", "back"] as const;
  const p: Record<string, unknown> = { x: 0, y: 0, id: 0, line: 0 };
  for (const face of faceNames) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        p[`${face}${i}${j}`] = color;
      }
    }
  }
  return p as unknown as DataPoint;
}

// COLOR_IDX from rubiksUtils: O=0, Y=1, G=2, B=3, R=4, W=5
const R_IDX = 4;
const W_IDX = 5;

describe("colorDiff54", () => {
  it("returns all-zero deltas when start and end have the same color", () => {
    const pts    = [makeUniformRubiksPoint("W"), makeUniformRubiksPoint("W")];
    const result = colorDiff54(pts, pts);
    expect(result).toHaveLength(54);
    for (const { delta } of result) {
      expect(delta).toBe(0);
    }
  });

  it("returns delta ≈ 1 and correct color when all stickers flip from W to R", () => {
    const starts = [makeUniformRubiksPoint("W")];
    const ends   = [makeUniformRubiksPoint("R")];
    const result = colorDiff54(starts, ends);
    expect(result).toHaveLength(54);
    for (const { color, delta } of result) {
      expect(delta).toBeCloseTo(1, 5);
      expect(color).toBe(R_IDX);
    }
  });

  it("returns delta 0 when start and end are the same single-point sample", () => {
    const pt     = makeUniformRubiksPoint("G");
    const result = colorDiff54([pt], [pt]);
    for (const { delta } of result) {
      expect(delta).toBe(0);
    }
  });

  it("handles empty start array without throwing", () => {
    const ends   = [makeUniformRubiksPoint("W")];
    const result = colorDiff54([], ends);
    expect(result).toHaveLength(54);
    // All stickers should show W as the gaining color with delta = 1 (end=1, start=0)
    for (const { color, delta } of result) {
      expect(delta).toBeCloseTo(1, 5);
      expect(color).toBe(W_IDX);
    }
  });
});
