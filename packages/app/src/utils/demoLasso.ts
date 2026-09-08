// src/utils/demoLasso.ts
//
// Pure geometry helpers for the deep-link demo choreography's "ghost lasso"
// (see hooks/useDeepLinkDemo.ts): given the SCREEN-space positions of the
// points a `sel=` link targets, split them into spatial regions (a ctrl/
// shift-composed selection can cover several disjoint areas — one lasso is
// drawn per region), build a padded hull path per region, and resample it to
// constant arc-length so the stroke draws at constant speed.
//
// All inputs/outputs are screen-space pixels; the caller projects data-space
// positions first so eps/padding read as visual sizes.

import * as d3 from "d3";

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Splits points into connected components using a grid hash: two points are
 * connected when their eps-sized grid cells are within one cell of each other
 * (8-neighborhood), which bounds their distance by ~2·√2·eps. O(n) — a real
 * DBSCAN is overkill for "how many lassos should the demo draw".
 * Components are returned sorted left-to-right (min x) for stable reading order.
 */
export function splitIntoRegions(points: ScreenPoint[], epsPx: number): ScreenPoint[][] {
  if (points.length === 0) return [];
  const eps = Math.max(1e-6, epsPx);
  const cellKey = (cx: number, cy: number) => `${cx},${cy}`;
  const cells = new Map<string, number[]>();
  points.forEach((p, i) => {
    const key = cellKey(Math.floor(p.x / eps), Math.floor(p.y / eps));
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  });

  // Union-find over point indices, merging all points of neighboring cells.
  const parent = points.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (const [key, bucket] of cells) {
    for (let i = 1; i < bucket.length; i++) union(bucket[0], bucket[i]);
    const [cx, cy] = key.split(",").map(Number);
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = dx === 0 ? 1 : -1; dy <= 1; dy++) {
        const neighbor = cells.get(cellKey(cx + dx, cy + dy));
        if (neighbor) union(bucket[0], neighbor[0]);
      }
    }
  }

  const groups = new Map<number, ScreenPoint[]>();
  points.forEach((p, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(p);
    else groups.set(root, [p]);
  });
  return Array.from(groups.values()).sort(
    (a, b) => Math.min(...a.map((p) => p.x)) - Math.min(...b.map((p) => p.x))
  );
}

/**
 * Closed lasso path around one region: convex hull, padded outward from the
 * centroid by `padPx`. Regions too small/collinear for a hull get a circle
 * around their bounding box instead. The last vertex equals the first.
 */
export function computeGhostLassoPath(region: ScreenPoint[], padPx = 14): ScreenPoint[] {
  if (region.length === 0) return [];
  const hull =
    region.length >= 3 ? d3.polygonHull(region.map((p) => [p.x, p.y] as [number, number])) : null;

  if (!hull) {
    const xs = region.map((p) => p.x);
    const ys = region.map((p) => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r =
      Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + padPx;
    const circle: ScreenPoint[] = [];
    const STEPS = 24;
    for (let i = 0; i < STEPS; i++) {
      const a = (i / STEPS) * 2 * Math.PI;
      circle.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    circle.push({ ...circle[0] });
    return circle;
  }

  const [cx, cy] = d3.polygonCentroid(hull);
  const padded = hull.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return { x: x + ((x - cx) / d) * padPx, y: y + ((y - cy) / d) * padPx };
  });
  padded.push({ ...padded[0] });
  return padded;
}

/**
 * Resamples a polyline to vertices spaced `stepPx` apart (last original vertex
 * always kept), so drawing k vertices per frame yields a constant-speed stroke.
 */
export function resamplePath(path: ScreenPoint[], stepPx: number): ScreenPoint[] {
  if (path.length < 2) return [...path];
  const step = Math.max(1e-6, stepPx);
  const out: ScreenPoint[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    let dist = step - carry;
    while (dist <= segLen) {
      const t = dist / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      dist += step;
    }
    carry = (carry + segLen) % step;
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (tail.x !== last.x || tail.y !== last.y) out.push({ ...last });
  return out;
}
