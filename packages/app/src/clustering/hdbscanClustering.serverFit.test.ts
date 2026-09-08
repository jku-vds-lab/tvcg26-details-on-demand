/**
 * Server subset fit under the A1 async lifecycle (issue #315 P7 S4).
 *
 * The server fit now covers the whole 0–100k band and answers ASYNC: the
 * content-addressed fitId comes back immediately as BUILDING and the fitted
 * tree only serves once it is READY. So a lasso on a provider dataset must
 *
 *   1. keep the COARSE full-tree cut on screen while the fit builds,
 *   2. show the existing "Refining clusters…" chip,
 *   3. adopt the fit-scoped server cut when READY lands, under the same
 *      epoch + hierarchyId double gate the worker refine used,
 *   4. and NEVER spawn the client worker fit on that path.
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

import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  SERVER_SUBSET_FIT_MAX_POINTS,
  bumpClusteringEpoch,
  classifyVisibleSubset,
  getNodeClusteringContext,
  runHdbscanClustering,
} from './hdbscanClustering';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from '../store';
import { progressResetAll } from '../slices/progressSlice';

const TOTAL = 900;
const VISIBLE = 600;

function makeNodes(total: number, visible: number): DataPoint[] {
  return Array.from({ length: total }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: (i % 2 === 0 ? 0.1 : 0.8) + (i % 97) * 1e-4,
    y: (i % 3 === 0 ? 0.1 : 0.8) + (i % 89) * 1e-4,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: (i < visible ? 'inset' : 'gray') as DataPoint['doiGroup'],
  }));
}

/**
 * A provider that fits server-side under the A1 contract. `status` picks the
 * answer of the FIRST fitSubset call; `settle` releases a deferred awaitFit.
 */
function makeFitProvider(total: number, visible: number, status: 'building' | 'ready') {
  let releaseFit: ((s: string) => void) | null = null;
  const fitted = Array.from({ length: visible }, (_, i) => i); // original indices
  const fitProvider = {
    getLeafOrder: jest.fn(async () => fitted),
  };
  const provider = {
    getLeafOrder: jest.fn(async () => Array.from({ length: total }, (_, i) => i)),
    fitSubset: jest.fn(async () => ({ fitId: 'abc'.repeat(13) + 'd', n: visible, status })),
    withFit: jest.fn(() => fitProvider),
    awaitFit: jest.fn(
      () => new Promise<string>((resolve) => { releaseFit = resolve; })
    ),
  };
  return {
    provider,
    fitProvider,
    settle: (s: 'ready' | 'failed' | 'unknown' = 'ready') => releaseFit!(s),
    settled: () => releaseFit !== null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const refiningChipUp = () =>
  Object.values(store.getState().progress.tasks).some(
    (t) => t.phase === 'Refining clusters…'
  );

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(progressResetAll());
});

describe('server subset-fit cap (issue #315 P7 S4)', () => {
  it('raises the cap to 100k when the provider can fit server-side', () => {
    expect(SERVER_SUBSET_FIT_MAX_POINTS).toBe(100_000);
    expect(classifyVisibleSubset(50_000, 1_000_000, true, true)).toBe('exact');
    expect(classifyVisibleSubset(100_000, 1_000_000, true, true)).toBe('exact');
  });

  it('leaves the flood fallback above 100k', () => {
    expect(classifyVisibleSubset(100_001, 1_000_000, true, true)).toBe('flood-fallback');
  });

  it('keeps the old 5k worker boundary for a provider that cannot fit', () => {
    expect(classifyVisibleSubset(5_000, 1_000_000, true, false)).toBe('exact');
    expect(classifyVisibleSubset(5_001, 1_000_000, true, false)).toBe('coarse-first');
    expect(classifyVisibleSubset(50_000, 1_000_000, true, false)).toBe('coarse-first');
  });
});

describe('BUILDING fit: coarse stays, chip up, swap on READY', () => {
  it('cuts the full tree while the fit builds and adopts it when READY lands', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'building');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);

    // Coarse: the FULL server tree is the live cut, and the call already
    // returned — nothing waited for the fit.
    expect(harness.provider.fitSubset).toHaveBeenCalledTimes(1);
    expect(harness.provider.getLeafOrder).toHaveBeenCalledWith('points');
    const coarse = getNodeClusteringContext()!;
    expect(coarse.nodes.length).toBe(TOTAL);
    // The fitted tree was NOT asked for anything while building.
    expect(harness.fitProvider.getLeafOrder).not.toHaveBeenCalled();
    expect(refiningChipUp()).toBe(true);

    harness.settle('ready');
    await flush();

    const adopted = getNodeClusteringContext()!;
    expect(adopted.nodes.length).toBe(VISIBLE);
    expect(adopted.hierarchyId).toBe(coarse.hierarchyId + 1);
    expect(adopted.service).not.toBe(coarse.service);
    expect(harness.fitProvider.getLeafOrder).toHaveBeenCalledWith('points');
    expect(refiningChipUp()).toBe(false);
  });

  it('never spawns the client worker fit on the provider path', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'building');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);
    harness.settle('ready');
    await flush();

    expect(mockFit).not.toHaveBeenCalled();
  });

  it('abandons the swap when the clustering epoch moved on', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'building');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);
    const coarse = getNodeClusteringContext()!;

    bumpClusteringEpoch();
    harness.settle('ready');
    await flush();

    const after = getNodeClusteringContext()!;
    expect(after.hierarchyId).toBe(coarse.hierarchyId);
    expect(after.nodes.length).toBe(TOTAL);
    expect(refiningChipUp()).toBe(false);
  });

  it('abandons the swap when a newer clustering replaced the hierarchy', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'building');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);

    // Same epoch, but the whole dataset became visible and persisted its own
    // hierarchy in the meantime.
    await runHdbscanClustering(makeNodes(TOTAL, TOTAL), undefined, epoch);
    const newer = getNodeClusteringContext()!;

    harness.settle('ready');
    await flush();

    expect(getNodeClusteringContext()!.hierarchyId).toBe(newer.hierarchyId);
    expect(refiningChipUp()).toBe(false);
  });

  it('keeps the coarse cut and clears the chip when the fit fails', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'building');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);
    const coarse = getNodeClusteringContext()!;

    harness.settle('failed');
    await flush();

    expect(getNodeClusteringContext()!.hierarchyId).toBe(coarse.hierarchyId);
    expect(getNodeClusteringContext()!.nodes.length).toBe(TOTAL);
    expect(refiningChipUp()).toBe(false);
    expect(mockFit).not.toHaveBeenCalled();
  });
});

describe('READY fit (cache hit)', () => {
  it('cuts the fitted tree straight away, with no coarse phase and no chip', async () => {
    const harness = makeFitProvider(TOTAL, VISIBLE, 'ready');
    mockResolveCutProvider.mockReturnValue(harness.provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);
    await flush();

    const context = getNodeClusteringContext()!;
    expect(context.nodes.length).toBe(VISIBLE);
    expect(harness.fitProvider.getLeafOrder).toHaveBeenCalledWith('points');
    // The base leaf order is fetched ONCE, to describe the subset as ranges —
    // there is no second fetch for a coarse full-tree cut.
    expect(harness.provider.getLeafOrder).toHaveBeenCalledTimes(1);
    expect(harness.provider.awaitFit).not.toHaveBeenCalled();
    expect(refiningChipUp()).toBe(false);
    expect(mockFit).not.toHaveBeenCalled();
  });
});
