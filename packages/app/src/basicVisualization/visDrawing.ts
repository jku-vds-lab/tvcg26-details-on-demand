import * as d3 from "d3";
import { SVGSelection } from "src/types/visTypes";
import type { DataPoint, SplineSegment } from "../dataPreprocessing/dataPreprocessing";
import { drawAll } from "./drawNodesAndEdges";

/**
 * Draws the interactive canvas using the unified drawAll function.
 * The effectiveScale parameter is used to compute visual sizes (node radius, line width)
 * in a quantized (LOD) manner while positions are computed using the actual transform.
 */
export function draw(
  context: CanvasRenderingContext2D,
  _svg: SVGSelection,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  transform: d3.ZoomTransform,
  fadedPoints: DataPoint[],
  points: DataPoint[],
  lineSegments: SplineSegment[],
  _colorScale: (key: string | number) => string,
  effectiveScale: number
) {
  const combinedPoints = [...points, ...fadedPoints];

  drawAll(
    context,
    context.canvas.width,
    context.canvas.height,
    combinedPoints,
    lineSegments,
    xScale,
    yScale,
    {
      mode: "interactive",
      transform,       // use actual transform for positioning
      effectiveScale,  // quantized scale for computing sizes
    }
  );
}
