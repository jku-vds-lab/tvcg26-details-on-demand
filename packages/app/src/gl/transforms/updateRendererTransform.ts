// src/gl/transform/updateRendererTransform.ts

import * as d3 from "d3";
import type { RendererAPI } from "../api/RendererAPI";
import { dataMatrix, multiplyMatrix, projectionMatrix, zoomMatrix } from "../math/matrices2d";

export function computeRendererTransformMatrix(
  transform: d3.ZoomTransform,
  width: number,
  height: number,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
): number[] {
  const proj = projectionMatrix(width, height);
  const zoomMat = zoomMatrix(transform);
  const dataMat = dataMatrix(xScale, yScale);
  return multiplyMatrix(proj, multiplyMatrix(zoomMat, dataMat));
}

/**
 * Keeps the old call signature used around the app:
 * compute matrix (proj * zoom * data) and push it into the renderer.
 */
export function updateRendererTransform(
  transform: d3.ZoomTransform,
  width: number,
  height: number,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  renderer: RendererAPI
): void {
  const mat = computeRendererTransformMatrix(transform, width, height, xScale, yScale);
  renderer.setTransform(mat);
}
