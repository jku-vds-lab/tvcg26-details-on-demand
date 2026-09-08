// src/utils/trajectoryStats.ts
//
// Per-dataset trajectory statistics for the reach-linear chain sliders
// (CS 2026-08-17 third feel pass): the Backward/Forward thumbs are linear in
// the FRACTION OF A TRAJECTORY the chain visibly reaches, which needs the
// dataset's typical trajectory length. Computed once per dataset load
// (useInitialDataset.computeDefaultsAsync — one O(n) pass over the line
// column) and held in a tiny module store, the liveSliderSettingsStore
// pattern: derived state, deliberately NOT in Redux and NOT deep-linked.

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";

/** Placeholder before the first dataset lands (a mid-scale guess; the real
 * value replaces it in the same load tick that computes maxEmbeddingDistance). */
const DEFAULT_MEDIAN_TRAJECTORY_LENGTH = 20;

let medianTrajectoryLength = DEFAULT_MEDIAN_TRAJECTORY_LENGTH;
const listeners = new Set<() => void>();

/** Median number of states per trajectory (line) — ≥ 1. */
export function getMedianTrajectoryLength(): number {
  return medianTrajectoryLength;
}

export function setMedianTrajectoryLength(value: number): void {
  const next = Number.isFinite(value) && value >= 1 ? value : DEFAULT_MEDIAN_TRAJECTORY_LENGTH;
  if (next === medianTrajectoryLength) return;
  medianTrajectoryLength = next;
  for (const listener of listeners) listener();
}

export function subscribeMedianTrajectoryLength(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Median trajectory (line) length of a dataset — columnar fast path, row
 * fallback. Datasets with one state per line (mnist/fashion) yield 1: the
 * chain is inert there and the slider mapping degrades gracefully.
 */
export function computeMedianTrajectoryLength(points: DataPoint[]): number {
  const n = points.length;
  if (n === 0) return 1;
  const counts = new Map<number, number>();
  const cols = columnsOf(points);
  if (cols) {
    const line = cols.line;
    for (let i = 0; i < n; i++) {
      const ln = line[i];
      counts.set(ln, (counts.get(ln) ?? 0) + 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ln = points[i].line;
      counts.set(ln, (counts.get(ln) ?? 0) + 1);
    }
  }
  const lengths = Array.from(counts.values()).sort((a, b) => a - b);
  return lengths[Math.floor(lengths.length / 2)];
}
