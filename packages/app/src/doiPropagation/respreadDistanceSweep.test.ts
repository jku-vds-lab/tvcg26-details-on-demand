// packages/app/src/doiPropagation/respreadDistanceSweep.test.ts
//
// Exactness twin for the converged re-spread kernel: on a barrier-free grid
// the two-pass chamfer sweep must equal a multi-source Dijkstra over the
// same 8-connected mask (identical chamfer metric ⇒ identical function —
// any mismatch is a bug, not an approximation), and both must equal the
// closed-form chamfer distance for a single source.

import { respreadDistanceSweep } from "./fieldDistanceCore";

/**
 * Reference: multi-source offset Dijkstra over the same 3×3 chamfer mask —
 * the comparison instrument's kernel (local/convergence-compare), inlined
 * here as the test oracle. Cells whose best distance would exceed `maxDist`
 * are never settled and stay +Infinity.
 */
function respreadDistanceDijkstra(
  W: number,
  H: number,
  cellSize: number,
  seedRows: ArrayLike<number>,
  seedCols: ArrayLike<number>,
  seedOffsets: ArrayLike<number>,
  maxDist: number
): Float64Array {
  const size = W * H;
  const dist = new Float64Array(size).fill(Infinity);
  const diag = Math.SQRT2 * cellSize;
  // (distance, cell) pairs in a plain-array binary heap with lazy deletion.
  const heapD: number[] = [];
  const heapC: number[] = [];
  const push = (d: number, c: number): void => {
    let i = heapD.length;
    heapD.push(d);
    heapC.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= heapD[i]) break;
      [heapD[p], heapD[i]] = [heapD[i], heapD[p]];
      [heapC[p], heapC[i]] = [heapC[i], heapC[p]];
      i = p;
    }
  };
  const relax = (c: number, nd: number): void => {
    if (nd < dist[c] && nd <= maxDist) {
      dist[c] = nd;
      push(nd, c);
    }
  };
  for (let j = 0; j < seedRows.length; j++) {
    const c = seedRows[j] * W + seedCols[j];
    const o = seedOffsets[j];
    if (o < dist[c] && o <= maxDist) {
      dist[c] = o;
      push(o, c);
    }
  }
  while (heapD.length > 0) {
    const d = heapD[0];
    const c = heapC[0];
    const lastD = heapD.pop()!;
    const lastC = heapC.pop()!;
    if (heapD.length > 0) {
      heapD[0] = lastD;
      heapC[0] = lastC;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heapD.length) break;
        const r = l + 1;
        const m = r < heapD.length && heapD[r] < heapD[l] ? r : l;
        if (heapD[i] <= heapD[m]) break;
        [heapD[i], heapD[m]] = [heapD[m], heapD[i]];
        [heapC[i], heapC[m]] = [heapC[m], heapC[i]];
        i = m;
      }
    }
    if (d > dist[c]) continue; // stale
    const row = (c / W) | 0;
    const col = c - row * W;
    const up = row > 0;
    const down = row < H - 1;
    const left = col > 0;
    const right = col < W - 1;
    if (up) relax(c - W, d + cellSize);
    if (down) relax(c + W, d + cellSize);
    if (left) relax(c - 1, d + cellSize);
    if (right) relax(c + 1, d + cellSize);
    if (up && left) relax(c - W - 1, d + diag);
    if (up && right) relax(c - W + 1, d + diag);
    if (down && left) relax(c + W - 1, d + diag);
    if (down && right) relax(c + W + 1, d + diag);
  }
  return dist;
}

/** Deterministic LCG so the random-grid cases are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function maxAbsDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === Infinity && bi === Infinity) continue;
    const d = Math.abs(ai - bi);
    if (d > m || Number.isNaN(d)) m = d;
  }
  return m;
}

describe("respreadDistanceSweep", () => {
  test("single source, zero offset: equals the closed-form chamfer distance", () => {
    const W = 17;
    const H = 13;
    const cell = 0.25;
    const sweep = respreadDistanceSweep(W, H, cell, [5], [8], [0], Infinity);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const dr = Math.abs(r - 5);
        const dc = Math.abs(c - 8);
        const hi = Math.max(dr, dc);
        const lo = Math.min(dr, dc);
        const expected = ((hi - lo) + Math.SQRT2 * lo) * cell;
        expect(Math.abs(sweep[r * W + c] - expected)).toBeLessThanOrEqual(1e-12);
      }
    }
  });

  test("co-cell sources: the MIN offset wins (never additive)", () => {
    const W = 9;
    const H = 9;
    const sweep = respreadDistanceSweep(
      W, H, 1,
      [4, 4, 4], [4, 4, 4], [0.9, 0.3, 0.6],
      Infinity
    );
    expect(sweep[4 * W + 4]).toBe(0.3);
    expect(sweep[4 * W + 5]).toBeCloseTo(1.3, 12);
  });

  test("maxDist crop: beyond-the-floor cells are +Infinity, not large finite", () => {
    const W = 21;
    const H = 5;
    const sweep = respreadDistanceSweep(W, H, 1, [2], [0], [0.5], 3.4);
    expect(sweep[2 * W + 0]).toBe(0.5);
    expect(sweep[2 * W + 2]).toBe(2.5); // 0.5 + 2 ≤ 3.4 kept
    expect(sweep[2 * W + 3]).toBe(Infinity); // 3.5 > 3.4 cropped
    expect(sweep[2 * W + 20]).toBe(Infinity);
  });

  test.each([1, 2, 3, 4, 5])(
    "random multi-source offset grids equal the Dijkstra oracle (case %i)",
    (caseNo) => {
      const rng = makeRng(0x51ee9 + caseNo * 7919);
      const W = 20 + Math.floor(rng() * 60);
      const H = 20 + Math.floor(rng() * 60);
      const cell = 0.05 + rng();
      const k = 1 + Math.floor(rng() * 40);
      const rows = new Int32Array(k);
      const cols = new Int32Array(k);
      const offs = new Float64Array(k);
      for (let j = 0; j < k; j++) {
        rows[j] = Math.floor(rng() * H);
        cols[j] = Math.floor(rng() * W);
        offs[j] = rng() * 5 * cell;
      }
      // Alternate an infinite and a binding crop radius across cases.
      const maxDist = caseNo % 2 === 0 ? Infinity : cell * (W + H) * 0.3;
      const sweep = respreadDistanceSweep(W, H, cell, rows, cols, offs, maxDist);
      const dijkstra = respreadDistanceDijkstra(W, H, cell, rows, cols, offs, maxDist);
      const dev = maxAbsDiff(sweep, dijkstra);
      // Identical chamfer metric ⇒ identical function. The only measured
      // deviation is float summation-order dust on TIED optimal paths (the
      // same step multiset accumulated in a different order, e.g.
      // o + cell + diag vs o + diag + cell): ≤ 3.6e-15 metric units (~2 ulp)
      // across all cases, three million times below the f32 quantization the
      // sampled values are stored at. Anything above this band would be a
      // real metric/mask bug, so the gate sits just over the measured dust.
      expect(dev).toBeLessThanOrEqual(1e-12);
      // Crop semantics agree cell-by-cell (Infinity vs finite mismatches
      // would be invisible to maxAbsDiff's both-Infinity skip).
      for (let i = 0; i < sweep.length; i++) {
        expect(sweep[i] === Infinity).toBe(dijkstra[i] === Infinity);
      }
    }
  );
});
