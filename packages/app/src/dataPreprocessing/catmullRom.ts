// packages/app/src/dataPreprocessing/catmullRom.ts
//
// Shared Catmull-Rom sampling kernel. Lives in its own module (no rbush /
// DOM dependencies) so worker bundles and jest suites can use the spline
// math without pulling in the spatial-index machinery of dataPreprocessing.

export function catmullRomPoint(
  t: number,
  p0: number[],
  p1: number[],
  p2: number[],
  p3: number[]
): number[] {
  const t2 = t * t;
  const t3 = t2 * t;
  const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
  const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  return [x, y];
}
