import * as d3 from "d3";

/* --------------------------------------------------------------------------
   Spline Type Definitions
-------------------------------------------------------------------------- */

/**
 * Represents a single spline segment with start and end coordinates,
 * and associated metadata.
 */
export interface SplineSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  data: {
    nextDataPoint: unknown;
    lastDataPoint: unknown;
    startPercentage: number;
    endPercentage: number;
    splineMidPoint: { x: number | null; y: number | null };
  };
}

/**
 * Represents an interpolated point along a spline.
 */
export interface SplinePoint {
  x: number;
  y: number;
  nextDataPoint: unknown;
  lastDataPoint: unknown;
  startPercentage: number;
  endPercentage: number;
  splineMidPoint: { x: number | null; y: number | null };
}

/**
 * Represents a merged spline segment computed from multiple splines.
 */
export interface MergedSplineSegment {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  data: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    data: {
      nextDataPoint: unknown[];
      lastDataPoint: unknown[];
      startPercentage: number;
      endPercentage: number;
      splineMidPoint: { x: number; y: number };
      numberSplines: number;
    };
  };
}

/* --------------------------------------------------------------------------
   Canvas and SVG Setup
-------------------------------------------------------------------------- */

/**
 * Creates & styles a parent <div>, plus a child <canvas> and <svg> for drawing.
 * Returns {canvas, context, svg, container}.
 */
export function setupCanvasAndSVG(
  el: HTMLElement,
  dpi: number,
  width: number,
  height: number
) {
  const container = d3
    .select(el)
    .style("display", "flex")
    .style("position", "relative")
    .style("width", width + "px")
    .style("height", height + "px")
    .style("overflow", "hidden")
    .style("border", "1px solid lightgray");

  const canvasSelection = container
    .append("canvas")
    .attr("width", width * dpi)
    .attr("height", height * dpi)
    .classed("shared-zoom", true)
    .style("width", width + "px")
    .style("height", height + "px");

  const context = (canvasSelection.node() as HTMLCanvasElement)
    .getContext("2d")!;
  context.scale(dpi, dpi);
  context.clearRect(0, 0, width, height);

  const svg = container
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .classed("shared-zoom", true)
    .style("position", "absolute")
    .style("top", "0")
    .style("left", "0")
    .style("pointer-events", "all");

  // Create an empty group for grid lines as the first (bottom) layer.
  svg.insert("g", ":first-child").attr("class", "grid-lines");

  return { canvas: canvasSelection, context, svg, container };
}

/* --------------------------------------------------------------------------
   Grid Lines Update
-------------------------------------------------------------------------- */

/**
 * Updates grid lines on the SVG based on the current zoom transform.
 *
 * The grid is computed in data space (using the base scales' domain)
 * and then transformed to screen coordinates using the current zoom transform.
 * Major grid lines are spaced by `majorScreenSpacing` pixels in screen space.
 * Minor grid lines are added between them when zoomed in.
 * The grid lines always appear with constant stroke width regardless of zoom,
 * and they are drawn behind all other elements.
 */
export function updateGridLines(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  transform: d3.ZoomTransform,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  width: number,
  height: number
): void {
  // Desired spacing in screen pixels.
  const majorScreenSpacing = 50;
  const minorDivisions = 5; // minor grid lines between majors

  // Compute the equivalent spacing in data space (using the base scales).
  const domainX = xScale.domain();
  const domainY = yScale.domain();
  const dataRangeX = domainX[1] - domainX[0];
  const dataRangeY = domainY[1] - domainY[0];
  const baseScreenWidth = width;
  const baseScreenHeight = height;

  // Determine the scale factors from data space to screen space (at base, before zoom).
  const dataPerScreenX = dataRangeX / baseScreenWidth;
  const dataPerScreenY = dataRangeY / baseScreenHeight;

  // Therefore, the major grid spacing in data units is:
  const majorSpacingDataX = majorScreenSpacing * dataPerScreenX;
  const majorSpacingDataY = majorScreenSpacing * dataPerScreenY;

  // Minor spacing in data units.
  const minorSpacingDataX = majorSpacingDataX / minorDivisions;
  const minorSpacingDataY = majorSpacingDataY / minorDivisions;

  // Instead of computing the view bounding box from the transform,
  // we use the fixed base domain so that grid intersections remain stable.
  const startX = Math.floor(domainX[0] / majorSpacingDataX) * majorSpacingDataX;
  const endX = Math.ceil(domainX[1] / majorSpacingDataX) * majorSpacingDataX;
  const startY = Math.floor(domainY[0] / majorSpacingDataY) * majorSpacingDataY;
  const endY = Math.ceil(domainY[1] / majorSpacingDataY) * majorSpacingDataY;

  // Select the grid group (it is assumed to be the bottom layer)
  const gridGroup = svg.select<SVGGElement>("g.grid-lines");
  gridGroup.selectAll("*").remove();

  // Draw minor grid lines if zoomed in enough (e.g., transform.k > 2).
  if (transform.k > 2) {
    // Vertical minor lines.
    for (let x = startX; x <= endX; x += minorSpacingDataX) {
      if (Math.abs(x / majorSpacingDataX - Math.round(x / majorSpacingDataX)) < 1e-6)
        continue;
      const screenX = transform.applyX(xScale(x));
      gridGroup
        .append("line")
        .attr("x1", screenX)
        .attr("y1", 0)
        .attr("x2", screenX)
        .attr("y2", height)
        .style("stroke", "#eee")
        .style("stroke-width", 0.5 / transform.k);
    }
    // Horizontal minor lines.
    for (let y = startY; y <= endY; y += minorSpacingDataY) {
      if (Math.abs(y / majorSpacingDataY - Math.round(y / majorSpacingDataY)) < 1e-6)
        continue;
      const screenY = transform.applyY(yScale(y));
      gridGroup
        .append("line")
        .attr("x1", 0)
        .attr("y1", screenY)
        .attr("x2", width)
        .attr("y2", screenY)
        .style("stroke", "#eee")
        .style("stroke-width", 0.5 / transform.k);
    }
  }

  // Draw major vertical grid lines.
  for (let x = startX; x <= endX; x += majorSpacingDataX) {
    const screenX = transform.applyX(xScale(x));
    gridGroup
      .append("line")
      .attr("x1", screenX)
      .attr("y1", 0)
      .attr("x2", screenX)
      .attr("y2", height)
      .style("stroke", "lightgray")
      .style("stroke-width", 1 / transform.k);
  }

  // Draw major horizontal grid lines.
  for (let y = startY; y <= endY; y += majorSpacingDataY) {
    const screenY = transform.applyY(yScale(y));
    gridGroup
      .append("line")
      .attr("x1", 0)
      .attr("y1", screenY)
      .attr("x2", width)
      .attr("y2", screenY)
      .style("stroke", "lightgray")
      .style("stroke-width", 1 / transform.k);
  }
}

/* --------------------------------------------------------------------------
   Scale Definition
-------------------------------------------------------------------------- */

/**
 * Defines xScale & yScale based on the data's min/max x/y.
 */
export function defineScales<T extends { x: number; y: number }>(
  data: T[],
  width: number,
  height: number
): { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } {
  return {
    xScale: d3
      .scaleLinear<number, number>()
      .domain(d3.extent(data, (d: T) => d.x) as [number, number])
      .range([10, width - 10]),
    yScale: d3
      .scaleLinear<number, number>()
      .domain(d3.extent(data, (d: T) => d.y) as [number, number])
      .range([10, height - 10]),
  };
}

/* --------------------------------------------------------------------------
   Visibility and Bounding Box
-------------------------------------------------------------------------- */

/**
 * Checks if an (x, y) is within the visible area after transform.
 */
export function isVisible(
  x: number,
  y: number,
  transform: d3.ZoomTransform,
  width: number,
  height: number
): boolean {
  const screenX = x * transform.k + transform.x;
  const screenY = y * transform.k + transform.y;
  return screenX >= 0 && screenX <= width && screenY >= 0 && screenY <= height;
}

/**
 * Returns the bounding box (in data coordinates) for the current view.
 */
export function getViewBoundingBoxCanvas(
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  transform: d3.ZoomTransform,
  width: number,
  height: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  return {
    minX: xScale.invert(-transform.x / transform.k),
    maxX: xScale.invert((width - transform.x) / transform.k),
    minY: yScale.invert(-transform.y / transform.k),
    maxY: yScale.invert((height - transform.y) / transform.k),
  };
}

/* --------------------------------------------------------------------------
   Spline Interpolation and Merging
-------------------------------------------------------------------------- */

/**
 * Interpolates points along a spline to unify them to the same number of segments.
 *
 * @param spline - An array of SplineSegment objects.
 * @param numPoints - The desired number of points.
 * @returns An array of interpolated SplinePoint objects.
 */
function interpolateSpline(
  spline: SplineSegment[],
  numPoints: number
): SplinePoint[] {
  if (!Array.isArray(spline) || spline.length === 0) {
    throw new Error("Spline data must be a non-empty array.");
  }
  if (typeof numPoints !== "number" || numPoints <= 0) {
    throw new Error("numPoints must be a positive integer.");
  }

  const interpolatedPoints: SplinePoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const t = i / (numPoints - 1);
    const segment = spline.find((seg: SplineSegment) => {
      return seg.data.startPercentage <= t && seg.data.endPercentage >= t;
    });
    if (segment) {
      const startPercentage = segment.data.startPercentage;
      const endPercentage = segment.data.endPercentage;
      const segmentT = (t - startPercentage) / (endPercentage - startPercentage);
      const x = segment.x0 + segmentT * (segment.x1 - segment.x0);
      const y = segment.y0 + segmentT * (segment.y1 - segment.y0);

      interpolatedPoints.push({
        x,
        y,
        nextDataPoint: segment.data.nextDataPoint,
        lastDataPoint: segment.data.lastDataPoint,
        startPercentage,
        endPercentage,
        splineMidPoint: segment.data.splineMidPoint,
      });
    } else {
      throw new Error(`No segment found for t=${t}`);
    }
  }

  if (numPoints > 1) {
    const lastSegment = spline[spline.length - 1];
    interpolatedPoints[numPoints - 1] = {
      x: lastSegment.x1,
      y: lastSegment.y1,
      nextDataPoint: lastSegment.data.nextDataPoint,
      lastDataPoint: lastSegment.data.lastDataPoint,
      startPercentage: lastSegment.data.startPercentage,
      endPercentage: lastSegment.data.endPercentage,
      splineMidPoint: lastSegment.data.splineMidPoint,
    };
  }

  return interpolatedPoints;
}

/**
 * Merges multiple splines by interpolating each to the same number of points,
 * then averaging the x, y, etc. at each index.
 *
 * @param splinesArray - An array of spline arrays (each a SplineSegment[]).
 * @returns An array of merged spline segments.
 */
export function mergeSplines(
  splinesArray: SplineSegment[][]
): MergedSplineSegment[] {
  if (!splinesArray.length) return [];

  const numPoints = Math.max(...splinesArray.map((spl) => spl.length)) + 1;
  const interpolated = splinesArray.map((spl) => interpolateSpline(spl, numPoints));

  const averageSpline: SplinePoint[] = [];
  for (let i = 0; i < numPoints; i++) {
    const validPoints = interpolated.filter((s) => i < s.length).map((s) => s[i]);
    const avgX = d3.mean(validPoints, (p: SplinePoint) => p.x) as number;
    const avgY = d3.mean(validPoints, (p: SplinePoint) => p.y) as number;
    const avgMidX = d3.mean(validPoints, (p: SplinePoint) => p.splineMidPoint?.x ?? 0) ?? 0;
    const avgMidY = d3.mean(validPoints, (p: SplinePoint) => p.splineMidPoint?.y ?? 0) ?? 0;
    const avgStartPercent = d3.mean(validPoints, (p: SplinePoint) => p.startPercentage) as number;
    const avgEndPercent = d3.mean(validPoints, (p: SplinePoint) => p.endPercentage) as number;

    const nextDataPoint = validPoints[0]?.nextDataPoint ?? null;
    const lastDataPoint = validPoints[0]?.lastDataPoint ?? null;

    averageSpline.push({
      x: avgX,
      y: avgY,
      nextDataPoint,
      lastDataPoint,
      startPercentage: avgStartPercent,
      endPercentage: avgEndPercent,
      splineMidPoint: { x: avgMidX, y: avgMidY },
    });
  }

  const mergedSpline: MergedSplineSegment[] = [];
  for (let i = 0; i < numPoints - 1; i++) {
    mergedSpline.push({
      minX: Math.min(averageSpline[i].x, averageSpline[i + 1].x),
      minY: Math.min(averageSpline[i].y, averageSpline[i + 1].y),
      maxX: Math.max(averageSpline[i].x, averageSpline[i + 1].x),
      maxY: Math.max(averageSpline[i].y, averageSpline[i + 1].y),
      data: {
        x0: averageSpline[i].x,
        y0: averageSpline[i].y,
        x1: averageSpline[i + 1].x,
        y1: averageSpline[i + 1].y,
        data: {
          nextDataPoint: averageSpline.map((p) => p.nextDataPoint),
          lastDataPoint: averageSpline.map((p) => p.lastDataPoint),
          startPercentage: averageSpline[i].startPercentage,
          endPercentage: averageSpline[i].endPercentage,
          // Convert splineMidPoint to non-null values by defaulting to 0 if necessary.
          splineMidPoint: {
            x: averageSpline[i].splineMidPoint.x ?? 0,
            y: averageSpline[i].splineMidPoint.y ?? 0,
          },
          numberSplines: splinesArray.length,
        },
      },
    });
  }
  return mergedSpline;
}
