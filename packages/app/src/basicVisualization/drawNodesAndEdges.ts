import * as d3 from "d3";
import type { DataPoint, SplineSegment } from "../dataPreprocessing/dataPreprocessing";
import store from "../store";
import { getColorEncodingKey } from "../utils/colorEncoding";
import { colorScale } from "../utils/colorScale";
import { MIN_DOI_OPACITY_CLAMP } from "../utils/constants";

export interface DrawOptions {
  mode: "interactive" | "background";
  transform?: d3.ZoomTransform; // for positioning the elements
  effectiveScale?: number; // quantized scale for computing node/edge sizes
  forceOpacity?: number; // if we want to forcibly override alpha for background
  forceRadius?: number; // if we want a fixed radius for background
  forceLineWidth?: number; // if we want a fixed line width for background
  forceColor?: boolean;
  visualSettings?: {
    nodeRadius: number;
    edgeWidth: number;
  };
}

/**
 * Helper to obtain visual settings.
 * If options.visualSettings is undefined, we return the current settings from the store.
 */
function getVisualSettings(options: DrawOptions): { nodeRadius: number; edgeWidth: number } {
  return options.visualSettings ?? {
    nodeRadius: store.getState().visualizationSettings.nodeRadius,
    edgeWidth: store.getState().visualizationSettings.edgeWidth,
  };
}

/**
 * Draw all points and edges using a single code path.
 */
export function drawAll(
  context: CanvasRenderingContext2D,
  _width: number,
  _height: number,
  points: DataPoint[],
  segments: SplineSegment[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  options: DrawOptions
) {
  const transform = options.transform || d3.zoomIdentity;
  // Ensure we always have visual settings (from options or the store)
  const visualSettings = getVisualSettings(options);
  const colorEncoding = store.getState().visualizationSettings.colorEncoding;

  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.save();

  if (options.mode === "interactive") {
    // Apply the actual transform for positioning
    context.translate(transform.x, transform.y);
    context.scale(transform.k, transform.k);
  }
  // Draw edges first so that nodes appear on top.
  segments.forEach((segment) => {
    drawOneSegment(context, segment, xScale, yScale, { ...options, visualSettings }, transform, colorEncoding);
  });

  // Draw points.
  points.forEach((point) => {
    drawOnePoint(context, point, xScale, yScale, { ...options, visualSettings }, transform, colorEncoding);
  });

  context.restore();
}

/**
 * Draw a single node.
 */
function drawOnePoint(
  context: CanvasRenderingContext2D,
  point: DataPoint,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  options: DrawOptions,
  transform: d3.ZoomTransform,
  colorEncoding: string
) {
  const visualSettings = getVisualSettings(options);
  // In background mode, always use grey; in interactive mode, use the color scale.
  const colorKey = getColorEncodingKey(point, colorEncoding);
  const fillColor = options.mode === "background"
    ? "#808080"
    : (colorKey !== null ? colorScale(colorKey) : "#000");

  const doI = point.DoI ?? 0;
  let alpha = Math.max(MIN_DOI_OPACITY_CLAMP, doI);

  // In background mode, force opacity to the minimal value.
  if (options.mode === "background" && typeof options.forceOpacity === "number") {
    alpha = options.forceOpacity;
  }

  context.fillStyle = fillColor;
  context.globalAlpha = alpha;

  const cx = xScale(point.x);
  const cy = yScale(point.y);

  let radius = visualSettings.nodeRadius;
  let scaleFactor = 1;
  if (options.mode === "interactive") {
    scaleFactor = options.effectiveScale !== undefined ? options.effectiveScale : transform.k;
    radius = visualSettings.nodeRadius / scaleFactor;
  } else if (options.forceRadius !== undefined) {
    radius = options.forceRadius;
  }

  context.beginPath();
  context.arc(cx, cy, radius, 0, 2 * Math.PI);
  context.fill();

  // Draw an outline if the node is selected.
  if (point.selected) {
    context.lineWidth = 2 / scaleFactor;
    context.strokeStyle = "black";
    context.stroke();
  }
}

/**
 * Draw a single edge.
 */
function drawOneSegment(
  context: CanvasRenderingContext2D,
  segment: SplineSegment,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  options: DrawOptions,
  transform: d3.ZoomTransform,
  colorEncoding: string
) {
  const { x0, y0, x1, y1, data } = segment;
  const { lastDataPoint, nextDataPoint } = data;

  const p0x = xScale(x0);
  const p0y = yScale(y0);
  const p1x = xScale(x1);
  const p1y = yScale(y1);

  let segOpacity = Math.max(MIN_DOI_OPACITY_CLAMP, data.doi ?? 0);
  if (options.mode === "background" && typeof options.forceOpacity === "number") {
    segOpacity = options.forceOpacity;
  }

  // In background mode, force both edge endpoints to grey.
  let c0, c1;
  if (options.mode === "background") {
    c0 = { r: 128, g: 128, b: 128 };
    c1 = { r: 128, g: 128, b: 128 };
  } else {
    const startKey = getColorEncodingKey(lastDataPoint, colorEncoding);
    const endKey = getColorEncodingKey(nextDataPoint, colorEncoding);
    c0 = hexToRgb(startKey !== null ? colorScale(startKey) : "#000000");
    c1 = hexToRgb(endKey !== null ? colorScale(endKey) : "#000000");
  }

  // Apply the color transition over the full spline by using edge-relative percentages
  // for this segment's start/end instead of repeating the full endpoint gradient.
  const segmentStartColor = interpolateRgb(c0, c1, clamp01(data.startPercentage ?? 0));
  const segmentEndColor = interpolateRgb(c0, c1, clamp01(data.endPercentage ?? 1));

  const gradient = context.createLinearGradient(p0x, p0y, p1x, p1y);
  gradient.addColorStop(0, `rgba(${segmentStartColor.r}, ${segmentStartColor.g}, ${segmentStartColor.b}, ${segOpacity})`);
  gradient.addColorStop(1, `rgba(${segmentEndColor.r}, ${segmentEndColor.g}, ${segmentEndColor.b}, ${segOpacity})`);

  context.strokeStyle = gradient;

  const visualSettings = getVisualSettings(options);
  let lineWidth = visualSettings.edgeWidth;
  if (options.mode === "interactive") {
    const scaleFactor = options.effectiveScale !== undefined ? options.effectiveScale : transform.k;
    lineWidth = visualSettings.edgeWidth / scaleFactor;
  } else if (options.forceLineWidth !== undefined) {
    lineWidth = options.forceLineWidth;
  }
  context.lineWidth = lineWidth;

  context.globalAlpha = 1;
  context.beginPath();
  context.moveTo(p0x, p0y);
  context.lineTo(p1x, p1y);
  context.stroke();
}

/**
 * Helper to convert a hex color (e.g. "#d95f02") to an RGB object.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Remove the leading '#' if present.
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  const bigint = parseInt(hex, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
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
