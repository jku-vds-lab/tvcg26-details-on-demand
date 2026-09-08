/**
 * models/ClusterConvexHull.test.ts
 *
 * Degenerate-hull behavior for tiny clusters (issue #258 phase C): a
 * 1-member cluster must yield a padded circle polygon (≥ 3 screen points)
 * so the contour outline, contour obstacle, and leader anchoring all work,
 * while the 2-point rounded box and ≥ 3-point hull paths stay unchanged.
 */

import { describe, expect, it, jest } from "@jest/globals";

// Mock rbush (ESM, pulled in via dataPreprocessing) to avoid transform issues.
jest.mock("rbush", () => ({
  __esModule: true,
  default: class RBushMock {
    load() {}
    clear() {}
    all() { return []; }
    insert() {}
    search() { return []; }
  },
}));
import * as d3 from "d3";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "src/dataPreprocessing/dataPreprocessing";
import store, { initialClusterSettings, updateClusterSettings } from "src/store";
import { ClusterConvexHull } from "./ClusterConvexHull";

function mkPoint(id: number, x: number, y: number): DataPoint {
  return {
    ...createEmptyDataPoint(),
    id,
    x,
    y,
    DoI: 1,
    doiGroup: "inset" as const,
  };
}

// Identity scales: data coords == screen coords.
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);

describe("ClusterConvexHull — singleton degenerate hull", () => {
  it("produces a padded circle polygon for a 1-point cluster", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("h1", [mkPoint(1, 50, 50)]);

    expect(hull.hullPoints).not.toBeNull();
    const screen = hull.getScreenHull(xScale, yScale);

    // ≥ 3 points so the contour-obstacle gate (points.length < 3) passes.
    expect(screen.length).toBeGreaterThanOrEqual(3);

    // Every vertex sits at radius paddingPx × cssScale (1) around the point.
    for (const [px, py] of screen) {
      expect(Math.hypot(px - 50, py - 50)).toBeCloseTo(12, 6);
    }
  });

  it("scales the circle radius with the css scale like other contours", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("h2", [mkPoint(1, 50, 50)]);
    hull.setCssScale(2);

    const screen = hull.getScreenHull(xScale, yScale);
    for (const [px, py] of screen) {
      expect(Math.hypot(px - 50, py - 50)).toBeCloseTo(24, 6);
    }
  });

  it("lets an explicit cssScale argument override the stored field (issue #265)", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("h6", [mkPoint(1, 50, 50)]);
    // Freshly constructed hull: currentCssScale is still the default 1 —
    // exactly the state a render-time caller sees before the setCssScale
    // effect runs after commit.
    expect(hull.currentCssScale).toBe(1);

    const screen = hull.getScreenHull(xScale, yScale, 0.25);
    for (const [px, py] of screen) {
      expect(Math.hypot(px - 50, py - 50)).toBeCloseTo(3, 6);
    }

    // Legacy callers without the argument keep reading the stored field.
    const legacy = hull.getScreenHull(xScale, yScale);
    for (const [px, py] of legacy) {
      expect(Math.hypot(px - 50, py - 50)).toBeCloseTo(12, 6);
    }
  });

  it("renders a non-null contour div for a 1-point cluster", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
    const hull = new ClusterConvexHull("h3", [mkPoint(1, 50, 50)]);
    expect(hull.renderConvexHullDiv(xScale, yScale, 100, 100)).not.toBeNull();
  });

  it("keeps the 2-point rounded box unchanged", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("h4", [mkPoint(1, 40, 50), mkPoint(2, 60, 50)]);

    expect(hull.hullPoints).toHaveLength(2);
    const screen = hull.getScreenHull(xScale, yScale);
    expect(screen).toHaveLength(4); // oriented rounded box corners
  });

  it("keeps the >= 3-point convex hull path unchanged", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
    const hull = new ClusterConvexHull("h5", [
      mkPoint(1, 40, 40),
      mkPoint(2, 60, 40),
      mkPoint(3, 50, 60),
    ]);

    expect(hull.hullPoints).toHaveLength(3);
    const screen = hull.getScreenHull(xScale, yScale);
    expect(screen.length).toBeGreaterThanOrEqual(3);
  });
});
