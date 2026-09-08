import { describe, expect, it } from "@jest/globals";
import { computeRelationLeaderStyle } from "./relationLeaderStyle";
import type { RelationLeaderStyleOpts } from "./relationLeaderStyle";

const BASE: RelationLeaderStyleOpts = {
  minArrow: 4,
  maxArrow: 12,
  minWidth: 1,
  baseWidth: 2,
  outlineThickness: 6,
  widthEncodesStrength: false,
};

describe("computeRelationLeaderStyle", () => {
  it("arrowLength at s=0 equals minArrow", () => {
    const r = computeRelationLeaderStyle(0, BASE);
    expect(r.arrowLength).toBeCloseTo(4);
  });

  it("arrowLength at s=1 equals maxArrow", () => {
    const r = computeRelationLeaderStyle(1, BASE);
    expect(r.arrowLength).toBeCloseTo(12);
  });

  it("arrowLength at s=0.5 is midpoint", () => {
    const r = computeRelationLeaderStyle(0.5, BASE);
    expect(r.arrowLength).toBeCloseTo(8);
  });

  it("lineWidth is constant (baseWidth) when widthEncodesStrength=false", () => {
    expect(computeRelationLeaderStyle(0, BASE).lineWidth).toBeCloseTo(2);
    expect(computeRelationLeaderStyle(1, BASE).lineWidth).toBeCloseTo(2);
  });

  it("lineWidth lerps from minWidth to baseWidth when widthEncodesStrength=true", () => {
    const opts = { ...BASE, widthEncodesStrength: true };
    expect(computeRelationLeaderStyle(0, opts).lineWidth).toBeCloseTo(1);
    expect(computeRelationLeaderStyle(1, opts).lineWidth).toBeCloseTo(2);
    expect(computeRelationLeaderStyle(0.5, opts).lineWidth).toBeCloseTo(1.5);
  });

  it("outlineWidth = lineWidth + constant halo", () => {
    // halo = outlineThickness(6) - baseWidth(2) = 4
    const r = computeRelationLeaderStyle(0.5, BASE);
    expect(r.outlineWidth).toBeCloseTo(r.lineWidth + 4);
  });

  it("outlineWidth grows with lineWidth when widthEncodesStrength=true", () => {
    const opts = { ...BASE, widthEncodesStrength: true };
    const r0 = computeRelationLeaderStyle(0, opts);  // lineWidth=1, halo=4, outline=5
    const r1 = computeRelationLeaderStyle(1, opts);  // lineWidth=2, halo=4, outline=6
    expect(r0.outlineWidth).toBeCloseTo(r0.lineWidth + 4);
    expect(r1.outlineWidth).toBeCloseTo(r1.lineWidth + 4);
    expect(r1.outlineWidth).toBeGreaterThan(r0.outlineWidth);
  });

  it("maxArrow < minArrow is clamped (uses minArrow as both ends)", () => {
    const opts = { ...BASE, minArrow: 12, maxArrow: 4 }; // inverted
    // maxA = max(12,4)=12; arrowLength at s=0 = 12 + 0 = 12
    const r0 = computeRelationLeaderStyle(0, opts);
    expect(r0.arrowLength).toBeCloseTo(12);
  });

  it("strength is clamped to [0,1]", () => {
    const rNeg = computeRelationLeaderStyle(-0.5, BASE);
    const rOver = computeRelationLeaderStyle(1.5, BASE);
    expect(rNeg.arrowLength).toBeCloseTo(4);   // same as s=0
    expect(rOver.arrowLength).toBeCloseTo(12); // same as s=1
  });
});
