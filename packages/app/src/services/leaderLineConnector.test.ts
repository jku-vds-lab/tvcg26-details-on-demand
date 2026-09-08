/**
 * services/leaderLineConnector.test.ts
 *
 * Issue #345 regression: leader anchors must be computed against the hull
 * padded for the CURRENT zoom (explicit cssScale), never the hull's stored
 * currentCssScale — that field is only corrected by an effect after the
 * commit that already baked the leader geometry, so anchoring on it aims
 * the leader at a phantom border scaled for an earlier zoom level (the
 * off-screen leader-line bug; same staleness family as issue #265 for the
 * drawn contour).
 */

import { describe, expect, it } from "@jest/globals";
import { scaleLinear } from "d3-scale";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { ClusterConvexHull } from "src/models/ClusterConvexHull";
import { VisualElement, VisualElementType, makeElementId } from "src/models/VisualElement";
import store, { initialClusterSettings, updateClusterSettings } from "src/store";
import { LeaderLineConnector } from "./leaderLineConnector";

// minimal DataPoint stub (same shape as VisualElement.test.ts)
const makePoint = (x: number, y: number): DataPoint =>
  ({
    x,
    y,
    line: 0,
    algo: "test",
    id: 0,
    action: "none",
    DoI: 1,
    nextEdgeCenter: { x, y },
  } as unknown as DataPoint);

// Identity scales: data coords == screen coords.
const xScale = scaleLinear().domain([0, 100]).range([0, 100]);
const yScale = scaleLinear().domain([0, 100]).range([0, 100]);

function makeElement(): VisualElement {
  const el = new VisualElement(
    makeElementId("node", VisualElementType.Annotation, "test"),
    "node",
    VisualElementType.Annotation,
    1,
    0,
    "dummy",
    [makePoint(79, 50), makePoint(81, 50)] // centroid (80, 50)
  );
  el.center = { x: 80, y: 50 };
  return el;
}

describe("LeaderLineConnector.compute — explicit cssScale (issue #345)", () => {
  it("anchors on the hull padded by the passed cssScale, not the stored field", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    // Singleton hull at (50,50): screen hull is a 12-gon of radius paddingPx × cssScale
    // whose angle-0 vertex lies at (50 + r, 50) — directly toward the element at (80,50).
    const hull = new ClusterConvexHull("hull-inset-345", [makePoint(50, 50)]);
    // Bug precondition: the corrective setCssScale effect has not run yet.
    expect(hull.currentCssScale).toBe(1);

    const el = makeElement();
    const positions = new Map([[el.id, { x: 80, y: 50 }]]);

    const geom = LeaderLineConnector.compute(el, hull, xScale, yScale, positions, 0.25);
    // radius must be 12 × 0.25 = 3 (anchor at x = 53), not 12 × stored 1 (x = 62).
    expect(geom.x1).toBeCloseTo(53, 3);
    expect(geom.y1).toBeCloseTo(50, 3);
    expect(geom.x2).toBeCloseTo(80, 3);
    expect(geom.y2).toBeCloseTo(50, 3);
  });

  it("falls back to the hull's stored currentCssScale when cssScale is omitted", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("hull-inset-345b", [makePoint(50, 50)]);
    hull.setCssScale(0.5);

    const el = makeElement();
    const positions = new Map([[el.id, { x: 80, y: 50 }]]);

    const geom = LeaderLineConnector.compute(el, hull, xScale, yScale, positions);
    expect(geom.x1).toBeCloseTo(56, 3); // 12 × 0.5 = 6
  });
});
