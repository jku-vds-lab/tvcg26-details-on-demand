// packages/app/src/dataPreprocessing/splineGeometry.ts
//
// In-app port of build_splines_and_midpoints from
// public/data/preprocess_dataset_generate_knng.py: Catmull-Rom spline
// segments (index-based PrecomputedSegment), one trajectory midpoint per
// edge, and the per-start-point nextEdgeCenter. Producing the precomputed
// shapes routes simple-format datasets through the same columnar geometry
// path as the bespoke JSON (columnsFromPrecomputedSegments /
// attachSegmentPointState in splineColumns.ts).

import type {
  PrecomputedSegment,
  PrecomputedTrajectoryMidpoint,
} from "../types/datasetTypes";
import { catmullRomPoint } from "./catmullRom";
import { SAMPLES_PER_EDGE } from "./splineColumns";

export interface SplineGeometryPoint {
  x: number;
  y: number;
  line: number;
  action?: string;
}

export interface SplineGeometryResult {
  segments: PrecomputedSegment[];
  trajectoryMidpoints: PrecomputedTrajectoryMidpoint[];
  /** startIndex → spline halfway point, for DataPoint.nextEdgeCenter. */
  nextEdgeCenter: Map<number, { x: number; y: number }>;
}

/**
 * Compute spline geometry for points ordered by trajectory. Points are
 * grouped by their `line` value (input order preserved within a line);
 * segment indices refer to positions in the input array.
 */
export function computeSplineGeometry(
  points: readonly SplineGeometryPoint[],
  samplesPerEdge = SAMPLES_PER_EDGE
): SplineGeometryResult {
  const segments: PrecomputedSegment[] = [];
  const trajectoryMidpoints: PrecomputedTrajectoryMidpoint[] = [];
  const nextEdgeCenter = new Map<number, { x: number; y: number }>();

  // Group global indices by line, preserving input order.
  const lines = new Map<number, number[]>();
  for (let i = 0; i < points.length; i++) {
    const line = points[i].line;
    let idxs = lines.get(line);
    if (!idxs) {
      idxs = [];
      lines.set(line, idxs);
    }
    idxs.push(i);
  }

  lines.forEach((idxs) => {
    const n = idxs.length;
    if (n <= 1) return;

    for (let i = 0; i < n - 1; i++) {
      const at = (j: number): number[] => {
        const p = points[idxs[j]];
        return [p.x, p.y];
      };
      const p1 = at(i);
      const p2 = at(i + 1);
      const p0 = i > 0 ? at(i - 1) : p1;
      const p3 = i + 2 < n ? at(i + 2) : p2;

      const startIndex = idxs[i];
      const endIndex = idxs[i + 1];
      const action = points[startIndex].action;

      const curve: number[][] = [];
      for (let s = 0; s <= samplesPerEdge; s++) {
        curve.push(catmullRomPoint(s / samplesPerEdge, p0, p1, p2, p3));
      }

      for (let s = 0; s < samplesPerEdge; s++) {
        const [x0, y0] = curve[s];
        const [x1, y1] = curve[s + 1];
        const startPercentage = s / samplesPerEdge;
        const endPercentage = (s + 1) / samplesPerEdge;
        const midX = (x0 + x1) * 0.5;
        const midY = (y0 + y1) * 0.5;

        segments.push({
          x0,
          y0,
          x1,
          y1,
          startIndex,
          endIndex,
          startPercentage,
          endPercentage,
          splineMidPoint: { x: midX, y: midY },
          isArrowSegment: s === samplesPerEdge - 1,
          doi: 0,
          action,
        });

        // First segment straddling the halfway mark wins (matches the
        // offline script and the manifest hydration path).
        if (
          startPercentage <= 0.5 &&
          endPercentage >= 0.5 &&
          !nextEdgeCenter.has(startIndex)
        ) {
          nextEdgeCenter.set(startIndex, { x: midX, y: midY });
        }
      }

      const center = nextEdgeCenter.get(startIndex) ?? {
        x: (p1[0] + p2[0]) * 0.5,
        y: (p1[1] + p2[1]) * 0.5,
      };
      if (!nextEdgeCenter.has(startIndex)) nextEdgeCenter.set(startIndex, center);

      trajectoryMidpoints.push({
        midPoint: { x: center.x, y: center.y },
        startIndex,
        endIndex,
        action,
      });
    }
  });

  return { segments, trajectoryMidpoints, nextEdgeCenter };
}
