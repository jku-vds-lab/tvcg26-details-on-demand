import { describe, expect, it } from "@jest/globals";
import { segmentRectBorderPoint } from "./geometryUtils";

// Rect centred at (50, 50), 100×80 px
// left=0, right=100, top=10, bottom=90
const RECT = { x: 0, y: 10, width: 100, height: 80 };
const CENTER: [number, number] = [50, 50];

describe("segmentRectBorderPoint", () => {
  it("ray to the right exits through the right edge", () => {
    const [x, y] = segmentRectBorderPoint(CENTER, RECT, [200, 50]);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(50);
  });

  it("ray to the left exits through the left edge", () => {
    const [x, y] = segmentRectBorderPoint(CENTER, RECT, [-100, 50]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(50);
  });

  it("ray downward exits through the bottom edge", () => {
    const [x, y] = segmentRectBorderPoint(CENTER, RECT, [50, 200]);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(90);
  });

  it("ray upward exits through the top edge", () => {
    const [x, y] = segmentRectBorderPoint(CENTER, RECT, [50, -100]);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(10);
  });

  it("diagonal ray exits at correct corner for a square rect", () => {
    const squareRect = { x: 0, y: 0, width: 100, height: 100 };
    const sqCenter: [number, number] = [50, 50];
    const [x, y] = segmentRectBorderPoint(sqCenter, squareRect, [200, 200]);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(100);
  });

  it("point exactly at center with zero direction returns center", () => {
    const result = segmentRectBorderPoint(CENTER, RECT, [50, 50]);
    expect(result[0]).toBeCloseTo(50);
    expect(result[1]).toBeCloseTo(50);
  });

  it("toward point outside the rect in a non-axis direction", () => {
    // from centre (50,50), toward (150, 90) — exits right at x=100
    // t for right edge: (100-50)/100 = 0.5; y = 50 + 0.5*40 = 70
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    const [x, y] = segmentRectBorderPoint([50, 50], rect, [150, 90]);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(70);
  });
});
