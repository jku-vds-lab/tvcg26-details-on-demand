import * as d3 from "d3";
import { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";

/**
 * Helper function to compute x and y scales based on the container dimensions and data points.
 *
 * @param width - The width of the container.
 * @param height - The height of the container.
 * @param data - The array of DataPoint objects.
 * @param padding - Optional padding around the visualization (default is 10).
 * @returns An object containing the computed xScale and yScale.
 */
export const computeScales = (
  width: number,
  height: number,
  data: DataPoint[],
  padding: number = 10
): {
  xScale: d3.ScaleLinear<number, number>;
  yScale: d3.ScaleLinear<number, number>;
} => {
  // Compute the min and max for x and y values from the data.
  // Loop, not Math.min(...spread) — spreading puts every point on the call
  // stack and overflows past ~125k points (found by the 1M smoke test, #315).
  // Columnar fast path (issue #315 R1a): same comparisons in the same index
  // order over the mirrored x/y columns, so the extents are bit-identical.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const cols = columnsOf(data);
  if (cols) {
    const { x, y } = cols;
    for (let i = 0; i < x.length; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
  } else {
    for (const d of data) {
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    }
  }
  const extentX: [number, number] = [minX, maxX];
  const extentY: [number, number] = [minY, maxY];

  // Calculate the width and height of the data's domain.
  const dataWidth = extentX[1] - extentX[0];
  const dataHeight = extentY[1] - extentY[0];

  // Determine the scale factor based on the container dimensions and padding.
  const scaleFactor = (Math.min(width, height) - 2 * padding) / Math.max(dataWidth, dataHeight);

  // Calculate the scaled width and height of the data.
  const scaledDataWidth = dataWidth * scaleFactor;
  const scaledDataHeight = dataHeight * scaleFactor;

  // Determine the center of the container.
  const centerX = width / 2;
  const centerY = height / 2;

  // Calculate the range for x and y axes.
  const xRange: [number, number] = [centerX - scaledDataWidth / 2, centerX + scaledDataWidth / 2];
  const yRange: [number, number] = [centerY - scaledDataHeight / 2, centerY + scaledDataHeight / 2];

  // Create the linear scales for x and y.
  const xScale = d3.scaleLinear().domain(extentX).range(xRange);
  const yScale = d3.scaleLinear().domain(extentY).range([yRange[1], yRange[0]]); // Invert y-axis for canvas coordinates

  return { xScale, yScale };
};
