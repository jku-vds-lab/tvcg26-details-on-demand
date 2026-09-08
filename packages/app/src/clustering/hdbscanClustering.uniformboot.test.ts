/**
 * Uniform revision-0 boot (issue #315 A3 P-a): server-cut datasets skip the
 * O(n) boot DoI marking, so runHdbscanClustering must treat an UNWRITTEN
 * doiGroup ladder as uniformly visible when a cut provider resolves — the
 * census-identified regression is the visibleNodes filter yielding [] and
 * the empty-guard killing the boot clustering before the provider engages.
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

import { buildHdbscanHierarchy } from '../dataPreprocessing/hdbscanHierarchy';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  bumpClusteringEpoch,
  getNodeClusteringContext,
  isServerCutActive,
  runHdbscanClustering,
} from './hdbscanClustering';
import { buildGroupsFromActiveClusters } from '../hooks/cutDrivenGroups';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from '../store';

const POINTS = [
  { x: 0.10, y: 0.10 },
  { x: 0.12, y: 0.11 },
  { x: 0.11, y: 0.12 },
  { x: 0.80, y: 0.80 },
  { x: 0.82, y: 0.79 },
  { x: 0.81, y: 0.81 },
];

/** Nodes as they exist at boot on a server-cut dataset: NO doiGroup ever written. */
function makeUnmarkedNodes(): DataPoint[] {
  return POINTS.map((p, i) => {
    const node = {
      ...createEmptyDataPoint(),
      x: p.x,
      y: p.y,
      id: i + 1,
      line: 0,
      DoI: 1,
    } as DataPoint;
    delete node.doiGroup;
    return node;
  });
}

function makeCutProviderMock() {
  return {
    getLeafOrder: jest.fn(async () => POINTS.map((_, i) => i)),
  };
}

function mockWorkerFit() {
  mockFit.mockImplementation((...args: unknown[]) => {
    const coords = args[0] as number[][];
    const tree = buildHdbscanHierarchy(
      coords.map(([x, y]) => ({ x, y })),
      { minSamples: 1 }
    );
    return Promise.resolve({ tree });
  });
}

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

describe('uniform revision-0 boot (issue #315 A3 P-a)', () => {
  it('engages the server cut with an unwritten doiGroup ladder', async () => {
    const provider = makeCutProviderMock();
    mockResolveCutProvider.mockReturnValue(provider);
    const nodes = makeUnmarkedNodes();

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // The cut provider engaged (visibleNodes === nodes), no worker fit ran.
    expect(provider.getLeafOrder).toHaveBeenCalledWith('points');
    expect(isServerCutActive()).toBe(true);
    expect(mockFit).not.toHaveBeenCalled();

    // The grouping gate treats the unwritten ladder as "inset" in server-cut
    // mode (the 2026-07-24 regression: every member was dropped and no inset
    // ever mounted despite a live cut).
    const ctx = getNodeClusteringContext()!;
    const cluster = {
      uid: '0xF00',
      id: 0xf00,
      size: nodes.length,
      firstLeaf: 0,
      lastLeaf: nodes.length,
    } as unknown as ClusterTreeNode;
    const groups = buildGroupsFromActiveClusters([cluster], ctx.hierarchyId, 'inset', 1);
    expect(groups).not.toBeNull();
    expect(groups!.groups['0xF00']?.length).toBe(nodes.length);
    // Annotation-side grouping stays empty, exactly as the deleted boot
    // marking (all-"inset") produced.
    const annotation = buildGroupsFromActiveClusters([cluster], ctx.hierarchyId, 'annotation', 2);
    expect(annotation!.groups['0xF00']).toBeUndefined();
  });

  it('keeps the empty-guard for client datasets (no provider, no doiGroup)', async () => {
    const nodes = makeUnmarkedNodes();

    const epoch = bumpClusteringEpoch();
    const result = await runHdbscanClustering(nodes, undefined, epoch);

    // Without a provider the unwritten ladder still means "not visible" —
    // the pre-P-a semantics for client-complete datasets are untouched.
    expect(result.clusterCount).toBe(0);
    expect(mockFit).not.toHaveBeenCalled();
    expect(isServerCutActive()).toBe(false);
  });

  it('a written ladder still drops subsets out of resident server-cut mode', async () => {
    mockWorkerFit();
    const provider = makeCutProviderMock();
    mockResolveCutProvider.mockReturnValue(provider);
    const nodes = makeUnmarkedNodes();
    // Post-propagation state: some nodes grayed out.
    nodes.forEach((n, i) => { n.doiGroup = i < 3 ? 'inset' : 'gray'; });

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // Subset ⊊ dataset: resident cut must NOT engage; worker fit runs
    // (provider offers no fitSubset in this mock).
    expect(provider.getLeafOrder).not.toHaveBeenCalled();
    expect(isServerCutActive()).toBe(false);
    expect(mockFit).toHaveBeenCalledTimes(1);
  });
});
