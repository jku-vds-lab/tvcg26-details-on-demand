// JS twin of the GPU motion lane's pass structure (plan-gpu-motion-lane.md
// §5): doubling chain closure + raised-only scatter (per-cell min offset,
// the depth-test argmin) + exact closed-form chamfer nearest-source + the
// CPU bilinear inf-guard + FIXED rounds, evaluated through
// evalFalloffPreviewParams (the pinned GLSL twin). Asserting it against
// computeConvergedPreview pins the one semantic deviation the GPU executor
// makes without a WebGL context: fixed CONV_MAX_ROUNDS instead of the eps
// early-exit (extra rounds past the fixed point are monotone no-ops, and a
// round whose chain raises nothing scatters nothing).
// What it deliberately does NOT simulate is JFA's propagation topology (the
// only unsimulated approximation) and f32 grid math — both land in the e2e
// harness's measured GPU-vs-CPU delta.

import {
  buildChainJumpTables,
  simulateDoublingChainScan,
} from "./chainJumpTables";
import {
  CONV_EPS,
  CONV_MAX_ROUNDS,
  CONV_RESPREAD_FLOOR,
  computeConvergedPreview,
} from "./convergedField";
import {
  computeFalloffPreviewParams,
  evalFalloffPreviewParams,
  falloffInverse,
  FALLOFF_DIST_SENTINEL,
  type FalloffShape,
} from "./falloff";
import {
  computeRecordDistances,
  rasterize,
  type FieldRaster,
} from "./fieldDistanceCore";
import { computeFieldPreview } from "./fieldPreviewCore";

interface TwinInput {
  recordDist: Float32Array;
  predIndex: Int32Array;
  succIndex: Int32Array;
  seedIdx: Int32Array;
  raster: FieldRaster;
  shape: FalloffShape;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
}

/** The GPU pipeline, stage for stage, in JS (f64 grid math). */
function simulateGpuConvergedPreview(input: TwinInput): Float32Array {
  const { recordDist, raster, shape, prox, past, future, maxEmb } = input;
  const n = recordDist.length;
  const params = computeFalloffPreviewParams(shape, prox, maxEmb);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = recordDist[i];
    v[i] = evalFalloffPreviewParams(
      params,
      d < FALLOFF_DIST_SENTINEL ? d : FALLOFF_DIST_SENTINEL
    );
  }
  for (let k = 0; k < input.seedIdx.length; k++) v[input.seedIdx[k]] = 1;

  const tables = buildChainJumpTables(input.predIndex, input.succIndex);
  const spatial = params.mode === 1 && maxEmb > 0;
  const rounds = spatial ? CONV_MAX_ROUNDS : 1;
  const maxDist = falloffInverse(CONV_RESPREAD_FLOOR, shape, prox, maxEmb);
  const straight = raster.cellSize;
  const diag = Math.SQRT2 * raster.cellSize;

  const before = new Float32Array(n);
  for (let round = 0; round < rounds; round++) {
    before.set(v);
    simulateDoublingChainScan(v, tables, past, future);
    if (!spatial) break;

    // Raised-only scatter (the CPU loop's source set), per-cell min offset
    // (the depth-test argmin).
    const cellOffset = new Map<number, { row: number; col: number; off: number }>();
    for (let i = 0; i < n; i++) {
      if (v[i] <= before[i] + CONV_EPS) continue;
      const off = falloffInverse(v[i], shape, prox, maxEmb);
      const key = raster.rows[i] * raster.W + raster.cols[i];
      const cur = cellOffset.get(key);
      if (!cur || off < cur.off) {
        cellOffset.set(key, { row: raster.rows[i], col: raster.cols[i], off });
      }
    }
    const sources = Array.from(cellOffset.values());

    // Exact nearest-source under the chamfer closed form + futility crop —
    // what JFA approximates. Memoized per round (gather touches ≤ 5 cells
    // per record).
    const cellD = new Map<number, number>();
    const evalCell = (col: number, row: number): number => {
      const key = row * raster.W + col;
      const hit = cellD.get(key);
      if (hit !== undefined) return hit;
      let best = Infinity;
      for (const s of sources) {
        const dr = Math.abs(row - s.row);
        const dc = Math.abs(col - s.col);
        const mn = Math.min(dr, dc);
        const d = s.off + diag * mn + straight * (Math.max(dr, dc) - mn);
        if (d < best) best = d;
      }
      if (best > maxDist) best = Infinity;
      cellD.set(key, best);
      return best;
    };

    // Gather: CPU bilinear lerp order + the any-corner-infinite guard.
    for (let i = 0; i < n; i++) {
      const fc = Math.min(Math.max(raster.fcols[i], 0), raster.W - 1);
      const fr = Math.min(Math.max(raster.frows[i], 0), raster.H - 1);
      const c0 = Math.floor(fc);
      const r0 = Math.floor(fr);
      const c1 = Math.min(c0 + 1, raster.W - 1);
      const r1 = Math.min(r0 + 1, raster.H - 1);
      const wc = fc - c0;
      const wr = fr - r0;
      const v00 = evalCell(c0, r0);
      const v01 = evalCell(c1, r0);
      const v10 = evalCell(c0, r1);
      const v11 = evalCell(c1, r1);
      let d: number;
      if (!isFinite(Math.max(Math.max(v00, v01), Math.max(v10, v11)))) {
        d = evalCell(raster.cols[i], raster.rows[i]);
        if (!isFinite(d)) continue;
      } else {
        const top = (v01 - v00) * wc + v00;
        const bot = (v11 - v10) * wc + v10;
        d = (bot - top) * wr + top;
      }
      const f2 = evalFalloffPreviewParams(params, d);
      if (f2 > v[i]) v[i] = f2;
    }
  }
  return v;
}

/** Fixture: three trajectories — two parallel far-apart lines plus a bridge
 * line whose chain carries DoI across the gap, so the re-spread rounds do
 * real work (chain-raised bridge states re-seed the far line's neighborhood). */
function buildFixture() {
  const lineLen = 12;
  const x: number[] = [];
  const y: number[] = [];
  const lines: number[][] = [];
  const addLine = (fx: (t: number) => number, fy: (t: number) => number) => {
    const idx: number[] = [];
    for (let k = 0; k < lineLen; k++) {
      const t = k / (lineLen - 1);
      idx.push(x.length);
      x.push(fx(t));
      y.push(fy(t));
    }
    lines.push(idx);
  };
  addLine((t) => t * 10, () => 0); // bottom line
  addLine((t) => t * 10, () => 8); // top line, far away
  addLine(() => 10, (t) => t * 8); // bridge connecting their far ends
  const n = x.length;
  const predIndex = new Int32Array(n).fill(-1);
  const succIndex = new Int32Array(n).fill(-1);
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      predIndex[line[k]] = line[k - 1];
      succIndex[line[k - 1]] = line[k];
    }
  }
  // Seeds: the bottom line's first three records.
  const seedIdx = Int32Array.from([0, 1, 2]);
  const { recordDist } = computeRecordDistances({ x, y, seedIdx, gridResolution: 24 });
  const raster = rasterize(x, y, 24);
  return { x, y, predIndex, succIndex, seedIdx, recordDist, raster };
}

describe("GPU pipeline twin vs computeConvergedPreview", () => {
  const fx = buildFixture();
  const maxEmb = 12.81; // ≈ the projection diameter of the fixture

  const run = (shape: FalloffShape, prox: number, past: number, future: number) => {
    const input: TwinInput = {
      recordDist: fx.recordDist,
      predIndex: fx.predIndex,
      succIndex: fx.succIndex,
      seedIdx: fx.seedIdx,
      raster: fx.raster,
      shape,
      prox,
      past,
      future,
      maxEmb,
    };
    const gpu = simulateGpuConvergedPreview(input);
    const cpu = computeConvergedPreview({
      recordDist: fx.recordDist,
      predIndex: fx.predIndex,
      succIndex: fx.succIndex,
      seedIdx: fx.seedIdx,
      getRaster: () => fx.raster,
      shape,
      prox,
      past,
      future,
      maxEmb,
    });
    return { gpu, cpu };
  };

  it.each([
    ["log", 0.45, 0.9, 0.9],
    ["exp", 0.35, 0.85, 0.9],
    ["plateau", 0.55, 0.9, 0.8],
    ["linear", 0.5, 0.9, 0.9],
    ["gauss", 0.4, 0.85, 0.85],
  ] as Array<[FalloffShape, number, number, number]>)(
    "matches within eps-level tolerance (%s)",
    (shape, prox, past, future) => {
      const { gpu, cpu } = run(shape, prox, past, future);
      let maxDelta = 0;
      for (let i = 0; i < cpu.length; i++) {
        maxDelta = Math.max(maxDelta, Math.abs(gpu[i] - cpu[i]));
      }
      // The CPU stops at CONV_EPS and scatters raised-only; the twin runs
      // fixed rounds and scatters all — eps-level residue is the contract.
      expect(maxDelta).toBeLessThanOrEqual(5e-3);
    }
  );

  it("the fixture actually exercises the re-spread (converged ≠ first-order)", () => {
    const { cpu } = run("log", 0.45, 0.9, 0.9);
    const firstOrder = computeFieldPreview({
      recordDist: fx.recordDist,
      predIndex: fx.predIndex,
      succIndex: fx.succIndex,
      seedIdx: fx.seedIdx,
      shape: "log",
      prox: 0.45,
      past: 0.9,
      future: 0.9,
      maxEmb,
    });
    let raised = 0;
    for (let i = 0; i < cpu.length; i++) {
      if (cpu[i] > firstOrder[i] + 0.01) raised++;
    }
    expect(raised).toBeGreaterThan(0);
  });

  it("prox endpoints collapse to init + one chain closure, both sides equal", () => {
    for (const prox of [0, 1]) {
      const { gpu, cpu } = run("log", prox, 0.6, 0.6);
      for (let i = 0; i < cpu.length; i++) {
        expect(Math.abs(gpu[i] - cpu[i])).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("chain-inert records (no pred/succ) stay byte-stable at f(D)/seed", () => {
    const n = fx.recordDist.length;
    const inert: TwinInput = {
      recordDist: fx.recordDist,
      predIndex: new Int32Array(n).fill(-1),
      succIndex: new Int32Array(n).fill(-1),
      seedIdx: fx.seedIdx,
      raster: fx.raster,
      shape: "log",
      prox: 0.45,
      past: 0.9,
      future: 0.9,
      maxEmb,
    };
    const gpu = simulateGpuConvergedPreview(inert);
    const cpu = computeConvergedPreview({
      recordDist: inert.recordDist,
      predIndex: inert.predIndex,
      succIndex: inert.succIndex,
      seedIdx: inert.seedIdx,
      getRaster: () => fx.raster,
      shape: "log",
      prox: 0.45,
      past: 0.9,
      future: 0.9,
      maxEmb,
    });
    for (let i = 0; i < n; i++) {
      expect(gpu[i]).toBe(cpu[i]);
    }
  });
});
