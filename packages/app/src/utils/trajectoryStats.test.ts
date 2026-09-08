import { describe, expect, it } from '@jest/globals';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  computeMedianTrajectoryLength,
  getMedianTrajectoryLength,
  setMedianTrajectoryLength,
  subscribeMedianTrajectoryLength,
} from './trajectoryStats';

const rows = (lines: number[]): DataPoint[] =>
  lines.map((line, i) => ({ id: i, line } as unknown as DataPoint));

describe('computeMedianTrajectoryLength', () => {
  it('takes the median of the per-line state counts', () => {
    // Lengths 3, 2, 1 → sorted [1, 2, 3] → median 2.
    expect(computeMedianTrajectoryLength(rows([0, 0, 0, 1, 1, 2]))).toBe(2);
  });

  it('is 1 for one-state-per-line datasets (mnist/fashion regime)', () => {
    expect(computeMedianTrajectoryLength(rows([0, 1, 2, 3]))).toBe(1);
  });

  it('is 1 for an empty dataset', () => {
    expect(computeMedianTrajectoryLength([])).toBe(1);
  });
});

describe('median-trajectory-length store', () => {
  it('set/get round-trips and notifies subscribers once per change', () => {
    const initial = getMedianTrajectoryLength();
    let calls = 0;
    const unsub = subscribeMedianTrajectoryLength(() => calls++);
    try {
      setMedianTrajectoryLength(42);
      expect(getMedianTrajectoryLength()).toBe(42);
      setMedianTrajectoryLength(42); // no-op: same value
      expect(calls).toBe(1);
      // Garbage guards: non-finite / sub-1 values fall to the placeholder.
      setMedianTrajectoryLength(NaN);
      expect(getMedianTrajectoryLength()).toBeGreaterThanOrEqual(1);
    } finally {
      unsub();
      setMedianTrajectoryLength(initial);
    }
  });
});
