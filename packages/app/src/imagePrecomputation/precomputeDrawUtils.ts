/**
 * src/imagePrecomputation/precomputeDrawUtils.ts
 *
 * Helper functions that replicate the existing drawing logic
 * but force minimal opacity (0.1). We keep these separate from
 * the normal drawing code so we don't clutter the main flow.
 */

import * as d3 from "d3";
import { DataPoint, SplineSegment } from "../dataPreprocessing/dataPreprocessing";
import store from "../store";
import { getColorEncodingKey } from "../utils/colorEncoding";
import { colorScale } from "../utils/colorScale";
import { hexToRgb } from "../utils/utils";

// A default color in case hexToRgb returns null.
const DEFAULT_RGB = { r: 0, g: 0, b: 0 };

/** Draw edges at forced minimal opacity. */
export function drawBackgroundSegments(
  context: CanvasRenderingContext2D,
  segments: SplineSegment[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
) {
  const colorEncoding = store.getState().visualizationSettings.colorEncoding;
  segments.forEach((segment) => {
    const { x0, y0, x1, y1, data } = segment;
    const { lastDataPoint, nextDataPoint } = data;

    // Map data coords to canvas
    const p0x = xScale(x0);
    const p0y = yScale(y0);
    const p1x = xScale(x1);
    const p1y = yScale(y1);

    // Force minimal opacity (0.1)
    // We'll do a simple gradient from the color of lastDataPoint.algo to nextDataPoint.algo
    const startKey = lastDataPoint ? getColorEncodingKey(lastDataPoint, colorEncoding) : null;
    const endKey = nextDataPoint ? getColorEncodingKey(nextDataPoint, colorEncoding) : null;
    const startHex = startKey !== null ? colorScale(startKey) : "#000000";
    const endHex = endKey !== null ? colorScale(endKey) : "#000000";
    const c0 = hexToRgb(startHex) || DEFAULT_RGB;
    const c1 = hexToRgb(endHex) || DEFAULT_RGB;

    const segmentStartColor = interpolateRgb(c0, c1, clamp01(data.startPercentage ?? 0));
    const segmentEndColor = interpolateRgb(c0, c1, clamp01(data.endPercentage ?? 1));

    const gradient = context.createLinearGradient(p0x, p0y, p1x, p1y);
    gradient.addColorStop(0, `rgba(${segmentStartColor.r}, ${segmentStartColor.g}, ${segmentStartColor.b}, 0.1)`);
    gradient.addColorStop(1, `rgba(${segmentEndColor.r}, ${segmentEndColor.g}, ${segmentEndColor.b}, 0.1)`);

    context.strokeStyle = gradient;
    context.lineWidth = 2; // or use a smaller default for background
    context.beginPath();
    context.moveTo(p0x, p0y);
    context.lineTo(p1x, p1y);
    context.stroke();
  });
}

/** Draw points at forced minimal opacity. */
export function drawBackgroundPoints(
  context: CanvasRenderingContext2D,
  points: DataPoint[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>
) {
  const colorEncoding = store.getState().visualizationSettings.colorEncoding;
  points.forEach((point) => {
    const x = xScale(point.x);
    const y = yScale(point.y);

    // Force minimal opacity
    const colorKey = getColorEncodingKey(point, colorEncoding);
    const fillColor = colorKey !== null ? colorScale(colorKey) : "#000000";
    context.fillStyle = fillColor;
    context.globalAlpha = 0.1;

    const radius = 5;

    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
    context.fill();
  });

  // Reset globalAlpha
  context.globalAlpha = 1;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function interpolateRgb(
  start: { r: number; g: number; b: number },
  end: { r: number; g: number; b: number },
  t: number
): { r: number; g: number; b: number } {
  return {
    r: Math.round(start.r + (end.r - start.r) * t),
    g: Math.round(start.g + (end.g - start.g) * t),
    b: Math.round(start.b + (end.b - start.b) * t),
  };
}
