// src/annealing/InsetOptimization.ts
import * as d3 from "d3";
import type { NodeSearchIndex } from "src/dataPreprocessing/nodeIndex";
import type { Pos } from "src/layout/layoutStore";
import { boxOverlap, leadersIntersect } from "src/utils/geometryUtils";
import { VisualElement } from "../models/VisualElement";
import {
    AnnealingDiagnostics,
    AnnealingOptions,
    simulatedAnnealing,
} from "./simulatedAnnealing";

export interface OptimizationRunResult {
  patch: Map<string, Pos>;
  diagnostics: AnnealingDiagnostics;
}

export interface Obstacle {
  x: number; y: number; width: number; height: number; // screen-space
}

/**
 * The minimal spatial surface the cost function needs from segment geometry:
 * hits-in-box counting. Satisfied structurally both by the columnar
 * EdgeSegmentIndex views (issue #315 phase B1) and by any rbush (tests).
 */
export interface EdgeSearchIndex {
  search(box: { minX: number; minY: number; maxX: number; maxY: number }): unknown[];
  /** Optional O(1)-ish hit count (issue #315 A2): indexes that can answer
   * "how many items under this bbox" without materializing them (the
   * frontier density substitute on server-cut datasets) provide this; the
   * annealer prefers it over search().length. */
  countIn?(box: { minX: number; minY: number; maxX: number; maxY: number }): number;
}

export interface ContourObstacle {
  clusterUid: string;
  points: Array<[number, number]>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A floating diff inset whose position is derived (at runtime) from the midpoint
 * of two node insets.  Passing these alongside the annealing `state` lets the cost
 * function penalise derived-box overlaps without making diff insets movable.
 */
export interface DerivedInset {
  /** The diff-inset VisualElement (used for its bounding-box renderer). */
  element: VisualElement;
  /** The `VisualElement.id` of node inset A. */
  nodeIdA: string;
  /** The `VisualElement.id` of node inset B. */
  nodeIdB: string;
}

type Box2 = { x: number; y: number; width: number; height: number };

/**
 * Given the already-hover-enlarged diff bounding box and the screen positions and
 * bounding boxes of its two parent node insets, returns the data-space position
 * deltas that push the two parents symmetrically apart along the A→B axis by the
 * minimum amount needed to clear the diff.
 *
 * Returns `null` when neither parent box overlaps the diff (no movement needed).
 *
 * The A→B symmetry keeps the midpoint (= diff anchor) invariant, so the diff does
 * not drift toward one side.  Both parents are always moved by the same delta so
 * that the midpoint is preserved.
 */
export function computeDiffHoverNudge(args: {
  /** Diff bounding box in screen pixels, already inflated by the hover scale. */
  diffBox: Box2;
  /** Node-inset A screen bounding box. */
  boxA: Box2;
  /** Node-inset B screen bounding box. */
  boxB: Box2;
  /** xScale(pA.x) — screen X of node A's data center. */
  screenAX: number;
  /** yScale(pA.y) — screen Y of node A's data center. */
  screenAY: number;
  /** xScale(pB.x) */
  screenBX: number;
  /** yScale(pB.y) */
  screenBY: number;
  /** xScale slope: xScale(1) - xScale(0).  Used to convert screen→data. */
  pxPerDataX: number;
  /** yScale slope: yScale(1) - yScale(0). */
  pxPerDataY: number;
}): { dA: { x: number; y: number }; dB: { x: number; y: number } } | null {
  const { diffBox, boxA, boxB, screenAX, screenAY, screenBX, screenBY, pxPerDataX, pxPerDataY } = args;

  // Quick 2-D AABB reject: no overlap with either parent → nothing to do.
  function overlaps2d(a: Box2, b: Box2) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }
  const olvA = overlaps2d(diffBox, boxA);
  const olvB = overlaps2d(diffBox, boxB);
  if (!olvA && !olvB) return null;

  // A→B unit vector in screen space.
  const dx = screenBX - screenAX;
  const dy = screenBY - screenAY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null; // coincident parents — degenerate

  const ux = dx / dist;
  const uy = dy / dist;

  // Project a box's half-extent onto the u axis.
  function halfExtent(b: Box2) {
    return Math.abs(ux) * b.width / 2 + Math.abs(uy) * b.height / 2;
  }

  // The diff center is at the midpoint of A and B screen centers (linear scale).
  // Therefore the projection of A→diffCenter onto u equals dist/2.
  const halfABDist = dist / 2;
  const heD = halfExtent(diffBox);

  // Penetration along u for each overlapping parent (0 if box doesn't overlap u-axis).
  const penA = olvA ? Math.max(0, heD + halfExtent(boxA) - halfABDist) : 0;
  const penB = olvB ? Math.max(0, heD + halfExtent(boxB) - halfABDist) : 0;

  const delta = Math.max(penA, penB);
  if (delta <= 0) return null; // overlap is perpendicular to A→B; u-axis nudge won't help

  // A moves in -u direction, B moves in +u direction (both by delta to keep midpoint fixed).
  return {
    dA: { x: -ux * delta / pxPerDataX, y: -uy * delta / pxPerDataY },
    dB: { x:  ux * delta / pxPerDataX, y:  uy * delta / pxPerDataY },
  };
}

// quick overlap in screen-space
function overlapArea(a:{minX:number;minY:number;maxX:number;maxY:number}, b:{minX:number;minY:number;maxX:number;maxY:number}) {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return ix * iy;
}

function parseClusterUid(id: string): string {
  const match = id.match(/^[^-]+-[^-]+-(.+)$/);
  const uid = match ? match[1] : id;
  const suffixIdx = uid.indexOf("::");
  return suffixIdx >= 0 ? uid.slice(0, suffixIdx) : uid;
}

function pointInRect(px: number, py: number, r: { minX: number; minY: number; maxX: number; maxY: number }) {
  return px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
  if (Math.abs(o1) < 1e-9 && onSegment(a1, a2, b1)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a1, a2, b2)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(b1, b2, a1)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(b1, b2, a2)) return true;
  return false;
}

function polygonIntersectsRect(
  polygon: Array<[number, number]>,
  rect: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  if (!polygon.length) return false;

  for (const [x, y] of polygon) {
    if (pointInRect(x, y, rect)) return true;
  }

  const rectPts: Array<[number, number]> = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];

  for (const p of rectPts) {
    if (pointInPolygon(p, polygon)) return true;
  }

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    for (let j = 0; j < rectPts.length; j++) {
      const c = rectPts[j];
      const d = rectPts[(j + 1) % rectPts.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }

  return false;
}

function pointToSegmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-12) return Math.hypot(apx, apy);
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / ab2));
  const qx = a[0] + t * abx;
  const qy = a[1] + t * aby;
  return Math.hypot(p[0] - qx, p[1] - qy);
}

function signedDistanceToPolygonBoundary(
  point: [number, number],
  polygon: Array<[number, number]>
): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    minDist = Math.min(minDist, pointToSegmentDistance(point, a, b));
  }
  return pointInPolygon(point, polygon) ? -minDist : minDist;
}

export interface OptimizationWeights {
  wD: number;
  wM: number;
  wL: number;
  wOS: number;
  wDS: number;
  wOI: number;
  wDI: number;
  wRTree: number;
  hardInsetOverlapPenalty: number;
  hardLeaderCrossingPenalty: number;
  hardScatterOverlapPenalty: number;
  hardForeignContourOverlapPenalty: number;
  contourTargetRadiusMultiplier: number;
}

export interface Viewbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AnnealingSettings {
  maxIterations: number;
  coolingRate: number;
  jitterStrength: number;
  /** Optional wall-clock cap per run — see AnnealingOptions.budgetMs. */
  frameBudgetMs?: number;
}

const rtreeDensityCache = new Map<string, number>();
function densityKey(
  elId: string,
  db: { minX: number; minY: number; maxX: number; maxY: number },
  quant = 4
) {
  const q = (v: number) => Math.round(v / quant);
  return `${elId}:${q(db.minX)},${q(db.minY)},${q(db.maxX)},${q(db.maxY)}`;
}

/** Inflate screen-space bbox by a margin, then convert to data-space. */
function inflateBbox(
  screen: { x: number; y: number; width: number; height: number },
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>,
  margin = 0.2
): { minX: number; minY: number; maxX: number; maxY: number } {
  const tl = { x: x.invert(screen.x), y: y.invert(screen.y + screen.height) };
  const br = { x: x.invert(screen.x + screen.width), y: y.invert(screen.y) };
  const minX = Math.min(tl.x, br.x);
  const maxX = Math.max(tl.x, br.x);
  const minY = Math.min(tl.y, br.y);
  const maxY = Math.max(tl.y, br.y);

  const dx = ((maxX - minX) * margin) / 2;
  const dy = ((maxY - minY) * margin) / 2;

  return {
    minX: minX - dx,
    minY: minY - dy,
    maxX: maxX + dx,
    maxY: maxY + dy,
  };
}

export function computeVisualElementsCost(
  state: VisualElement[],
  positions: Map<string, Pos>,
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>,
  w: OptimizationWeights,
  nodeTree: NodeSearchIndex,
  edgeTree: EdgeSearchIndex,
  obstacles?: Obstacle[],
  contours?: ContourObstacle[],
  derivedInsets?: DerivedInset[]
): number {
  const hardInsetOverlapPenalty = w.hardInsetOverlapPenalty;
  const hardLeaderCrossingPenalty = w.hardLeaderCrossingPenalty;
  const hardScatterOverlapPenalty = w.hardScatterOverlapPenalty;
  const hardForeignContourOverlapPenalty = w.hardForeignContourOverlapPenalty;
  const contourTargetRadiusMultiplier = w.contourTargetRadiusMultiplier;

  let cost = 0;
  let crossings = 0;

  for (let i = 0; i < state.length; ++i) {
    const A = state[i];
    const posA = positions.get(A.id) ?? A.center;
    const sbA = A.getScreenBoundingBoxFor(posA, x, y);
    const boxA = {
      minX: sbA.x,
      minY: sbA.y,
      maxX: sbA.x + sbA.width,
      maxY: sbA.y + sbA.height,
      w: sbA.width,
      h: sbA.height,
    };
    // ── Obstacle penalty (screen-space) ──────────────────────────────────
    if (obstacles && obstacles.length) {
      const oA = { minX: boxA.minX, minY: boxA.minY, maxX: boxA.maxX, maxY: boxA.maxY };
      let oCost = 0;
      for (let k = 0; k < obstacles.length; k++) {
        const ob = obstacles[k];
        const oB = { minX: ob.x, minY: ob.y, maxX: ob.x + ob.width, maxY: ob.y + ob.height };
        const ov = overlapArea(oA, oB);
        if (ov > 0) {
          const denom = Math.min(boxA.w * boxA.h, ob.width * ob.height) || 1;
          const oi = Math.max(0, Math.min(0.999999, ov / denom));
          oCost += -Math.log(1 - oi);
        }
      }
      if (oCost > 0) {
         
        cost += w.wOI * oCost;
      }
    }
    const rA = Math.hypot(boxA.w, boxA.h) / 2;
    const safeR = rA || 1;
    const centerScr = { x: x(posA.x), y: y(posA.y) };
    const sourceScr = { x: x(A.sourcePosition.x), y: y(A.sourcePosition.y) };
    const dcs = Math.hypot(centerScr.x - sourceScr.x, centerScr.y - sourceScr.y);
    const ownClusterUid = parseClusterUid(A.id);
    const ownContour = contours?.find((c) => c.clusterUid === ownClusterUid);
    const signedContourDistance =
      A.samples.length > 1 && ownContour
        ? signedDistanceToPolygonBoundary([centerScr.x, centerScr.y], ownContour.points)
        : undefined;
    const radialDistance = signedContourDistance ?? dcs;
    const contourTarget = contourTargetRadiusMultiplier * safeR;
    const D = A.samples.length > 1
      ? Math.abs(radialDistance - contourTarget) / safeR
      : dcs / safeR;
    const M = A.movement / safeR;
    const shift = {
      x: sourceScr.x - centerScr.x,
      y: sourceScr.y - centerScr.y,
    };
    const srcBox = {
      minX: boxA.minX + shift.x,
      minY: boxA.minY + shift.y,
      maxX: boxA.maxX + shift.x,
      maxY: boxA.maxY + shift.y,
      w: boxA.w,
      h: boxA.h,
    };
    const isSingle = A.samples.length === 1;
    const OS = isSingle ? 0 : boxOverlap(boxA, srcBox) / (srcBox.w * srcBox.h);
    const DS = isSingle
      ? Math.max(0, 2 * safeR - dcs) / safeR
      : Math.max(0, contourTarget - radialDistance) / safeR;
    cost += w.wD * D + w.wM * M + w.wOS * OS + w.wDS * DS;

    if (A.type === "inset" && contours && contours.length && hardForeignContourOverlapPenalty > 0) {
      const rectA = {
        minX: boxA.minX,
        minY: boxA.minY,
        maxX: boxA.maxX,
        maxY: boxA.maxY,
      };
      const centerA: [number, number] = [centerScr.x, centerScr.y];

      for (const contour of contours) {
        if (contour.clusterUid === ownClusterUid) continue;
        if (
          rectA.maxX < contour.minX ||
          rectA.minX > contour.maxX ||
          rectA.maxY < contour.minY ||
          rectA.minY > contour.maxY
        ) {
          continue;
        }

        const insideForeignContour = pointInPolygon(centerA, contour.points);
        if (insideForeignContour) {
          cost += 2 * hardForeignContourOverlapPenalty;
          continue;
        }

        if (polygonIntersectsRect(contour.points, rectA)) {
          cost += hardForeignContourOverlapPenalty;
        }
      }
    }

    for (let j = i + 1; j < state.length; ++j) {
      const B = state[j];
      const posB = positions.get(B.id) ?? B.center;
      const sbB = B.getScreenBoundingBoxFor(posB, x, y);
      const boxB = {
        minX: sbB.x,
        minY: sbB.y,
        maxX: sbB.x + sbB.width,
        maxY: sbB.y + sbB.height,
        w: sbB.width,
        h: sbB.height,
      };
      const rB = Math.hypot(boxB.w, boxB.h) / 2;
      const centerB = { x: x(posB.x), y: y(posB.y) };
      const dx = centerScr.x - centerB.x;
      const dy = centerScr.y - centerB.y;
      if ((dx * dx + dy * dy) > ((rA + rB + 2) * (rA + rB + 2))) {
        continue;
      }
      if (
        A.samples.length > 1 &&
        B.samples.length > 1 &&
        leadersIntersect(A, B, positions, x, y)
      ) {
        crossings += 1;
        cost += hardLeaderCrossingPenalty;
      }

      // --- CHANGE 1: scale-invariant barrier for inset overlap ---
      const areaA = boxA.w * boxA.h;
      const areaB = boxB.w * boxB.h;
      const oiRaw =
        areaA > 0 && areaB > 0
          ? boxOverlap(boxA, boxB) / Math.min(areaA, areaB)
          : 0;
      const oiClamped = Math.max(0, Math.min(0.999999, oiRaw));
      const overlapPenalty = -Math.log(1 - oiClamped);
      // -----------------------------------------------------------

      const DI = Math.max(0, rA + rB - Math.hypot(dx, dy)) / safeR;
      if (oiRaw > 0) {
        // Depth-scaled penalty: base gate + log-barrier factor so reducing overlap is
        // always downhill even when the annealer is cold.
        cost += hardInsetOverlapPenalty * (1 + overlapPenalty);
      }

      cost += w.wOI * overlapPenalty + w.wDI * DI;
    }
  }

  // --- Derived diff-inset overlap penalties ----------------------------------
  // Floating diff insets sit at (nodeA + nodeB) / 2 and are not in `state`, so
  // the node×node loop above never sees them.  We compute each derived box from
  // the candidate positions and penalise it the same way as node-vs-node overlaps,
  // which lets the annealer push node insets apart until no diff box overlaps
  // anything else.
  if (derivedInsets && derivedInsets.length > 0) {
    // Precompute every derived inset's screen box once for this cost evaluation.
    const derivedBoxes: Array<{
      minX: number; minY: number; maxX: number; maxY: number;
      dw: number; dh: number; rD: number; cx: number; cy: number;
    } | null> = derivedInsets.map(({ element: dEl, nodeIdA, nodeIdB }) => {
      const pA = positions.get(nodeIdA);
      const pB = positions.get(nodeIdB);
      if (!pA || !pB) return null; // parent not in candidate map → skip
      const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
      const sbD = dEl.getScreenBoundingBoxFor(mid, x, y);
      const dw = sbD.width;
      const dh = sbD.height;
      return {
        minX: sbD.x, minY: sbD.y,
        maxX: sbD.x + dw, maxY: sbD.y + dh,
        dw, dh,
        rD: Math.hypot(dw, dh) / 2,
        cx: x(mid.x), cy: y(mid.y),
      };
    });

    // diff-vs-node: each derived box against each node inset box.
    for (let i = 0; i < state.length; ++i) {
      const A = state[i];
      const posA = positions.get(A.id) ?? A.center;
      const sbA = A.getScreenBoundingBoxFor(posA, x, y);
      const bA = {
        minX: sbA.x, minY: sbA.y,
        maxX: sbA.x + sbA.width, maxY: sbA.y + sbA.height,
        w: sbA.width, h: sbA.height,
      };
      const rA = Math.hypot(bA.w, bA.h) / 2;
      const cAx = x(posA.x);
      const cAy = y(posA.y);
      for (let d = 0; d < derivedBoxes.length; ++d) {
        const boxD = derivedBoxes[d];
        if (!boxD) continue;
        const ddx = cAx - boxD.cx;
        const ddy = cAy - boxD.cy;
        if ((ddx * ddx + ddy * ddy) > ((rA + boxD.rD + 2) * (rA + boxD.rD + 2))) continue;
        const areaA = bA.w * bA.h;
        const areaD = boxD.dw * boxD.dh;
        const oiRaw =
          areaA > 0 && areaD > 0
            ? boxOverlap(bA, boxD) / Math.min(areaA, areaD)
            : 0;
        const oiClamped = Math.max(0, Math.min(0.999999, oiRaw));
        const overlapPenaltyD = -Math.log(1 - oiClamped);
        cost += w.wOI * overlapPenaltyD;
        if (oiRaw > 0) cost += hardInsetOverlapPenalty * (1 + overlapPenaltyD);
      }
    }

    // diff-vs-diff: pairs of derived inset boxes against each other.
    for (let d1 = 0; d1 < derivedBoxes.length; ++d1) {
      const boxD1 = derivedBoxes[d1];
      if (!boxD1) continue;
      for (let d2 = d1 + 1; d2 < derivedBoxes.length; ++d2) {
        const boxD2 = derivedBoxes[d2];
        if (!boxD2) continue;
        const ddx = boxD1.cx - boxD2.cx;
        const ddy = boxD1.cy - boxD2.cy;
        if ((ddx * ddx + ddy * ddy) > ((boxD1.rD + boxD2.rD + 2) * (boxD1.rD + boxD2.rD + 2))) continue;
        const area1 = boxD1.dw * boxD1.dh;
        const area2 = boxD2.dw * boxD2.dh;
        const oiRaw =
          area1 > 0 && area2 > 0
            ? boxOverlap(boxD1, boxD2) / Math.min(area1, area2)
            : 0;
        const oiClamped = Math.max(0, Math.min(0.999999, oiRaw));
        const overlapPenaltyD = -Math.log(1 - oiClamped);
        cost += w.wOI * overlapPenaltyD;
        if (oiRaw > 0) cost += hardInsetOverlapPenalty * (1 + overlapPenaltyD);
      }
    }
  }
  // ---------------------------------------------------------------------------

  function accumulateRTreeCost(el: VisualElement) {
    const pos = positions.get(el.id) ?? el.center;
    const sb = el.getScreenBoundingBoxFor(pos, x, y);
    const db = inflateBbox(sb, x, y, 0.1);
    const key = densityKey(el.id, db);
    let score = rtreeDensityCache.get(key);
    if (score == null) {
      const nodeHits = nodeTree.countIn ? nodeTree.countIn(db) : nodeTree.search(db).length;
      const edgeHits = edgeTree.countIn ? edgeTree.countIn(db) : edgeTree.search(db).length;
      const hits = nodeHits + edgeHits;
      const area = Math.max(
        1e-12,
        (db.maxX - db.minX) * (db.maxY - db.minY)
      );
      const density = hits / area;
      score = Math.log1p(density);
      rtreeDensityCache.set(key, score);

      if (hits > 0) {
        cost += hardScatterOverlapPenalty;
      }
    }
    cost += w.wRTree * score;
  }

  if (w.wRTree > 0 || hardScatterOverlapPenalty > 0) {
    state.forEach(accumulateRTreeCost);
  }

  return cost + w.wL * crossings;
}

export function generateVisualElementNeighbor(
  state: VisualElement[],
  positions: Map<string, Pos>,
  zoom: number,
  viewbox: Viewbox,
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>,
  jitterStrength: number
): { id: string; old: Pos; next: Pos; el: VisualElement; movement: number } {
  const idx = Math.floor(Math.random() * state.length);
  const sel = state[idx];
  const current = positions.get(sel.id) ?? sel.sourcePosition;

  // early exit for single-sample insets that are unobstructed at their source
  if (sel.samples.length === 1) {
    const sb = sel.getScreenBoundingBoxFor(current, x, y);
    const shift = {
      x: x(sel.sourcePosition.x) - x(current.x),
      y: y(sel.sourcePosition.y) - y(current.y),
    };
    const srcBox = {
      minX: sb.x + shift.x,
      minY: sb.y + shift.y,
      maxX: sb.x + shift.x + sb.width,
      maxY: sb.y + shift.y + sb.height,
    };

    let overlaps = false;
    for (let i = 0; i < state.length; ++i) {
      if (i === idx) continue;
      const other = state[i];
      const posO = positions.get(other.id) ?? other.center;
      const sbO = other.getScreenBoundingBoxFor(posO, x, y);
      const boxO = {
        minX: sbO.x,
        minY: sbO.y,
        maxX: sbO.x + sbO.width,
        maxY: sbO.y + sbO.height,
      };
      if (boxOverlap(srcBox, boxO) > 0) {
        overlaps = true;
        break;
      }
    }

    if (!overlaps) {
      return {
        id: sel.id,
        old: current,
        next: { ...sel.sourcePosition },
        el: sel,
        movement: Math.hypot(sel.sourcePosition.x - current.x, sel.sourcePosition.y - current.y),
      };
    }
  }

  const MAX_JITTER = jitterStrength;
  const initialTemp = Math.max(1e-9, sel.initialTemperature);
  const tempRatio = Math.max(0, Math.min(1, sel.temperature / initialTemp));
  const allowed = (MAX_JITTER * tempRatio) / Math.max(1e-9, zoom);

  // If this element is fully cooled down, keep it fixed.
  if (allowed <= 0) {
    return {
      id: sel.id,
      old: current,
      next: { ...current },
      el: sel,
      movement: 0,
    };
  }

  const originalPosition = { ...current };
  const next = {
    x: current.x + (Math.random() - 0.5) * allowed,
    y: current.y + (Math.random() - 0.5) * allowed,
  };

  const sb = sel.getScreenBoundingBoxFor(next, x, y);
  const left   = x.invert(sb.x);
  const right  = x.invert(sb.x + sb.width);
  const top    = y.invert(sb.y);
  const bottom = y.invert(sb.y + sb.height);

  const HYS = 0.06; // 6% hysteresis vs current viewbox size
  const marginBox = {
    minX: viewbox.minX + (viewbox.maxX - viewbox.minX) * HYS,
    maxX: viewbox.maxX - (viewbox.maxX - viewbox.minX) * HYS,
    minY: viewbox.minY + (viewbox.maxY - viewbox.minY) * HYS,
    maxY: viewbox.maxY - (viewbox.maxY - viewbox.minY) * HYS,
  };
  let final = next;
  if (
    left   < marginBox.minX ||
    right  > marginBox.maxX ||
    top    > marginBox.maxY ||
    bottom < marginBox.minY
  ) {
    const cx = x.invert(sb.x + sb.width  / 2);
    const cy = y.invert(sb.y + sb.height / 2);
    const nx = Math.min(Math.max(cx, marginBox.minX), marginBox.maxX);
    const ny = Math.min(Math.max(cy, marginBox.minY), marginBox.maxY);
    final = { x: nx, y: ny };
  }

  return {
    id: sel.id,
    old: originalPosition,
    next: final,
    el: sel,
    movement: Math.hypot(final.x - originalPosition.x, final.y - originalPosition.y),
  };
}

export function optimizeVisualElementsPositions(
  initialState: VisualElement[],
  positions: Map<string, Pos>,
  zoom: number,
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>,
  w: OptimizationWeights,
  nodeTree: NodeSearchIndex,
  edgeTree: EdgeSearchIndex,
  viewbox: Viewbox,
  annealingSettings: AnnealingSettings,
  obstacles?: Obstacle[],
  contours?: ContourObstacle[],
  derivedInsets?: DerivedInset[]
): OptimizationRunResult {
  const { maxIterations, coolingRate, jitterStrength, frameBudgetMs } = annealingSettings;
  const MIN_TEMPERATURE = 1e-3;

  // Density keys depend on screen/data mapping and active trees, so stale cache
  // entries can inflate costs after dataset/zoom/filter changes.
  rtreeDensityCache.clear();

  initialState.forEach(el => {
    if (el.temperature < MIN_TEMPERATURE) el.temperature = 0;
  });

  function neighborState(pos: Map<string, Pos>) {
    return generateVisualElementNeighbor(
      initialState, pos, zoom, viewbox, x, y, jitterStrength
    );
  }
  function costFn(pos: Map<string, Pos>) {
    return computeVisualElementsCost(initialState, pos, x, y, w, nodeTree, edgeTree, obstacles, contours, derivedInsets);
  }

  const options: AnnealingOptions = {
    elements: initialState,
    initialPositions: positions,
    costFunction: costFn,
    generateNeighbor: neighborState,
    coolingRate,
    minTemperature: MIN_TEMPERATURE,
    maxIterations,
    budgetMs: frameBudgetMs,
  };

  return simulatedAnnealing(options);
}
