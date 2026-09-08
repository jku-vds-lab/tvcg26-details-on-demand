
import * as d3 from "d3";
import type { RendererAPI } from "src/gl/api/RendererAPI";
import { dataMatrix, multiplyMatrix, projectionMatrix, zoomMatrix } from "src/gl/math/matrices2d";

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

export function updateRendererTransform(
  transform: d3.ZoomTransform,
  width: number,
  height: number,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  renderer: RendererAPI
): void {
  const newMat = computeRendererTransformMatrix(transform, width, height, xScale, yScale);
  renderer.setTransform(newMat);
}