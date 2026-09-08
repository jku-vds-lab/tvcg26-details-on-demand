// src/utils/viewboxUtils.ts
import * as d3 from "d3";

/**
 * Computes the viewbox based on the provided canvas container, scales, and zoom transform.
 * The viewbox is determined by inverting the canvas dimensions using the zoomed scales.
 */
export function computeViewbox(
  canvasContainer: HTMLDivElement,
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> },
  zoomTransform: d3.ZoomTransform
) {
  const canvasEl = canvasContainer.querySelector("canvas");
  if (!canvasEl) {
    throw new Error("Canvas element not found in container.");
  }
  const zoomedXScale = zoomTransform.rescaleX(scales.xScale);
  const zoomedYScale = zoomTransform.rescaleY(scales.yScale);
  return {
    minX: zoomedXScale.invert(0),
    maxX: zoomedXScale.invert(canvasEl.clientWidth),
    minY: zoomedYScale.invert(canvasEl.clientHeight),
    maxY: zoomedYScale.invert(0),
  };
}

/**
 * Inverse of `computeViewbox`: builds the d3 zoom transform that shows the
 * given data-space viewbox on a canvas of the given pixel size.
 *
 * Fit-min semantics: the viewbox center stays centered and the zoom factor is
 * the largest k that keeps the whole viewbox visible, so the transform is an
 * exact inverse when the canvas aspect matches the encoding-time aspect and a
 * centered superset view otherwise. Inverted scale ranges (the app's yScale
 * maps its range as [height, 0]) are absorbed by the abs() spans.
 *
 * Returns null for degenerate inputs (zero/non-finite spans or canvas size).
 */
export function viewboxToTransform(
  viewbox: { minX: number; maxX: number; minY: number; maxY: number },
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> },
  width: number,
  height: number
): d3.ZoomTransform | null {
  const px0 = scales.xScale(viewbox.minX);
  const px1 = scales.xScale(viewbox.maxX);
  const py0 = scales.yScale(viewbox.minY);
  const py1 = scales.yScale(viewbox.maxY);

  const spanX = Math.abs(px1 - px0);
  const spanY = Math.abs(py1 - py0);
  if (![px0, px1, py0, py1, width, height].every(Number.isFinite)) return null;
  if (spanX <= 0 || spanY <= 0 || width <= 0 || height <= 0) return null;

  const k = Math.min(width / spanX, height / spanY);
  const cx = (px0 + px1) / 2;
  const cy = (py0 + py1) / 2;

  return d3.zoomIdentity.translate(width / 2, height / 2).scale(k).translate(-cx, -cy);
}
