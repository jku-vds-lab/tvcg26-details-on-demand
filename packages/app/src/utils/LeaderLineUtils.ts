import { LeaderLineGeometry } from "src/models/VisualElement";

/**
 * Checks whether two line segments intersect.
 * Uses standard line intersection formulas.
 *
 * @param line1 - The first leader line geometry.
 * @param line2 - The second leader line geometry.
 * @returns True if the lines intersect; false otherwise.
 */
export function doLeaderLinesOverlap(
  line1: LeaderLineGeometry,
  line2: LeaderLineGeometry
): boolean {
  // Compute the direction of the lines
  const d = (x1: number, y1: number, x2: number, y2: number) => ({ x: x2 - x1, y: y2 - y1 });

  const r = d(line1.x1, line1.y1, line1.x2, line1.y2);
  const s = d(line2.x1, line2.y1, line2.x2, line2.y2);

  const cross = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    a.x * b.y - a.y * b.x;

  const rxs = cross(r, s);
  const qp = { x: line2.x1 - line1.x1, y: line2.y1 - line1.y1 };
  const t = cross(qp, s) / rxs;
  const u = cross(qp, r) / rxs;

  // Lines overlap if t and u are between 0 and 1 (inclusive)
  return rxs !== 0 && t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
