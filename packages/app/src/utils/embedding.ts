
/**
 * Computes the maximum Euclidean distance (the diameter) among the dataset's points.
 * Uses d3.polygonHull to compute the convex hull (O(n log n)) and then the rotating calipers algorithm.
 */
// Exact 2D diameter in O(n log n) via convex hull + rotating calipers.
export function computeMaxEmbeddingDistance(points: { x: number; y: number }[]): number {
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

type Pt = { x: number; y: number };

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