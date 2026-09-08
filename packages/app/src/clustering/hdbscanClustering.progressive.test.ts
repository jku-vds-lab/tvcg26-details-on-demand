/**
 * Progressive node clustering (issue #315 §10.2 package A).
 *
 * A DoI-filtered subset in the 5k…100k "fit band" has no instant exact path:
 * the server subset fit caps at 5k and the worker fit takes minutes, and
 * NOTHING downstream (insets, hulls) can appear until it resolves. The band
 * therefore cuts the server's full-dataset hierarchy immediately and refines
 * to the exact subset fit in the background.
 *
 * Covered here: (a) the band predicate, (b) the refine's swap guards — a
 * stale epoch or a hierarchy id that moved on must never clobber whatever ran
 * in the meantime.
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

import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import {
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

// Just over SERVER_SUBSET_FIT_MAX_POINTS (5000) so the subset lands in the
// band, and strictly below the dataset so the resident cut cannot be used.
const TOTAL = 5300;
const VISIBLE = 5100;

function makeNodes(total: number, visible: number): DataPoint[] {
  return Array.from({ length: total }, (_, i) => ({
    ...createEmptyDataPoint(),
    // Two well-separated blobs so the fitted tree is not degenerate.
    x: (i % 2 === 0 ? 0.1 : 0.8) + (i % 97) * 1e-4,
    y: (i % 3 === 0 ? 0.1 : 0.8) + (i % 89) * 1e-4,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: (i < visible ? 'inset' : 'gray') as DataPoint['doiGroup'],
  }));
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

function makeCutProviderMock(total: number) {
  return {
    getLeafOrder: jest.fn(async () => Array.from({ length: total }, (_, i) => i)),
  };
}

/** Hands back the resolve handle of the pending background worker fit. */
function deferWorkerFit(): { resolve: (tree: ClusterTreeNode) => void; coords: () => number[][] } {
  let resolveFit: ((r: { tree: ClusterTreeNode }) => void) | null = null;
  let seenCoords: number[][] = [];
  mockFit.mockImplementation((...args: unknown[]) => {
    seenCoords = args[0] as number[][];
    return new Promise((res) => {
      resolveFit = res as (r: { tree: ClusterTreeNode }) => void;
    });
  });
  return {
    resolve: (tree) => resolveFit!({ tree }),
    coords: () => seenCoords,
  };
}

/** Let the fire-and-forget refine run its continuations to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(progressResetAll());
});

/** The `refining` chip of the three-chip taxonomy (issue #315 P7 A5). */
const refiningChipUp = () =>
  Object.values(store.getState().progress.tasks).some(
    (t) => t.phase === 'Refining clusters…'
  );

describe('classifyVisibleSubset (band predicate)', () => {
  it('routes a 4k subset to the exact path (server subset fit)', () => {
    expect(classifyVisibleSubset(4_000, 1_000_000, true)).toBe('exact');
  });

  it('routes a 50k subset to coarse-first', () => {
    expect(classifyVisibleSubset(50_000, 1_000_000, true)).toBe('coarse-first');
  });

  it('routes a 150k subset to the flood fallback (no refine)', () => {
    expect(classifyVisibleSubset(150_000, 1_000_000, true)).toBe('flood-fallback');
  });

  it('leaves the full set on the exact path (resident server cut)', () => {
    expect(classifyVisibleSubset(1_000_000, 1_000_000, true)).toBe('exact');
  });

  it('never reroutes without a cut provider', () => {
    expect(classifyVisibleSubset(50_000, 1_000_000, false)).toBe('exact');
    expect(classifyVisibleSubset(150_000, 1_000_000, false)).toBe('exact');
  });

  // Boundary: the cap itself still fits the server fit.
  it('keeps the 5000-point cap on the exact path', () => {
    expect(classifyVisibleSubset(5_000, 1_000_000, true)).toBe('exact');
    expect(classifyVisibleSubset(5_001, 1_000_000, true)).toBe('coarse-first');
  });
});

describe('coarse-first routing + background refine', () => {
  it('cuts the full tree immediately and swaps the exact subset fit in', async () => {
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);
    const fit = deferWorkerFit();
    const nodes = makeNodes(TOTAL, VISIBLE);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // Coarse: the FULL tree was cut server-side, and the call already
    // returned — the exact fit is still running.
    expect(provider.getLeafOrder).toHaveBeenCalledWith('points');
    const coarse = getNodeClusteringContext()!;
    expect(coarse.nodes.length).toBe(TOTAL);
    expect(mockFit).toHaveBeenCalledTimes(1);
    // …over the TRUE subset, not the full dataset.
    expect(fit.coords().length).toBe(VISIBLE);

    fit.resolve(makeLightweightTree(VISIBLE));
    await flush();

    const refined = getNodeClusteringContext()!;
    expect(refined.nodes.length).toBe(VISIBLE);
    expect(refined.hierarchyId).toBe(coarse.hierarchyId + 1);
    expect(refined.service).not.toBe(coarse.service);
  });

  it('abandons the swap when the clustering epoch moved on', async () => {
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);
    const fit = deferWorkerFit();
    const nodes = makeNodes(TOTAL, VISIBLE);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);
    const coarse = getNodeClusteringContext()!;

    // A newer selection starts (the real proxy would abort the worker; the
    // mocked one resolves anyway, which is the harder case to survive).
    bumpClusteringEpoch();
    fit.resolve(makeLightweightTree(VISIBLE));
    await flush();

    const after = getNodeClusteringContext()!;
    expect(after.hierarchyId).toBe(coarse.hierarchyId);
    expect(after.nodes.length).toBe(TOTAL);
  });

  it('abandons the swap when a newer clustering replaced the hierarchy', async () => {
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);
    const fit = deferWorkerFit();
    const nodes = makeNodes(TOTAL, VISIBLE);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // Same epoch, but a second pass (here: the whole dataset visible) has
    // already persisted its own hierarchy.
    const fullNodes = makeNodes(TOTAL, TOTAL);
    await runHdbscanClustering(fullNodes, undefined, epoch);
    const newer = getNodeClusteringContext()!;

    fit.resolve(makeLightweightTree(VISIBLE));
    await flush();

    const after = getNodeClusteringContext()!;
    expect(after.hierarchyId).toBe(newer.hierarchyId);
    expect(after.nodes.length).toBe(TOTAL);
  });

  it('queues no refine when the subset fits the server (≤5000)', async () => {
    const provider = makeCutProviderMock(400);
    mockResolveCutProvider.mockReturnValue(provider);
    mockFit.mockImplementation(() => Promise.resolve({ tree: makeLightweightTree(300) }));
    const nodes = makeNodes(400, 300);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);
    await flush();

    // No provider fitSubset in this mock ⇒ the classic BLOCKING worker fit
    // ran once, on the subset, and no full-tree leaf order was fetched.
    expect(provider.getLeafOrder).not.toHaveBeenCalled();
    expect(mockFit).toHaveBeenCalledTimes(1);
    expect(getNodeClusteringContext()!.nodes.length).toBe(300);
  });
});

/**
 * A5 verification: the fit chip is set at the CAUSE (the background fit is
 * dispatched) and cleared at the EFFECT (the fitted frame applies, or the swap
 * is revoked). No timer sits between the two — the task carries no minShowMs.
 */
describe('refining chip (A5 taxonomy)', () => {
  it('is up from fit dispatch until the fitted frame applies', async () => {
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);
    const fit = deferWorkerFit();

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);

    // Cause time: the coarse cut is already live and the fit is in flight.
    expect(refiningChipUp()).toBe(true);
    const task = Object.values(store.getState().progress.tasks).find(
      (t) => t.phase === 'Refining clusters…'
    )!;
    expect(task.minShowMs).toBeUndefined();

    fit.resolve(makeLightweightTree(VISIBLE));
    await flush();

    // Effect time: the refined hierarchy is the live one.
    expect(getNodeClusteringContext()!.nodes.length).toBe(VISIBLE);
    expect(refiningChipUp()).toBe(false);
  });

  it('clears when the swap is revoked by a newer epoch', async () => {
    const provider = makeCutProviderMock(TOTAL);
    mockResolveCutProvider.mockReturnValue(provider);
    const fit = deferWorkerFit();

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(TOTAL, VISIBLE), undefined, epoch);
    expect(refiningChipUp()).toBe(true);

    bumpClusteringEpoch();
    fit.resolve(makeLightweightTree(VISIBLE));
    await flush();
    expect(refiningChipUp()).toBe(false);
  });

  it('never appears on the blocking path (no background refine, no chip)', async () => {
    const provider = makeCutProviderMock(400);
    mockResolveCutProvider.mockReturnValue(provider);
    mockFit.mockImplementation(() => Promise.resolve({ tree: makeLightweightTree(300) }));

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(400, 300), undefined, epoch);
    await flush();
    expect(refiningChipUp()).toBe(false);
  });
});
