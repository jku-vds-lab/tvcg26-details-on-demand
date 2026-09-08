/**
 * Midpoint-side flood guard (issue #315 §10.2 package C).
 *
 * `runTrajectoryMidpointClustering` had NO size guard between the 5k server
 * subset-fit cap and infinity: with relationInsetBudget > 0 a DoI-filtered
 * midpoint set of 10^5–10^6 went straight into hdbscanWorkerProxy.fit —
 * minutes, AWAITED inside the selection workflow, blocking node insets too.
 * Both non-exact routes now take the FULL midpoint tree's server cut instead
 * (no background refine — see the comment at the guard).
 *
 * Guarded here: the flood and coarse-first routes take the full-tree branch
 * without a worker fit, the no-provider path keeps its blocking fit, and the
 * budget-0 skip still runs before everything.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFit = jest.fn();
jest.mock('src/workers/hdbscanWorkerProxy', () => ({
  hdbscanWorkerProxy: { fit: (...args: unknown[]) => mockFit(...args), cancel: jest.fn() },
}));

// Mock rbush (ESM) to avoid transform issues in Jest.
jest.mock('rbush', () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

const mockResolveCutProvider = jest.fn<() => unknown>(() => null);
jest.mock('@scaling', () => ({
  resolveCutProvider: (...args: unknown[]) =>
    (mockResolveCutProvider as (...a: unknown[]) => unknown)(...args),
  resolveInsetProvider: () => null,
  hasLiveCutSubscription: () => false,
  warmBootCut: () => () => {},
}));

import type { DataPoint, TrajectoryMidpoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import {
  bumpClusteringEpoch,
  getMidpointClusteringContext,
  runTrajectoryMidpointClustering,
} from './hdbscanClustering';
import store, { initialClusterSettings, updateClusterSettings } from '../store';

const DOI_THRESHOLD = 0.5;

const hot: DataPoint = { ...createEmptyDataPoint(), DoI: 1 };
const cold: DataPoint = { ...createEmptyDataPoint(), DoI: 0 };

/** `total` midpoints of which the first `filtered` clear DOI_THRESHOLD. */
function makeMidpoints(total: number, filtered: number): TrajectoryMidpoint[] {
  return Array.from({ length: total }, (_, i) => {
    const selected = i < filtered;
    return {
      id: i + 1,
      midPoint: { x: (i % 997) / 997, y: (i % 991) / 991 },
      startPoint: selected ? hot : cold,
      endPoint: selected ? hot : cold,
      action: '',
      DoI: selected ? 1 : 0,
    };
  });
}

function makeCutProviderMock(total: number) {
  return {
    getLeafOrder: jest.fn(async () => Array.from({ length: total }, (_, i) => i)),
  };
}

/** Lightweight leafIndex-only tree, exactly what the HDBSCAN worker returns. */
function makeLightweightTree(n: number): ClusterTreeNode {
  let nextId = 0;
  const build = (lo: number, hi: number): ClusterTreeNode => {
    const id = nextId++;
    const node: ClusterTreeNode = {
      id,
      uid: `0x${id.toString(16)}`,
      distance: hi - lo,
      size: hi - lo,
      stability: hi - lo,
    };
    if (hi - lo <= 1) {
      node.leafIndex = lo;
      node.stability = 1;
    } else {
      const mid = (lo + hi) >> 1;
      node.leftChild = build(lo, mid);
      node.rightChild = build(mid, hi);
    }
    return node;
  };
  return build(0, n);
}

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  // The edge pipeline is off by default (#261) — every non-budget test needs it on.
  store.dispatch(updateClusterSettings({ ...initialClusterSettings, relationInsetBudget: 4 }));
});

describe('runTrajectoryMidpointClustering flood guard', () => {
  it('cuts the full midpoint tree for a >100k filtered set instead of fitting', async () => {
    const TOTAL = 100_002;
    const FILTERED = 100_001;
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);

    const epoch = bumpClusteringEpoch();
    await runTrajectoryMidpointClustering(
      makeMidpoints(TOTAL, FILTERED),
      DOI_THRESHOLD,
      undefined,
      epoch
    );

    expect(mockFit).not.toHaveBeenCalled();
    expect(provider.getLeafOrder).toHaveBeenCalledWith('midpoints');
    // The persisted context covers the FULL midpoint array, not the subset.
    expect(getMidpointClusteringContext()!.midpoints.length).toBe(TOTAL);
  }, 120_000);

  it('takes the same full-tree branch in the coarse-first band', async () => {
    const TOTAL = 7000;
    const FILTERED = 6000;
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);

    const epoch = bumpClusteringEpoch();
    await runTrajectoryMidpointClustering(
      makeMidpoints(TOTAL, FILTERED),
      DOI_THRESHOLD,
      undefined,
      epoch
    );

    // No background refine on the edge side, by design.
    expect(mockFit).not.toHaveBeenCalled();
    expect(provider.getLeafOrder).toHaveBeenCalledWith('midpoints');
    expect(getMidpointClusteringContext()!.midpoints.length).toBe(TOTAL);
  });

  it('leaves the no-provider path on its blocking worker fit', async () => {
    mockResolveCutProvider.mockReturnValue(null);
    mockFit.mockImplementation(() => Promise.resolve({ tree: makeLightweightTree(200) }));

    const epoch = bumpClusteringEpoch();
    await runTrajectoryMidpointClustering(makeMidpoints(300, 200), DOI_THRESHOLD, undefined, epoch);

    expect(mockFit).toHaveBeenCalledTimes(1);
    expect((mockFit.mock.calls[0] as unknown[])[0] as number[][]).toHaveLength(200);
    // Still the DoI-filtered subset — no reroute without a provider.
    expect(getMidpointClusteringContext()!.midpoints.length).toBe(200);
  });

  it('keeps the budget-0 skip ahead of the guard', async () => {
    const provider = makeCutProviderMock(7000);
    mockResolveCutProvider.mockReturnValue(provider);
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, relationInsetBudget: 0 }));

    const epoch = bumpClusteringEpoch();
    const result = await runTrajectoryMidpointClustering(
      makeMidpoints(7000, 6000),
      DOI_THRESHOLD,
      undefined,
      epoch
    );

    expect(mockFit).not.toHaveBeenCalled();
    expect(provider.getLeafOrder).not.toHaveBeenCalled();
    expect(getMidpointClusteringContext()).toBeNull();
    expect(result.clusterCount).toBe(0);
  });
});
