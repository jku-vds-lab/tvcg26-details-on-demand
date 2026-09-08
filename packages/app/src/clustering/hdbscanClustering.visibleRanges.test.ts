/**
 * visibleRanges as the visible-subset vocabulary (issue #315 A3 / P-d ledger
 * item 2, extended by P7 S5).
 *
 * Since S5 the server's `visibleRanges` do BOTH jobs on the provider path:
 *   - they resolve which points are visible (replacing the O(n) per-node
 *     `doiGroup === "annotation" | "inset"` scan, whose strings the baked-DoI
 *     path no longer writes), and
 *   - they are passed straight to `fitSubset` instead of recomputing
 *     `subsetLeafRanges` (they are the same vocabulary by contract, §6b).
 * A stale revision or an absent field falls back to the doiGroup filter and
 * the exact recompute — the client-complete lane never engages either.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFit = jest.fn();
jest.mock('src/workers/hdbscanWorkerProxy', () => ({
  hdbscanWorkerProxy: { fit: (...args: unknown[]) => mockFit(...args), cancel: jest.fn() },
}));

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
      search() { return this.items; }
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

const mockGetResidentField = jest.fn<() => unknown>(() => null);
const mockGetLastDoiRevision = jest.fn<() => number | null>(() => null);
jest.mock('../doiPropagation/serverPropagation', () => ({
  getResidentField: () => mockGetResidentField(),
  getLastDoiRevision: () => mockGetLastDoiRevision(),
}));

import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import { bumpClusteringEpoch, runHdbscanClustering } from './hdbscanClustering';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from '../store';

/**
 * Six points. The per-node `doiGroup` strings say records 0..3 are visible —
 * they are the LEGACY signal, and the tests below use a REVERSED leaf order so
 * the two vocabularies disagree: the same leaf ranges [[0,4)] resolve to
 * records 2..5 through the leaf order, and `subsetLeafRanges` over records
 * 0..3 produces [[2,6)]. Whichever the implementation used is therefore
 * unambiguous in the assertions.
 */
function makeNodes(): DataPoint[] {
  return Array.from({ length: 6 }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: i / 6, y: i / 6, id: i + 1, line: 0, DoI: 1,
    doiGroup: (i < 4 ? 'inset' : 'gray') as 'inset' | 'gray',
  }));
}

/** Reversed full leaf order: leaf position p holds record 5 - p. */
const REVERSED_ORDER = [5, 4, 3, 2, 1, 0];

/** A subset-fit-capable provider (no cut capability engaged on a subset). */
function makeProvider(fittedOrder: number[]) {
  const fitProvider = {
    fit: 'F1',
    // The fitted leaf order in ORIGINAL dataset indices (all in the subset).
    getLeafOrder: jest.fn(async () => fittedOrder),
  };
  const provider = {
    getLeafOrder: jest.fn(async () => REVERSED_ORDER),
    fitSubset: jest.fn(async () => ({ fitId: 'F1', n: fittedOrder.length })),
    withFit: jest.fn(() => fitProvider),
  };
  return { provider, fitProvider };
}

const RESIDENT = (visibleRanges: Array<[number, number]>, revision = 7) => ({
  revision,
  focusActive: true,
  nLeaves: 6,
  recordDist: new Float32Array(6),
  visibleRanges,
});

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  mockGetResidentField.mockReset().mockReturnValue(null);
  mockGetLastDoiRevision.mockReset().mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

describe('visibleRanges drive the visible subset (P7 S5)', () => {
  it('resolves the subset from the ranges, not from the doiGroup strings', async () => {
    // Ranges [[0,4)] over the reversed order ⇒ records 5,4,3,2 ⇒ sorted 2..5.
    const { provider, fitProvider } = makeProvider([2, 3, 4, 5]);
    mockResolveCutProvider.mockReturnValue(provider);
    mockGetResidentField.mockReturnValue(RESIDENT([[0, 4]], 7));
    mockGetLastDoiRevision.mockReturnValue(7);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(), undefined, epoch);

    // The resident ranges went to the server verbatim (no recompute, which
    // over records 0..3 would have produced [[2,6]] instead).
    expect(provider.fitSubset).toHaveBeenCalledWith('points', [[0, 4]]);
    // The fitted tree was hydrated against the RANGE-derived subset.
    expect(fitProvider.getLeafOrder).toHaveBeenCalledWith('points');
    // No client worker fit anywhere on this path.
    expect(mockFit).not.toHaveBeenCalled();
  });

  it('a flood-sized visible count routes to the full tree without materializing it', async () => {
    // Above FLOOD_SUBSET_MAX_POINTS (100k) the count ALONE decides the route,
    // so the O(visible) index walk never runs — that skip is the point of
    // resolving the count from the ranges before materializing anything.
    const n = 120_000;
    const big: DataPoint[] = Array.from({ length: n }, (_, i) => ({
      ...createEmptyDataPoint(),
      x: i, y: 0, id: i + 1, line: 0, DoI: 1,
      doiGroup: 'inset' as const,
    }));
    const bigOrder = Array.from({ length: n }, (_, i) => i);
    const provider = {
      getLeafOrder: jest.fn(async () => bigOrder),
      fitSubset: jest.fn(async () => ({ fitId: 'F1', n: 0 })),
      withFit: jest.fn(() => ({ getLeafOrder: jest.fn(async () => []) })),
    };
    mockResolveCutProvider.mockReturnValue(provider);
    mockGetResidentField.mockReturnValue({
      revision: 7, focusActive: true, nLeaves: n,
      recordDist: new Float32Array(0),
      visibleRanges: [[0, 110_000]] as Array<[number, number]>,
    });
    mockGetLastDoiRevision.mockReturnValue(7);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(big, undefined, epoch);

    expect(provider.fitSubset).not.toHaveBeenCalled();
    expect(mockFit).not.toHaveBeenCalled();
    // getLeafOrder ran ONCE — for the full-tree server cut, not for a subset
    // materialization that the flood route would have thrown away.
    expect(provider.getLeafOrder).toHaveBeenCalledTimes(1);
  });

  it('falls back to the doiGroup filter + recompute when the revision is stale', async () => {
    // Legacy path: doiGroup says records 0..3, recompute over the reversed
    // order yields [[2,6]] — the discriminator against the ranges path.
    const { provider } = makeProvider([0, 1, 2, 3]);
    mockResolveCutProvider.mockReturnValue(provider);
    mockGetResidentField.mockReturnValue(RESIDENT([[0, 4]], 5)); // rev 5
    mockGetLastDoiRevision.mockReturnValue(7); // latest is 7 → stale

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(), undefined, epoch);

    expect(provider.getLeafOrder).toHaveBeenCalledWith('points');
    expect(provider.fitSubset).toHaveBeenCalledWith('points', [[2, 6]]);
  });

  it('falls back when no resident field exists (graph path / before any commit)', async () => {
    const { provider } = makeProvider([0, 1, 2, 3]);
    mockResolveCutProvider.mockReturnValue(provider);
    // getResidentField stays null (beforeEach default).

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(), undefined, epoch);

    expect(provider.getLeafOrder).toHaveBeenCalledWith('points');
    expect(provider.fitSubset).toHaveBeenCalledWith('points', [[2, 6]]);
  });

  it('falls back when the server shipped no ranges at all', async () => {
    const { provider } = makeProvider([0, 1, 2, 3]);
    mockResolveCutProvider.mockReturnValue(provider);
    mockGetResidentField.mockReturnValue(RESIDENT([], 7));
    mockGetLastDoiRevision.mockReturnValue(7);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(), undefined, epoch);

    expect(provider.fitSubset).toHaveBeenCalledWith('points', [[2, 6]]);
  });
});
