// packages/app/src/workers/metrics.worker.ts
// Computes median nearest-neighbor distance (via Delaunay) and max embedding distance (via convex hull)
// off the main thread to avoid blocking the UI.

import { Delaunay } from "d3-delaunay";
import { payloadToPoints, type MetricsPayload, type MetricsPt } from "./metricsPayload";

type Pt = MetricsPt;

self.onmessage = (e: MessageEvent<MetricsPayload>) => {
  const pts = payloadToPoints(e.data || []);
  const medianNN = computeMedianNN(pts);
  const maxEmbeddingDistance = computeMaxEmbeddingDistance(pts);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore web worker global
  self.postMessage({ medianNN, maxEmbeddingDistance });
};

// --- median NN via Delaunay neighbors ---
function computeMedianNN(points: Pt[]): number {
  const n = points.length;
  if (n < 2) return 0;

  const MAX = 50000;
  const sample = n > MAX ? reservoirSample(points, MAX) : points;

  const delaunay = Delaunay.from(sample, (p) => p.x, (p) => p.y);

  const dists: number[] = new Array(sample.length);
  for (let i = 0; i < sample.length; i++) {
    let min = Infinity;
    for (const j of delaunay.neighbors(i)) {
      const dx = sample[i].x - sample[j].x;
      const dy = sample[i].y - sample[j].y;
      const d = Math.hypot(dx, dy);
      if (d < min) min = d;
    }
    dists[i] = min;
  }

  const nonZero = dists.filter((d) => d > 0);
  const arr = nonZero.length >= Math.ceil(dists.length * 0.5) ? nonZero : dists;

  arr.sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function reservoirSample<T>(arr: T[], k: number): T[] {
  const res = arr.slice(0, k);
  for (let i = k; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) res[j] = arr[i];
  }
  return res;
}

// --- max embedding distance via convex hull + rotating calipers ---
function computeMaxEmbeddingDistance(points: Pt[]): number {
  const n = points.length;
  if (n < 2) return 0;
  if (n === 2) return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);

  const hull = convexHull(points);
  const m = hull.length;
  if (m < 2) return 0;
  if (m === 2) return Math.hypot(hull[0].x - hull[1].x, hull[0].y - hull[1].y);

  let maxDist2 = 0;
  let j = 1;
  for (let i = 0; i < m; i++) {
    const ni = (i + 1) % m;
    while (area2(hull[i], hull[ni], hull[(j + 1) % m]) > area2(hull[i], hull[ni], hull[j])) {
      j = (j + 1) % m;
    }
    const d1 = dist2(hull[i], hull[j]);
    const d2 = dist2(hull[ni], hull[j]);
    if (d1 > maxDist2) maxDist2 = d1;
    if (d2 > maxDist2) maxDist2 = d2;
  }
  return Math.sqrt(maxDist2);
}

function convexHull(points: Pt[]): Pt[] {
  const pts = Array.from(points);
  pts.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function cross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function area2(a: Pt, b: Pt, c: Pt): number {
  return Math.abs(cross(a, b, c));
}
function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
