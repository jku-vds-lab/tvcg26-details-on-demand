import * as d3 from "d3";
import type { ScaleLinear } from "d3-scale";

export function multiplyMatrix(a: number[], b: number[]): number[] {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i + j * 3] =
      a[i + 0 * 3] * b[0 + j * 3] +
      a[i + 1 * 3] * b[1 + j * 3] +
      a[i + 2 * 3] * b[2 + j * 3];
  }
  return r;
}

export function projectionMatrix(w: number, h: number): number[] {
  return [2 / w, 0, 0, 0, -2 / h, 0, -1, 1, 1];
}

export function dataMatrix(
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>
): number[] {
  const rx = xScale.range(), dx = xScale.domain();
  const a = (rx[1] - rx[0]) / (dx[1] - dx[0]);
  const b = rx[0] - dx[0] * a;
  const ry = yScale.range(), dy = yScale.domain();
  const c = (ry[1] - ry[0]) / (dy[1] - dy[0]);
  const d = ry[0] - dy[0] * c;
  return [a, 0, 0, 0, c, 0, b, d, 1];
}

export function zoomMatrix(t: d3.ZoomTransform): number[] {
  return [t.k, 0, 0, 0, t.k, 0, t.x, t.y, 1];
}