import { useMemo } from "react";
import { groupVoteRows } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getFeatureValue } from "src/utils/getFeatureValue";

export const faces = ["up", "left", "front", "right", "down", "back"] as const;
export const faceIndex: Record<typeof faces[number], number> = {
  up: 0,
  left: 1,
  front: 2,
  right: 3,
  down: 4,
  back: 5,
};

const COLOR_IDX: Record<string, number> = { O: 0, Y: 1, G: 2, B: 3, R: 4, W: 5 };
const encodedSample = new WeakMap<object, Uint8Array>();
const aggCache = new Map<string, { major: Uint8Array; prop: Float32Array }>();

export const colorNames = ["O", "Y", "G", "B", "R", "W"] as const;
export const fineTuningScale = 0.3;
export const size = 20;
export const distance = 1;
export const backgroundColor = "#F0F0F0";

export function encodeSample54(p: DataPoint): Uint8Array {
  let arr = encodedSample.get(p);
  if (arr) return arr;
  arr = new Uint8Array(54);
  let k = 0;
  for (const face of faces) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const key = `${face}${i}${j}`;
        const c = String(getFeatureValue(p, key) ?? "");
        arr[k++] = COLOR_IDX[c] ?? 255;
      }
    }
  }
  encodedSample.set(p, arr);
  return arr;
}

export function useRubiksAggregation(samplesSig: string, samples: DataPoint[]) {
  return useMemo(() => {
    const hit = aggCache.get(samplesSig);
    if (hit) return hit;

    // Index-backed group arrays keep holes forever (issue #315 R1c) — resolve
    // the local scan's rows through the member spec: every member once
    // resident, ≤4096 strided while not (a hole crashes encodeSample54).
    const rows = groupVoteRows(samples, 4096) ?? samples;
    const counts = new Uint16Array(54 * 6);
    for (const s of rows) {
      const enc = encodeSample54(s);
      for (let cell = 0; cell < 54; cell++) {
        const c = enc[cell];
        if (c < 6) counts[cell * 6 + c] += 1;
      }
    }

    const major = new Uint8Array(54);
    const prop = new Float32Array(54);
    for (let cell = 0; cell < 54; cell++) {
      let bestC = 255;
      let bestCnt = 0;
      let total = 0;
      for (let c = 0; c < 6; c++) {
        const v = counts[cell * 6 + c];
        total += v;
        if (v > bestCnt) {
          bestCnt = v;
          bestC = c;
        }
      }
      major[cell] = bestC === 255 ? 255 : bestC;
      prop[cell] = total ? bestCnt / total : 0;
    }
    const out = { major, prop };
    aggCache.set(samplesSig, out);
    return out;
  }, [samplesSig, samples]);
}

export function cellIndex(face: typeof faces[number], i: number, j: number): number {
  return faceIndex[face] * 9 + i * 3 + j;
}

/**
 * For each of the 54 stickers, find the color whose probability increased the most
 * from the start cluster to the end cluster.
 *
 * @returns Array of 54 `{ color: number; delta: number }` entries (same order as
 *   `encodeSample54`). `color` is the 0-5 index into `colorNames`. `delta` is in
 *   [0, 1] — 0 means no gain; 1 means the color went from absent to dominant.
 */
export function colorDiff54(
  starts: DataPoint[],
  ends: DataPoint[]
): { color: number; delta: number }[] {
  // The sides are the ORIGINAL group arrays (edgeSides.ts) — same holey-slot
  // rule as useRubiksAggregation, so both sides walk resolved vote rows.
  const startRows = groupVoteRows(starts, 4096) ?? starts;
  const endRows = groupVoteRows(ends, 4096) ?? ends;
  const nS = startRows.length || 1;
  const nE = endRows.length || 1;

  const startCounts = new Uint16Array(54 * 6);
  const endCounts   = new Uint16Array(54 * 6);

  for (const s of startRows) {
    const enc = encodeSample54(s);
    for (let cell = 0; cell < 54; cell++) {
      const c = enc[cell];
      if (c < 6) startCounts[cell * 6 + c] += 1;
    }
  }

  for (const e of endRows) {
    const enc = encodeSample54(e);
    for (let cell = 0; cell < 54; cell++) {
      const c = enc[cell];
      if (c < 6) endCounts[cell * 6 + c] += 1;
    }
  }

  const result: { color: number; delta: number }[] = [];

  for (let cell = 0; cell < 54; cell++) {
    let bestColor = 0;
    let bestDelta = 0;

    for (let c = 0; c < 6; c++) {
      const startProb = startCounts[cell * 6 + c] / nS;
      const endProb   = endCounts[cell * 6 + c]   / nE;
      const delta = endProb - startProb;
      if (delta > bestDelta) {
        bestDelta = delta;
        bestColor = c;
      }
    }

    result.push({ color: bestColor, delta: bestDelta });
  }

  return result;
}

export function cubieToColour(str: string, opacity: number): string {
  const map: Record<string, string> = {
    O: `rgba(255,137,33,${opacity})`,
    Y: `rgba(255,204,0,${opacity})`,
    G: `rgba(48,174,32,${opacity})`,
    B: `rgba(21,130,174,${opacity})`,
    R: `rgba(197,11,11,${opacity})`,
    W: `rgba(191,191,191,${opacity})`,
  };
  return map[str] || "black";
}
