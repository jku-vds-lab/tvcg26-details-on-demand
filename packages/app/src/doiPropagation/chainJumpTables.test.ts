// Parity guard for the GPU motion lane's chain closure
// (plan-gpu-motion-lane.md): the pointer-doubling scan simulated pass-by-pass
// (the JS oracle of the GLSL chain pass) must equal chainScanTrajectoryCore's
// sequential closure — on ragged multi-line datasets, at the weight
// endpoints, and per direction.

import {
  buildChainJumpTables,
  simulateDoublingChainScan,
} from "./chainJumpTables";
import { chainScanTrajectoryCore } from "./fieldPreviewCore";

/** Build pred/succ indices for consecutive-record lines of the given lengths. */
function lineIndices(lineLengths: number[]): {
  predIndex: Int32Array;
  succIndex: Int32Array;
  n: number;
} {
  const n = lineLengths.reduce((a, b) => a + b, 0);
  const predIndex = new Int32Array(n).fill(-1);
  const succIndex = new Int32Array(n).fill(-1);
  let base = 0;
  for (const len of lineLengths) {
    for (let k = 1; k < len; k++) {
      predIndex[base + k] = base + k - 1;
      succIndex[base + k - 1] = base + k;
    }
    base += len;
  }
  return { predIndex, succIndex, n };
}

/** Deterministic pseudo-random values in [0, 1). */
function seededValues(n: number, seed: number): Float32Array {
  const v = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s % 1000) / 1000;
  }
  return v;
}

describe("buildChainJumpTables", () => {
  it("covers the longest chain with ceil(log2) levels", () => {
    const { predIndex, succIndex } = lineIndices([107]);
    const t = buildChainJumpTables(predIndex, succIndex);
    // 106 hops -> 2^7 - 1 = 127 >= 106, 2^6 - 1 = 63 < 106.
    expect(t.levels).toBe(7);
  });

  it("is level-0-free for a chain-inert dataset (one record per line)", () => {
    const { predIndex, succIndex } = lineIndices([1, 1, 1, 1]);
    const t = buildChainJumpTables(predIndex, succIndex);
    expect(t.levels).toBe(0);
    expect(t.predJumps.length).toBe(0);
  });

  it("level k holds the 2^k-th ancestor", () => {
    const { predIndex, succIndex } = lineIndices([10]);
    const t = buildChainJumpTables(predIndex, succIndex);
    const n = 10;
    // Record 9's 4th predecessor is record 5 (level 2).
    expect(t.predJumps[2 * n + 9]).toBe(5);
    // Record 0's successor chain: level 3 (8th successor) of 0 is 8.
    expect(t.succJumps[3 * n + 0]).toBe(8);
    // Chain shorter than the jump: record 3 has no 8th predecessor.
    expect(t.predJumps[3 * n + 3]).toBe(-1);
  });
});

describe("simulateDoublingChainScan vs chainScanTrajectoryCore", () => {
  const cases: Array<{ name: string; lines: number[]; past: number; future: number }> = [
    { name: "single long line, fractional weights", lines: [107], past: 0.42, future: 0.75 },
    { name: "ragged lines", lines: [1, 5, 33, 2, 64, 9], past: 0.9, future: 0.1 },
    { name: "future only", lines: [16, 16, 3], past: 0, future: 0.8 },
    { name: "past only", lines: [16, 16, 3], past: 0.8, future: 0 },
    { name: "flood weights (w = 1 both)", lines: [50, 7], past: 1, future: 1 },
    { name: "weights above 1 clamp", lines: [12, 12], past: 1.5, future: 2 },
    { name: "chain-inert", lines: [1, 1, 1], past: 0.7, future: 0.7 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const { predIndex, succIndex, n } = lineIndices(c.lines);
      const tables = buildChainJumpTables(predIndex, succIndex);
      const base = seededValues(n, 4242);
      const expected = new Float32Array(base);
      chainScanTrajectoryCore(expected, predIndex, succIndex, c.past, c.future);
      const actual = new Float32Array(base);
      simulateDoublingChainScan(actual, tables, c.past, c.future);
      // Same max-times closure, same f32 rounding per multiply chain — the
      // doubling reassociates the gain products, so allow one-ulp-level slack.
      for (let i = 0; i < n; i++) {
        expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(1e-6);
      }
    });
  }
});
