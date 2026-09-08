/**
 * semanticZoom/footprint.ts
 *
 * Screen-space footprint computation.
 *
 * Given a cluster's data-space bounding box (`ClusterTreeNode.bbox`) and the
 * current D3 linear scales, this module projects the bbox into canvas pixels
 * and returns a `ScreenFootprint` with a pixel² area.
 *
 * Design notes:
 * - Using bbox as the footprint approximation is O(1) per cluster and avoids
 *   storing polygon data.  Computing the exact convex-hull area would be more
 *   accurate but requires materialising member coordinates per frame; we trade
 *   a small over-estimate for interactive speed.
 * - Y-axis may be inverted in D3 (screen y grows downward).  We use Math.abs
 *   so the area is always positive regardless of scale orientation.
 */

import type * as d3 from "d3";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import type { ScreenFootprint, Viewbox } from "./types";

// ---------------------------------------------------------------------------
// Core projection helpers
// ---------------------------------------------------------------------------

/**
 * Project a data-space bounding box to screen pixels using D3 scales.
 *
 * @param bbox  Data-space bounding box (from ClusterTreeNode.bbox).
 * @param xScale Current D3 x-scale (data → pixels).
 * @param yScale Current D3 y-scale (data → pixels).
 * @returns Screen-space bbox with pixel² area.
 */
export function projectBBoxToScreen(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
): ScreenFootprint {
  const sx0 = xScale(bbox.minX);
  const sx1 = xScale(bbox.maxX);
  const sy0 = yScale(bbox.minY);
  const sy1 = yScale(bbox.maxY);

  const x0 = Math.min(sx0, sx1);
  const x1 = Math.max(sx0, sx1);
  const y0 = Math.min(sy0, sy1);
  const y1 = Math.max(sy0, sy1);

  const w = x1 - x0;
  const h = y1 - y0;

  return { areaPx: w * h, x0, y0, x1, y1 };
}

/**
 * Compute the screen-space footprint for a cluster node.
 * Returns a zero-area footprint if the node has no bbox.
 */
export function computeScreenFootprint(
  node: ClusterTreeNode,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
): ScreenFootprint {
  if (!node.bbox) {
    return { areaPx: 0, x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  return projectBBoxToScreen(node.bbox, xScale, yScale);
}

/**
 * Screen-space gap between a node's two children, in pixels.
 *
 * Projects both child bboxes to screen and returns the minimum distance
 * between the two axis-aligned rectangles (0 when they overlap or abut).
 * This is the "visible whitespace between blobs" signal used by the
 * gap-disclosure split trigger in the hybrid cut: a node whose children sit
 * across empty space has a large gap; a compact cluster's internal splits
 * have gap ≈ 0.
 *
 * Projection-based on purpose: the HDBSCAN `distance` scalar cannot express
 * the on-screen separation under anisotropic x/y px-per-unit scales.
 * Returns 0 when either child (or its bbox) is missing.
 */
export function childGapPx(
  node: ClusterTreeNode,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
): number {
  const left = node.leftChild;
  const right = node.rightChild;
  if (!left?.bbox || !right?.bbox) return 0;

  const l = projectBBoxToScreen(left.bbox, xScale, yScale);
  const r = projectBBoxToScreen(right.bbox, xScale, yScale);

  const dx = Math.max(0, Math.max(l.x0, r.x0) - Math.min(l.x1, r.x1));
  const dy = Math.max(0, Math.max(l.y0, r.y0) - Math.min(l.y1, r.y1));
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// Viewport helpers
// ---------------------------------------------------------------------------

/**
 * Compute viewport area in pixels² from canvas dimensions.
 */
export function viewportAreaPx(
  canvasWidthPx: number,
  canvasHeightPx: number
): number {
  return Math.max(canvasWidthPx * canvasHeightPx, 1);
}

/**
 * Resolve the viewport-relative split threshold (`splitThresholdFraction`,
 * a fraction of the view area) to the absolute pixel² threshold the zoom-cut
 * builder compares footprints against.  Resolved from the live canvas size so
 * the same setting behaves identically across display sizes; the default
 * fraction (3%) reproduces the historical 34 500 px² exactly on the reference
 * canvas area it was calibrated against (store.SPLIT_THRESHOLD_REFERENCE_AREA_PX).
 */
export function resolveSplitThresholdPx(
  splitThresholdFraction: number,
  canvasWidthPx: number,
  canvasHeightPx: number
): number {
  return splitThresholdFraction * viewportAreaPx(canvasWidthPx, canvasHeightPx);
}

/**
 * Clamp a footprint score to [0, 1] relative to a reference area.
 * Used as a normalised input to the saliency scorer.
 */
export function clampedFootprintScore(
  areaPx: number,
  referenceAreaPx: number
): number {
  if (referenceAreaPx <= 0) return 0;
  return Math.min(1, areaPx / referenceAreaPx);
}

// ---------------------------------------------------------------------------
// Viewbox / viewport intersection
// ---------------------------------------------------------------------------

/**
 * Returns true if the node's data-space bbox overlaps the given viewbox.
 */
export function bboxIntersectsViewbox(
  node: ClusterTreeNode,
  viewbox: Viewbox
): boolean {
  if (!node.bbox) return false;
  const b = node.bbox;
  return (
    b.maxX >= viewbox.minX &&
    b.minX <= viewbox.maxX &&
    b.maxY >= viewbox.minY &&
    b.minY <= viewbox.maxY
  );
}

/**
 * Returns true if the node's data-space bbox is **entirely** within the viewbox
 * (i.e. the viewbox fully contains the cluster).
 * Uses a small epsilon to guard against floating-point edge cases.
 */
export function bboxFullyInsideViewbox(
  node: ClusterTreeNode,
  viewbox: Viewbox,
  eps = 1e-9
): boolean {
  if (!node.bbox) return false;
  const b = node.bbox;
  return (
    b.minX >= viewbox.minX - eps &&
    b.maxX <= viewbox.maxX + eps &&
    b.minY >= viewbox.minY - eps &&
    b.maxY <= viewbox.maxY + eps
  );
}
