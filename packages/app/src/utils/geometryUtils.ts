import * as d3 from "d3";
import { VisualElement } from "src/models/VisualElement";
import type { Pos } from "src/layout/layoutStore";

// src/utils/geometryUtils.ts
export function closestPointOnPolygon(
  polygon: [number,number][],
  point: [number,number]
): [number,number] {
  let best: [number,number] = polygon[0];
  let bestDistSq = Infinity;

  for (let i = 0; i < polygon.length; ++i) {
    const a = polygon[i];
    const b = polygon[(i+1) % polygon.length];
    // project point onto segment ab
    const [x, y] = projectPointOnSegment(a, b, point);
    const d2 = (x-point[0])**2 + (y-point[1])**2;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      best = [x,y];
    }
  }
  return best;
}

function projectPointOnSegment(
  A: [number,number],
  B: [number,number],
  P: [number,number]
): [number,number] {
  const [ax,ay] = A, [bx,by] = B, [px,py] = P;
  const vx = bx - ax, vy = by - ay;
  const t = ((px-ax)*vx + (py-ay)*vy) / (vx*vx + vy*vy);
  const u = Math.max(0, Math.min(1, t));
  return [ax + u*vx, ay + u*vy];
}
// -----------------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------------
export function boxOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number; },
  b: { minX: number; minY: number; maxX: number; maxY: number; }): number {
  const w = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const h = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return w * h;
}
function linesIntersect(
  l1: { x1: number; y1: number; x2: number; y2: number; },
  l2: { x1: number; y1: number; x2: number; y2: number; }
): boolean {
  const diff = (x1: number, y1: number, x2: number, y2: number) => ({
    x: x2 - x1,
    y: y2 - y1,
  });
  const r = diff(l1.x1, l1.y1, l1.x2, l1.y2);
  const s = diff(l2.x1, l2.y1, l2.x2, l2.y2);
  const cross = (u: { x: number; y: number; }, v: { x: number; y: number; }) => u.x * v.y - u.y * v.x;
  const rxs = cross(r, s);
  if (rxs === 0) return false; // parallel or collinear
  const qp = { x: l2.x1 - l1.x1, y: l2.y1 - l1.y1 };
  const t = cross(qp, s) / rxs;
  const u = cross(qp, r) / rxs;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
/**
 * Returns the point on the border of an axis-aligned rect that lies on the ray
 * from `from` (the rect's own centre) outward toward `toward`.
 *
 * `rect` uses the screen-space top-left origin convention returned by
 * `VisualElement.getScreenBoundingBoxFor`: { x, y, width, height }.
 */
export function segmentRectBorderPoint(
  from: [number, number],
  rect: { x: number; y: number; width: number; height: number },
  toward: [number, number]
): [number, number] {
  const [fx, fy] = from;
  const [tx, ty] = toward;
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return from;

  const left   = rect.x;
  const right  = rect.x + rect.width;
  const top    = rect.y;
  const bottom = rect.y + rect.height;

  // Collect all positive t values where the ray from+t*(dx,dy) hits an edge.
  const ts: number[] = [];
  if (Math.abs(dx) > 1e-9) {
    ts.push((left   - fx) / dx);
    ts.push((right  - fx) / dx);
  }
  if (Math.abs(dy) > 1e-9) {
    ts.push((top    - fy) / dy);
    ts.push((bottom - fy) / dy);
  }

  const t = Math.min(...ts.filter((c) => c > 1e-9));
  if (!isFinite(t)) return from;
  return [fx + t * dx, fy + t * dy];
}

export function leadersIntersect(
  a: VisualElement,
  b: VisualElement,
  positions: Map<string, Pos>,
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>): boolean {
  const pa = positions.get(a.id) ?? a.sourcePosition;
  const pb = positions.get(b.id) ?? b.sourcePosition;
  return linesIntersect(
    {
      x1: x(a.sourcePosition.x),
      y1: y(a.sourcePosition.y),
      x2: x(pa.x),
      y2: y(pa.y),
    },
    {
      x1: x(b.sourcePosition.x),
      y1: y(b.sourcePosition.y),
      x2: x(pb.x),
      y2: y(pb.y),
    }
  );
}
