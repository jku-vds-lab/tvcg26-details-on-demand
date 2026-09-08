/**
 * semanticZoom/__tests__/footprint.test.ts
 *
 * Unit tests for screen-space footprint computation.
 */

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { bboxIntersectsViewbox, computeScreenFootprint } from "../footprint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
): ClusterTreeNode {
  return {
    id: 0,
    uid: "0x1",
    distance: 0,
    size: 1,
    stability: 1,
    bbox,
  };
}

// xScale: data [0,100] → screen [0,500]  (5 px per data unit)
// yScale: data [0,100] → screen [0,500]  (5 px per data unit, same orientation)
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 500]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 500]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeScreenFootprint", () => {
  it("returns zero-area footprint when node has no bbox", () => {
    const node: ClusterTreeNode = {
      id: 0,
      uid: "0x1",
      distance: 0,
      size: 1,
      stability: 1,
    };
    const fp = computeScreenFootprint(node, xScale, yScale);
    expect(fp.areaPx).toBe(0);
    expect(fp.x0).toBe(0);
    expect(fp.y0).toBe(0);
  });

  it("projects a data-space bbox to screen pixels correctly", () => {
    // data bbox: 10×10 units → screen 50×50 px → 2500 px²
    const node = makeNode({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const fp = computeScreenFootprint(node, xScale, yScale);
    expect(fp.areaPx).toBeCloseTo(2500);
    expect(fp.x0).toBeCloseTo(0);
    expect(fp.y0).toBeCloseTo(0);
    expect(fp.x1).toBeCloseTo(50);
    expect(fp.y1).toBeCloseTo(50);
  });

  it("handles inverted y-scale (screen y grows downward)", () => {
    // yScale inverted: data [0,100] → screen [500,0]  (y flipped)
    const yFlipped = d3.scaleLinear().domain([0, 100]).range([500, 0]);
    const node = makeNode({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const fp = computeScreenFootprint(node, xScale, yFlipped);
    // width = 50, height = |500 - 450| = 50
    expect(fp.areaPx).toBeCloseTo(2500);
    expect(fp.x0).toBeCloseTo(0);
    expect(fp.x1).toBeCloseTo(50);
  });

  it("returns correct area for large bbox spanning full domain", () => {
    // full domain → full screen: 500×500 px = 250000 px²
    const node = makeNode({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const fp = computeScreenFootprint(node, xScale, yScale);
    expect(fp.areaPx).toBeCloseTo(250_000);
  });

  it("returns positive area regardless of bbox corner ordering", () => {
    // Some implementations might have maxX < minX due to scale inversion
    const xInv = d3.scaleLinear().domain([0, 100]).range([500, 0]);
    const node = makeNode({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const fp = computeScreenFootprint(node, xInv, yScale);
    expect(fp.areaPx).toBeGreaterThan(0);
  });
});

describe("bboxIntersectsViewbox", () => {
  it("returns false for node with no bbox", () => {
    const node: ClusterTreeNode = {
      id: 0, uid: "0x1", distance: 0, size: 1, stability: 1,
    };
    expect(bboxIntersectsViewbox(node, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(false);
  });

  it("returns true when bbox overlaps viewbox", () => {
    const node = makeNode({ minX: 5, minY: 5, maxX: 15, maxY: 15 });
    expect(bboxIntersectsViewbox(node, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(true);
  });

  it("returns false when bbox is completely outside viewbox", () => {
    const node = makeNode({ minX: 20, minY: 20, maxX: 30, maxY: 30 });
    expect(bboxIntersectsViewbox(node, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(false);
  });

  it("returns true for bbox exactly touching viewbox edge", () => {
    const node = makeNode({ minX: 10, minY: 10, maxX: 20, maxY: 20 });
    expect(bboxIntersectsViewbox(node, { minX: 0, minY: 0, maxX: 10, maxY: 10 })).toBe(true);
  });
});
