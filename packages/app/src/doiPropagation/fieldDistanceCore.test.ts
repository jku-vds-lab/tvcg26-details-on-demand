// packages/app/src/doiPropagation/fieldDistanceCore.test.ts
//
// Unit tests for the client distance-field core (issue #315 field parity,
// P2): rasterize rounding/clip edges, exact EDT vs O(n²) brute force,
// bilinear inf-guard corners, degenerate seed sets. The cross-language
// contract lives in doiFieldParity.test.ts (python-owned fixtures).

import {
  bilinearSampleDist,
  computeRecordDistances,
  edtSquared,
  rasterize,
  seedDistanceGrid,
} from "./fieldDistanceCore";

/** Deterministic PRNG (mulberry32) so grid cases are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bruteForceSquared(seed: Uint8Array, W: number, H: number): Float64Array {
  const out = new Float64Array(W * H).fill(Infinity);
  const seeds: Array<[number, number]> = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (seed[r * W + c] !== 0) seeds.push([r, c]);
    }
  }
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let best = Infinity;
      for (const [sr, sc] of seeds) {
        const d = (r - sr) * (r - sr) + (c - sc) * (c - sc);
        if (d < best) best = d;
      }
      out[r * W + c] = best;
    }
  }
  return out;
}

describe("rasterize", () => {
  test("uniform square cells sized by the longer axis", () => {
    // x spans 4, y spans 2 → cellSize = 4 / (5 - 1) = 1.
    const r = rasterize([0, 4], [0, 2], 5);
    expect(r.cellSize).toBe(1);
    expect(Array.from(r.cols)).toEqual([0, 4]);
    expect(Array.from(r.rows)).toEqual([0, 2]);
    expect(r.W).toBe(5);
    expect(r.H).toBe(3);
  });

  test("rounds half to EVEN like np.round, not half-up", () => {
    // Span 2, gridRes 5 → cellSize 0.5. x=0.25 → fcol 0.5 (→ 0, not 1);
    // y=0.75 → frow 1.5 (→ 2, both are even-target halves).
    const r = rasterize([0, 0.25, 2], [0, 0.75, 2], 5);
    expect(r.fcols[1]).toBe(0.5);
    expect(r.cols[1]).toBe(0);
    expect(r.frows[1]).toBe(1.5);
    expect(r.rows[1]).toBe(2);
  });

  test("degenerate single point yields a 1x1 grid without NaN", () => {
    const r = rasterize([3.5], [-1.25], 1024);
    expect(r.W).toBe(1);
    expect(r.H).toBe(1);
    expect(r.rows[0]).toBe(0);
    expect(r.cols[0]).toBe(0);
    expect(Number.isFinite(r.cellSize)).toBe(true);
    expect(r.cellSize).toBeGreaterThan(0);
  });
});

describe("edtSquared", () => {
  test.each([
    ["single seed", 1],
    ["sparse seeds", 24],
    ["dense seeds", 120],
  ])("matches O(n²) brute force (%s)", (_name, nSeeds) => {
    const W = 20;
    const H = 14;
    const rnd = mulberry32(315 + nSeeds);
    const seed = new Uint8Array(W * H);
    let placed = 0;
    while (placed < nSeeds) {
      const i = Math.floor(rnd() * W * H);
      if (seed[i] === 0) {
        seed[i] = 1;
        placed++;
      }
    }
    const got = edtSquared(seed, W, H);
    const want = bruteForceSquared(seed, W, H);
    for (let i = 0; i < W * H; i++) {
      expect(got[i]).toBe(want[i]); // integer squared distances — exact
    }
  });

  test("all seeds → all zero; no seeds → all Infinity", () => {
    const W = 7;
    const H = 5;
    const all = edtSquared(new Uint8Array(W * H).fill(1), W, H);
    const none = edtSquared(new Uint8Array(W * H), W, H);
    for (let i = 0; i < W * H; i++) {
      expect(all[i]).toBe(0);
      expect(none[i]).toBe(Infinity);
    }
  });
});

describe("seedDistanceGrid", () => {
  test("metric units: sqrt of squared cells times cellSize", () => {
    const grid = seedDistanceGrid([0], [0], 4, 3, 0.5);
    expect(grid[0]).toBe(0);
    expect(grid[3]).toBeCloseTo(3 * 0.5, 12); // (0,3)
    expect(grid[2 * 4 + 0]).toBeCloseTo(2 * 0.5, 12); // (2,0)
    expect(grid[2 * 4 + 3]).toBeCloseTo(Math.sqrt(13) * 0.5, 12);
  });
});

describe("bilinearSampleDist", () => {
  const grid = Float64Array.from([0, 1, 2, 3]); // 2x2: rows [0,1],[2,3]

  test("interior lerp uses the python op order", () => {
    // top = 0.5, bot = 2.5, out = 1.5 at the center.
    expect(bilinearSampleDist(grid, 2, 2, 0.5, 0.5, 0, 0)).toBe(1.5);
  });

  test("clamps fractional coords into the grid", () => {
    expect(bilinearSampleDist(grid, 2, 2, -3, 9, 0, 1)).toBe(1); // (0, 1)
    expect(bilinearSampleDist(grid, 2, 2, 9, -3, 1, 0)).toBe(2); // (1, 0)
  });

  test("one non-finite corner falls back to the nearest cell", () => {
    const holey = Float64Array.from([0, Infinity, 2, 3]);
    expect(bilinearSampleDist(holey, 2, 2, 0.25, 0.25, 0, 0)).toBe(0);
    // All corners finite: normal lerp even next to the hole.
    expect(bilinearSampleDist(holey, 2, 2, 1, 0.5, 1, 0)).toBe(2.5);
  });
});

describe("computeRecordDistances", () => {
  test("no seeds → +Infinity everywhere (Float32Array survives the cast)", () => {
    const { recordDist } = computeRecordDistances({
      x: [0, 1, 2],
      y: [0, 0, 0],
      seedIdx: [],
    });
    expect(recordDist).toBeInstanceOf(Float32Array);
    expect(Array.from(recordDist)).toEqual([Infinity, Infinity, Infinity]);
  });

  test("seed distance ~0, and distances grow monotonically along a line", () => {
    const n = 12;
    const x = Array.from({ length: n }, (_v, i) => i);
    const y = new Array(n).fill(0);
    const { recordDist } = computeRecordDistances({ x, y, seedIdx: [0], gridResolution: 64 });
    expect(recordDist[0]).toBeLessThan(1e-6);
    for (let i = 1; i < n; i++) {
      expect(recordDist[i]).toBeGreaterThan(recordDist[i - 1]);
    }
    // Metric sanity: the far end sits ~11 units from the seed.
    expect(recordDist[n - 1]).toBeCloseTo(11, 1);
  });

  test("duplicate points share a cell: the twin of a seed reads ~0", () => {
    const { recordDist } = computeRecordDistances({
      x: [5, 5, 9],
      y: [2, 2, 7],
      seedIdx: [0],
      gridResolution: 32,
    });
    expect(recordDist[1]).toBeLessThan(1e-6);
    expect(recordDist[2]).toBeGreaterThan(1);
  });

  test("all points seeded → every distance under a cell", () => {
    const x = [0, 3, 7, 2];
    const y = [1, 4, 0, 6];
    const { recordDist } = computeRecordDistances({
      x,
      y,
      seedIdx: [0, 1, 2, 3],
      gridResolution: 64,
    });
    for (let i = 0; i < 4; i++) {
      expect(recordDist[i]).toBeLessThan(7 / 63 + 1e-9);
    }
  });
});
