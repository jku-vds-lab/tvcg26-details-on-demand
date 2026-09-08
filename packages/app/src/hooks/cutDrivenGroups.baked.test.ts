/**
 * Cut-driven member grouping under server-baked DoI (issue #315 P7 S5).
 *
 * The member gate used to read a per-node `doiGroup` STRING that a 1M-write
 * apply loop produced. On the provider path that loop is gone: the gate now
 * EVALUATES the same four-band ladder from the adopted f32 DoI column, at
 * dozens-of-actives cost. This suite pins that the split is identical to what
 * the written strings produced, that stale strings are ignored while baked,
 * and that clearing the bake restores the string read verbatim (the
 * client-complete lane).
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

import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import { attachPointColumns } from 'src/dataPreprocessing/pointColumns';
import { clearBakedDoi, isDoiBaked } from 'src/doiPropagation/bakedDoi';
import { applyOverlay, resetServerDoiState } from 'src/doiPropagation/serverPropagation';
import type { ClusterTreeNode } from 'src/clustering/ExtendedHDBSCAN';
import {
  bumpClusteringEpoch,
  getNodeClusteringContext,
  runHdbscanClustering,
} from 'src/clustering/hdbscanClustering';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from 'src/store';
import { buildGroupsFromActiveClusters } from './cutDrivenGroups';

const N = 4;
const THRESHOLDS = {
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

/** Server-cut boot state: column-backed points, no doiGroup ever written. */
function makeNodes(): DataPoint[] {
  const nodes = Array.from({ length: N }, (_, i) => {
    const node = {
      ...createEmptyDataPoint(),
      x: i / N,
      y: i / N,
      id: i + 1,
      line: 0,
      DoI: 1,
    } as DataPoint;
    delete node.doiGroup;
    return node;
  });
  attachPointColumns(nodes);
  return nodes;
}

/** Fresh node per test: the member cache is a WeakMap keyed by cluster
 * IDENTITY, so a shared literal would leak one test's members into the next. */
const makeCluster = () =>
  ({
    uid: '0xF00',
    id: 0xf00,
    size: N,
    firstLeaf: 0,
    lastLeaf: N,
  }) as unknown as ClusterTreeNode;

/** DoI 0.0 / 0.3 / 0.8 / 0.95 ⇒ gray / transparent / annotation / inset. */
const OVERLAY = {
  revision: 1,
  focusActive: true,
  runs: [[0, N]] as Array<[number, number]>,
  values: Float32Array.from([0.0, 0.3, 0.8, 0.95]),
  visibleRanges: [] as Array<[number, number]>,
};

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  resetServerDoiState();
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

async function bootServerCut(nodes: DataPoint[]) {
  mockResolveCutProvider.mockReturnValue({
    getLeafOrder: jest.fn(async () => nodes.map((_n, i) => i)),
  });
  const epoch = bumpClusteringEpoch();
  await runHdbscanClustering(nodes, undefined, epoch);
  const ctx = getNodeClusteringContext();
  expect(ctx).not.toBeNull();
  return ctx!;
}

describe('buildGroupsFromActiveClusters under baked DoI', () => {
  it('splits members by the evaluated ladder, ignoring stale doiGroup strings', async () => {
    const nodes = makeNodes();
    const ctx = await bootServerCut(nodes);

    applyOverlay(nodes, nodes.map((_n, i) => i), OVERLAY, THRESHOLDS);
    expect(isDoiBaked()).toBe(true);
    // Strings left over from an earlier client-owned pass: must not be read.
    nodes.forEach((n) => { n.doiGroup = 'gray'; });

    const cluster = makeCluster();
    const annotation = buildGroupsFromActiveClusters([cluster], ctx.hierarchyId, 'annotation', 1);
    const inset = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1);
    expect(annotation!.groups['0xF00']?.map((p) => p.id)).toEqual([3]); // DoI 0.8
    expect(inset!.groups['0xF00']?.map((p) => p.id)).toEqual([4]);      // DoI 0.95
  });

  it('a full-membership group still carries the leaf-range marker', async () => {
    const nodes = makeNodes();
    const ctx = await bootServerCut(nodes);
    // Every member lands in the inset band ⇒ the gate keeps all of them.
    applyOverlay(
      nodes,
      nodes.map((_n, i) => i),
      { ...OVERLAY, values: Float32Array.from([1, 1, 1, 1]) },
      THRESHOLDS
    );

    const inset = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1);
    const pts = inset!.groups['0xF00']!;
    expect(pts.length).toBe(N);
    expect((pts as unknown as { __leafRange?: unknown }).__leafRange).toEqual({
      tree: 'points',
      ranges: [[0, N]],
      fit: undefined,
      // Range digests must never equate ranges across hierarchies (issue
      // #315 insets-at-boot I2).
      hierarchyId: ctx.hierarchyId,
    });
  });

  it('clearing the bake restores the per-node string read (client-complete lane)', async () => {
    const nodes = makeNodes();
    const ctx = await bootServerCut(nodes);
    applyOverlay(nodes, nodes.map((_n, i) => i), OVERLAY, THRESHOLDS);
    clearBakedDoi();
    // With no bake the gate reads the strings; server-cut mode maps an
    // UNWRITTEN ladder to "inset" (the uniform revision-0 boot rule).
    nodes.forEach((n, i) => { if (i < 2) n.doiGroup = 'annotation'; });

    const annotation = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'annotation', 3);
    const inset = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 3);
    expect(annotation!.groups['0xF00']?.map((p) => p.id)).toEqual([1, 2]);
    expect(inset!.groups['0xF00']?.map((p) => p.id)).toEqual([3, 4]);
  });
});
