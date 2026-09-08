import {
  ClipperOffset,
  EndType,
  IntPoint,
  JoinType,
} from 'clipper-lib';
import * as d3 from 'd3';
import { groupMemberIndexAt, groupMemberXY } from 'src/clustering/groupMembers';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import store, { RootState } from 'src/store';

/**
 * The computeHull member scan for index-backed groups (issue #315 R1c):
 * identical Akl–Toussaint prefilter + hull, reading the x/y columns at the
 * member indices — the group array's slots are holes by design.
 */
function computeHullFromColumns(
  xy: NonNullable<ReturnType<typeof groupMemberXY>>
): [number, number][] | null {
  const { spec, count, xs, ys } = xy;
  if (count < 2) {
    if (count !== 1) return null;
    const i = groupMemberIndexAt(spec, 0);
    return [[xs[i], ys[i]]];
  }
  if (count === 2) {
    const a = groupMemberIndexAt(spec, 0);
    const b = groupMemberIndexAt(spec, 1);
    return [
      [xs[a], ys[a]],
      [xs[b], ys[b]],
    ];
  }
  const coords: [number, number][] = [];
  if (count > 512) {
    let pSum = groupMemberIndexAt(spec, 0);
    let pDiff = pSum, nSum = pSum, nDiff = pSum;
    for (let k = 1; k < count; k++) {
      const i = groupMemberIndexAt(spec, k);
      if (xs[i] + ys[i] > xs[pSum] + ys[pSum]) pSum = i;
      if (xs[i] + ys[i] < xs[nSum] + ys[nSum]) nSum = i;
      if (xs[i] - ys[i] > xs[pDiff] - ys[pDiff]) pDiff = i;
      if (xs[i] - ys[i] < xs[nDiff] - ys[nDiff]) nDiff = i;
    }
    const qx = [xs[nSum], xs[pDiff], xs[pSum], xs[nDiff]];
    const qy = [ys[nSum], ys[pDiff], ys[pSum], ys[nDiff]];
    for (let k = 0; k < count; k++) {
      const i = groupMemberIndexAt(spec, k);
      const px = xs[i];
      const py = ys[i];
      let strictlyInside = true;
      for (let e = 0; e < 4; e++) {
        const f = (e + 1) & 3;
        const cross = (qx[f] - qx[e]) * (py - qy[e]) - (qy[f] - qy[e]) * (px - qx[e]);
        if (cross <= 0) {
          strictlyInside = false;
          break;
        }
      }
      if (!strictlyInside) coords.push([px, py]);
    }
  } else {
    for (let k = 0; k < count; k++) {
      const i = groupMemberIndexAt(spec, k);
      coords.push([xs[i], ys[i]]);
    }
  }
  return coords.length >= 3 ? d3.polygonHull(coords)! : coords;
}

export class ClusterConvexHull {
  public readonly id: string;
  public samples: DataPoint[];
  public hullPoints: [number, number][] | null = null;
  public group: string;
  public currentCssScale: number = 1;

  constructor(id: string, samples: DataPoint[], precomputedHull?: [number, number][]) {
    this.id = id;
    this.samples = samples;
    // Uniform revision-0 boot (issue #315 A3 P-a): server-cut datasets never
    // write per-node doiGroup — the unwritten ladder classifies as "inset",
    // exactly what the deleted boot marking stamped.
    this.group = samples[0]?.doiGroup ?? "inset";
    // Server-computed contour (issue #315 D1): skip the member scan.
    if (precomputedHull && precomputedHull.length > 0) {
      this.hullPoints = precomputedHull;
    } else {
      this.computeHull();
    }
  }

  private get paddingFactor(): number {
    return (store.getState() as RootState).clusterSettings.hullPaddingFactor;
  }

  private get hullSplineAlpha(): number {
    return (store.getState() as RootState).clusterSettings.hullSplineAlpha;
  } 

  private get paddingPx(): number {
    return (store.getState() as RootState).clusterSettings.hullPaddingPx;
  }

  public setCssScale(invk: number) {
    this.currentCssScale = invk;
  }

  public updateSamples(samples: DataPoint[], precomputedHull?: [number, number][]) {
    this.samples = samples;
    // Unwritten ladder = "inset" (see constructor).
    this.group = samples[0]?.doiGroup ?? "inset";
    if (precomputedHull && precomputedHull.length > 0) {
      this.hullPoints = precomputedHull;
    } else {
      this.computeHull();
    }
  }

  private computeHull() {
    // 1 point keeps its single coord (rendered as a padded circle, see
    // computeCircleForSinglePoint) so singleton clusters — rescuable since
    // issue #258 phase C — still get a contour outline and obstacle.
    const samples = this.samples;
    // Index-backed groups (issue #315 R1c) hold no rows — same scan over
    // the x/y columns instead.
    const xy = groupMemberXY(samples);
    if (xy) {
      this.hullPoints = computeHullFromColumns(xy);
      return;
    }
    if (samples.length < 2) {
      this.hullPoints = samples.length === 1 ? [[samples[0].x, samples[0].y]] : null;
      return;
    }
    if (samples.length === 2) {
      this.hullPoints = samples.map((p) => [p.x, p.y] as [number, number]);
      return;
    }
    // Akl–Toussaint prefilter for large clusters (1M scale, issue #315):
    // points strictly inside the quadrilateral of the four x±y extremes can
    // never be hull vertices, so drop them in one O(n) pass before the
    // O(k log k) hull. Exact — boundary points are kept — and allocation-free
    // for the discarded majority.
    const coords: [number, number][] = [];
    if (samples.length > 512) {
      let pSum = samples[0], pDiff = samples[0], nSum = samples[0], nDiff = samples[0];
      for (let i = 1; i < samples.length; i++) {
        const p = samples[i];
        if (p.x + p.y > pSum.x + pSum.y) pSum = p;
        if (p.x + p.y < nSum.x + nSum.y) nSum = p;
        if (p.x - p.y > pDiff.x - pDiff.y) pDiff = p;
        if (p.x - p.y < nDiff.x - nDiff.y) nDiff = p;
      }
      // Quad corners in order (may be degenerate — the strict inside test is
      // simply never true then, and all points fall through to the hull).
      const qx = [nSum.x, pDiff.x, pSum.x, nDiff.x];
      const qy = [nSum.y, pDiff.y, pSum.y, nDiff.y];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        let strictlyInside = true;
        for (let e = 0; e < 4; e++) {
          const f = (e + 1) & 3;
          const cross = (qx[f] - qx[e]) * (p.y - qy[e]) - (qy[f] - qy[e]) * (p.x - qx[e]);
          if (cross <= 0) {
            strictlyInside = false;
            break;
          }
        }
        if (!strictlyInside) coords.push([p.x, p.y]);
      }
    } else {
      for (let i = 0; i < samples.length; i++) coords.push([samples[i].x, samples[i].y]);
    }
    this.hullPoints = coords.length >= 3 ? d3.polygonHull(coords)! : coords;
  }

  /**
   * cssScale can be passed explicitly by render-time callers: a hull created
   * by reconcileClusterItems is born with the default currentCssScale (1) and
   * the corrective setCssScale effect only runs after the commit that already
   * baked the hull path, leaving the padding k× oversized until the next
   * zoom/pan re-render (issue #265). Callers that know the live 1/k must pass
   * it; the field default keeps legacy callers unchanged.
   */
  public getScreenHull(
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    cssScale: number = this.currentCssScale
  ): [number, number][] {
    if (!this.hullPoints) {
      return [];
    }

    const pts = this.hullPoints.map(
      ([x, y]) => [xScale(x), yScale(y)] as [number, number]
    );

    if (pts.length === 1) {
      return this.computeCircleForSinglePoint(pts[0], cssScale);
    } else if (pts.length === 2) {
      return this.computeRoundedBoxForTwoPoints(pts, cssScale);
    } else if (this.paddingPx > 0 || this.paddingFactor > 0) {
      return this.bufferHullWithClipper(pts, cssScale);
    }

    return pts;
  }

  private bufferHullWithClipper(
    points: [number, number][],
    cssScale: number
  ): [number, number][] {
    // convert to Clipper IntPoints
    const path: IntPoint[] = points.map(([x, y]) => ({ X: x, Y: y }));

    // set up the offsetter with default miter/round settings
    const co = new ClipperOffset();

    // add the polygon path, request rounded joins
    co.AddPath(path, JoinType.jtRound, EndType.etClosedPolygon);

    // compute centroid
    const centroid = points.reduce(
      (acc, [x, y]) => [acc[0] + x, acc[1] + y] as [number, number],
      [0, 0]
    );
    centroid[0] /= points.length;
    centroid[1] /= points.length;

    // average distance from centroid
    const meanRadius =
      points
        .map(([x, y]) => Math.hypot(x - centroid[0], y - centroid[1]))
        .reduce((sum, d) => sum + d, 0) / points.length;

    // total offset = fixed px (scaled to screen space) + factor × meanRadius
    const scaledPx = this.paddingPx * cssScale;
    const totalDelta = scaledPx + this.paddingFactor * meanRadius;

    // execute offset
    const solution: IntPoint[][] = [];
    co.Execute(solution, totalDelta);

    // guard when buffering: fallback to original polygon if Clipper returns empty
    const bufferedPath = solution.find((path) => path.length > 0);
    if (!bufferedPath) {
      return points;
    }

    // convert back to [number, number]
    return bufferedPath.map((pt) => [pt.X, pt.Y]);
  }

  /**
   * Degenerate hull for a 1-point cluster: a 12-gon "circle" of radius
   * `paddingPx × cssScale` around the point — the singleton analog of the
   * two-point rounded box (and its L === 0 square), reusing the same
   * screen-space padding so the ring matches other small-cluster contours.
   */
  private computeCircleForSinglePoint(
    [cx, cy]: [number, number],
    cssScale: number
  ): [number, number][] {
    const r = this.paddingPx * cssScale;
    const SEGMENTS = 12;
    const circle: [number, number][] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (2 * Math.PI * i) / SEGMENTS;
      circle.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return circle;
  }

  private computeRoundedBoxForTwoPoints(
    points: [number, number][],
    cssScale: number
  ): [number, number][] {
    const [[x1, y1], [x2, y2]] = points;
    const mid: [number, number] = [(x1 + x2) / 2, (y1 + y2) / 2];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const L = Math.hypot(dx, dy);

    const pf = this.paddingFactor;
    const px = this.paddingPx * cssScale;

    if (L === 0) {
      return [
        [x1 - px, y1 - px],
        [x1 + px, y1 - px],
        [x1 + px, y1 + px],
        [x1 - px, y1 + px],
      ];
    }

    const ux = dx / L;
    const uy = dy / L;
    const dInflated = (L / 2) * (1 + pf) + px;
    const p1: [number, number] = [mid[0] + dInflated * ux, mid[1] + dInflated * uy];
    const p2: [number, number] = [mid[0] - dInflated * ux, mid[1] - dInflated * uy];

    const padPerp = px / 2;
    const perpX = -uy;
    const perpY = ux;

    const c1: [number, number] = [p1[0] - padPerp * perpX, p1[1] - padPerp * perpY];
    const c2: [number, number] = [p1[0] + padPerp * perpX, p1[1] + padPerp * perpY];
    const c3: [number, number] = [p2[0] + padPerp * perpX, p2[1] + padPerp * perpY];
    const c4: [number, number] = [p2[0] - padPerp * perpX, p2[1] - padPerp * perpY];

    return [c1, c2, c3, c4];
  }

  public renderConvexHullDiv(
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    canvasWidth: number,
    canvasHeight: number
  ): JSX.Element | null {
    if (!this.hullPoints) {
      return null;
    }

    const {
      contourThickness,
      contourGray,
      contourStippling,
      contourOutlineThickness,
    } = (store.getState() as RootState).clusterSettings;

    const strokeGray = Math.round(contourGray * 255);
    const strokeColor = `rgb(${strokeGray},${strokeGray},${strokeGray})`;
    const dashArray =
      contourStippling > 0
        ? `${contourStippling * this.currentCssScale},${contourStippling * this.currentCssScale}`
        : undefined;

    let screenCoords = this.hullPoints.map(
      ([x, y]) => [xScale(x), yScale(y)] as [number, number]
    );

    if (screenCoords.length === 1) {
      screenCoords = this.computeCircleForSinglePoint(screenCoords[0], this.currentCssScale);
    } else if (screenCoords.length === 2) {
      screenCoords = this.computeRoundedBoxForTwoPoints(screenCoords, this.currentCssScale);
    } else if (this.paddingPx > 0 || this.paddingFactor > 0) {
      screenCoords = this.bufferHullWithClipper(screenCoords, this.currentCssScale);
    }

    const lineGenerator = d3
      .line<[number, number]>()
      .curve(d3.curveCatmullRomClosed.alpha(this.hullSplineAlpha))
      .x((d) => d[0])
      .y((d) => d[1]);

    const path = lineGenerator(screenCoords)!;

    return (
      <svg
        width={canvasWidth}
        height={canvasHeight}
        overflow="visible"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        <path
          d={path}
          fill="none"
          stroke="white"
          strokeWidth={contourOutlineThickness * this.currentCssScale}
        />
        <path
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={contourThickness * this.currentCssScale}
          strokeDasharray={dashArray}
        />
      </svg>
    );
  }
}
