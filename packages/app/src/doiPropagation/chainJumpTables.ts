// packages/app/src/doiPropagation/chainJumpTables.ts
//
// Pointer-doubling jump tables for the GPU motion lane's chain closure
// (plan-gpu-motion-lane.md §2.2). `chainScanTrajectoryCore` is a max-times
// closure along per-line pred/succ chains — one CPU pass suffices because the
// in-place scan cascades, but a GPU gather pass only moves values ONE hop.
// Hillis-Steele doubling fixes that: pass k folds
//
//     v'[i] = max(v[i], v[jump_k[i]] · w^(2^k))
//
// where jump_k[i] is i's 2^k-th predecessor (or successor), so after passes
// k = 0..K every ancestor within 2^(K+1)−1 hops has contributed — exactly the
// closure — in ceil(log2(L)) passes for the longest chain L. The tables are a
// pure function of the dataset's pred/succ indices (slider-independent),
// built once per dataset and uploaded once per field commit.
//
// Pure and worker/GL-free; simulateDoublingChainScan exists for the jest
// parity twin (and is the JS oracle for the GLSL chain pass).

export interface ChainJumpTables {
  /** Doubling levels (0 for a chain-free dataset — no passes needed). */
  levels: number;
  /** Level-major [levels × n]: predJumps[k*n + i] = i's 2^k-th predecessor,
   * -1 when the chain ends earlier. Level 0 IS predIndex. */
  predJumps: Int32Array;
  /** Same, along succIndex. */
  succJumps: Int32Array;
}

/** Longest hop chain in either direction (pred chains walked once, O(n) via
 * memoized depths — succ chains have identical lengths by symmetry). */
function maxChainHops(predIndex: Int32Array): number {
  const n = predIndex.length;
  const depth = new Int32Array(n).fill(-1);
  let max = 0;
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (depth[i] >= 0) continue;
    let j = i;
    while (j >= 0 && depth[j] < 0) {
      stack.push(j);
      j = predIndex[j];
    }
    let d = j >= 0 ? depth[j] : -1;
    while (stack.length) {
      d += 1;
      depth[stack.pop()!] = d;
    }
    if (d > max) max = d;
  }
  return max;
}

/** Build both doubling tables. levels = ceil(log2(maxHops + 1)) so that
 * 2^levels − 1 ≥ maxHops (the closure window covers the longest chain). */
export function buildChainJumpTables(
  predIndex: Int32Array,
  succIndex: Int32Array
): ChainJumpTables {
  const n = predIndex.length;
  const maxHops = maxChainHops(predIndex);
  let levels = 0;
  while ((1 << levels) - 1 < maxHops) levels++;
  const predJumps = new Int32Array(levels * n);
  const succJumps = new Int32Array(levels * n);
  if (levels > 0) {
    predJumps.set(predIndex, 0);
    succJumps.set(succIndex, 0);
    for (let k = 1; k < levels; k++) {
      const prev = (k - 1) * n;
      const cur = k * n;
      for (let i = 0; i < n; i++) {
        const jp = predJumps[prev + i];
        predJumps[cur + i] = jp < 0 ? -1 : predJumps[prev + jp];
        const js = succJumps[prev + i];
        succJumps[cur + i] = js < 0 ? -1 : succJumps[prev + js];
      }
    }
  }
  return { levels, predJumps, succJumps };
}

/**
 * JS oracle of the GPU chain pass: the doubling closure run with synchronous
 * ping-pong passes, BOTH directions fused per level (each record may take
 * its pred-jump, its succ-jump, or neither). Every pure-direction path is
 * covered by the binary decomposition of its hop count, and the extra mixed
 * candidates never win (a forward-then-backward detour's gain future^a·past^b
 * is ≤ the pure gain for the same endpoint), so the result equals
 * `chainScanTrajectoryCore`'s sequential closure — the jest twin asserts it.
 * Mutates `values` in place.
 */
export function simulateDoublingChainScan(
  values: Float32Array,
  tables: ChainJumpTables,
  past: number,
  future: number
): void {
  const n = values.length;
  const { levels, predJumps, succJumps } = tables;
  if (levels === 0) return;
  let gainF = future > 0 ? Math.min(future, 1) : 0;
  let gainP = past > 0 ? Math.min(past, 1) : 0;
  if (gainF === 0 && gainP === 0) return;
  const scratch = new Float32Array(n);
  for (let k = 0; k < levels; k++) {
    scratch.set(values);
    const off = k * n;
    for (let i = 0; i < n; i++) {
      let v = values[i];
      if (gainF > 0) {
        const j = predJumps[off + i];
        if (j >= 0) {
          const cand = scratch[j] * gainF;
          if (cand > v) v = cand;
        }
      }
      if (gainP > 0) {
        const j = succJumps[off + i];
        if (j >= 0) {
          const cand = scratch[j] * gainP;
          if (cand > v) v = cand;
        }
      }
      values[i] = v;
    }
    gainF *= gainF;
    gainP *= gainP;
  }
}
