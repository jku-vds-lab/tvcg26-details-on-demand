/**
 * THE member seam under row-lazy boot (issue #315 R1b → R1c, plan §4):
 * `buildGroupsFromActiveClusters` is the one place a select frame becomes a
 * group array. Under R1c it resolves NO member rows while the canonical
 * array's rows are not resident — the group is a HOLEY array whose
 * membership lives in the groupMembers spec, and the bounded consumers
 * materialize exactly their samples through the spec's `rowAt` accessors.
 *
 * Pinned here:
 *   (1) an active cluster over the hole region builds with the right count
 *       and ZERO slot writes — and ZERO canonical materialization (R1b
 *       resolved every member here; that walk repaid the whole deferred
 *       materialization at the boot view, plan §4 R1b Finding 2),
 *   (2) members resolve on demand through groupMemberRowAt with the
 *       canonical column values, memoized one instance per index,
 *   (3) identity is stable across rebuilds (spec compare + rowAt
 *       memoization), and the full-membership leaf-range marker still lands.
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

import { groupMemberRowAt, groupMembersOf } from 'src/clustering/groupMembers';
import { buildHdbscanHierarchy } from 'src/dataPreprocessing/hdbscanHierarchy';
import type { PointColumns as SidecarPointColumns } from 'src/dataPreprocessing/columnSidecar';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import { createLazyRowArray } from 'src/dataPreprocessing/lazyRows';
import { columnsFromSidecar } from 'src/dataPreprocessing/pointColumns';
import type { ClusterTreeNode } from 'src/clustering/ExtendedHDBSCAN';
import {
  bumpClusteringEpoch,
  getNodeClusteringContext,
  runHdbscanClustering,
} from 'src/clustering/hdbscanClustering';
import { resetServerDoiState } from 'src/doiPropagation/serverPropagation';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from 'src/store';
import { buildGroupsFromActiveClusters } from './cutDrivenGroups';

const N = 240; // > the 200-row eager prefix, so the cluster below spans holes

function sidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint32Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i / N;
    y[i] = i / N;
    line[i] = 0;
    id[i] = i + 1;
  }
  return { count: N, byName: { x, y, line, id } };
}

function lazyNodes(): DataPoint[] {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error('fixture sidecar must produce columns');
  return createLazyRowArray([], sc, cols);
}

/** The tail of the array — entirely inside the hole region. */
const FIRST = 210;
const makeCluster = () =>
  ({
    uid: '0xLAZY',
    id: 0x1a20,
    size: N - FIRST,
    firstLeaf: FIRST,
    lastLeaf: N,
  }) as unknown as ClusterTreeNode;

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  resetServerDoiState();
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

async function bootServerCut(nodes: DataPoint[]) {
  mockResolveCutProvider.mockReturnValue({
    getLeafOrder: jest.fn(async () => Array.from({ length: N }, (_v, i) => i)),
  });
  const epoch = bumpClusteringEpoch();
  await runHdbscanClustering(nodes, undefined, epoch);
  const ctx = getNodeClusteringContext();
  expect(ctx).not.toBeNull();
  return ctx!;
}

describe('buildGroupsFromActiveClusters over a row-lazy array (R1c)', () => {
  it('builds an index-backed group with zero slot writes and zero canonical materialization', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);

    const inset = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1);
    const pts = inset!.groups['0xLAZY'];
    expect(pts).toBeDefined();
    expect(pts!.length).toBe(N - FIRST);
    // No member row was built: neither the group slots nor the canonical
    // array hold anything for the cluster's range.
    for (let k = 0; k < pts!.length; k++) expect(k in pts!).toBe(false);
    // (N-1 is the eager columnsOf endpoint probe — always resident.)
    for (let i = FIRST; i < N - 1; i++) expect(i in nodes).toBe(false);
    expect(groupMembersOf(pts!)).toBeDefined();
  });

  it('resolves members on demand through the spec with canonical values', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);
    const pts = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1)!
      .groups['0xLAZY']!;

    const first = groupMemberRowAt(pts, 0)!;
    expect(first.id).toBe(FIRST + 1);
    expect(first.x).toBeCloseTo(FIRST / N);
    const last = groupMemberRowAt(pts, pts.length - 1)!;
    expect(last.id).toBe(N);
    // Resolution is memoized into the CANONICAL array (one instance per
    // index) — the group slots stay holes.
    expect(nodes[FIRST]).toBe(first);
    expect(0 in pts).toBe(false);
    // Only the asked-for members were built.
    for (let i = FIRST + 1; i < N - 1; i++) expect(i in nodes).toBe(false);
  });

  it('keeps identity stable across rebuilds and carries the leaf range', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);

    const first = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1)!
      .groups['0xLAZY']!;
    // A distinct cluster node (the member cache is keyed by cluster identity)
    // must resolve the SAME row instances through its spec.
    const second = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1)!
      .groups['0xLAZY']!;
    expect(groupMemberRowAt(second, 0)).toBe(groupMemberRowAt(first, 0));

    expect((first as unknown as { __leafRange?: { ranges: number[][] } }).__leafRange?.ranges)
      .toEqual([[FIRST, N]]);
  });

  it('builds no annotation-side groups at the uniform boot', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);
    const ann = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'annotation', 1);
    expect(ann!.groups['0xLAZY']).toBeUndefined();
  });
});

describe('client lazy lane (issue #315 R3d): unwritten ladder = uniform boot', () => {
  async function bootClientLazy(nodes: DataPoint[]) {
    mockFit.mockImplementation((...args: unknown[]) => {
      const coords = args[0] as number[][];
      const tree = buildHdbscanHierarchy(
        coords.map(([x, y]) => ({ x, y })),
        { minSamples: 1 }
      );
      return Promise.resolve({ tree });
    });
    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);
    const ctx = getNodeClusteringContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.service.serverCutMode).toBe(false);
    return ctx!;
  }

  it('builds FULL range inset groups pre-residency (2026-08-05 regression: undefinedGroup keyed on serverCutMode alone, every spec built empty, no inset ever mounted)', async () => {
    const nodes = lazyNodes();
    const ctx = await bootClientLazy(nodes);

    const inset = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'inset', 1);
    const pts = inset!.groups['0xLAZY'];
    expect(pts).toBeDefined();
    expect(pts!.length).toBe(N - FIRST);
    // Spec-backed, not resident-built: the group carries a members spec and
    // resolves no rows at build time.
    expect(groupMembersOf(pts!)).toBeDefined();
    for (let k = 0; k < pts!.length; k++) expect(k in pts!).toBe(false);
  });

  it('keeps annotation-side groups empty pre-residency (same classification the deferred marking pass will stamp)', async () => {
    const nodes = lazyNodes();
    const ctx = await bootClientLazy(nodes);
    const ann = buildGroupsFromActiveClusters([makeCluster()], ctx.hierarchyId, 'annotation', 1);
    expect(ann!.groups['0xLAZY']).toBeUndefined();
  });
});
