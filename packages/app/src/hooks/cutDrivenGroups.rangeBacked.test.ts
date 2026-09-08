/**
 * Index-backed group building under baked DoI (issue #315 R1c).
 *
 * Pinned:
 *   (1) the columnar doiGroup gate (doiGroupOf at canonical indices) splits
 *       members EXACTLY like the resident lane's per-row doiGroupOfPoint —
 *       the same nodes rebuilt after materialization produce the same
 *       memberships (parity fixture),
 *   (2) a filtered subset is a holey list-spec group (no leaf-range
 *       marker), resolving the right rows on demand,
 *   (3) groups of ≤ 2 members materialize real rows eagerly (the
 *       singleton/pair consumers read samples[0]/[1] directly).
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
import type { PointColumns as SidecarPointColumns } from 'src/dataPreprocessing/columnSidecar';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import { createLazyRowArray, materializeRowsBlocking } from 'src/dataPreprocessing/lazyRows';
import { columnsFromSidecar } from 'src/dataPreprocessing/pointColumns';
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

const N = 240;
const THRESHOLDS = {
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function lazyNodes(): DataPoint[] {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i / N;
    y[i] = i / N;
    line[i] = 0;
    id[i] = i + 1;
  }
  const sc: SidecarPointColumns = { count: N, byName: { x, y, line, id } };
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error('fixture sidecar must produce columns');
  return createLazyRowArray([], sc, cols);
}

const FIRST = 210;
const cluster = (firstLeaf: number, lastLeaf: number, uid = '0xRB') =>
  ({
    uid,
    id: 0x0b0,
    size: lastLeaf - firstLeaf,
    firstLeaf,
    lastLeaf,
  }) as unknown as ClusterTreeNode;

/** DoI per canonical index: annotation band for FIRST..219, inset above. */
function bakedOverlay() {
  const values = new Float32Array(N).fill(1);
  for (let i = FIRST; i < 220; i++) values[i] = 0.8;
  return {
    revision: 1,
    focusActive: true,
    runs: [[0, N]] as Array<[number, number]>,
    values,
    visibleRanges: [] as Array<[number, number]>,
  };
}

const allIdx = () => Array.from({ length: N }, (_v, i) => i);

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  resetServerDoiState();
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

async function bootServerCut(nodes: DataPoint[]) {
  mockResolveCutProvider.mockReturnValue({
    getLeafOrder: jest.fn(async () => allIdx()),
  });
  const epoch = bumpClusteringEpoch();
  await runHdbscanClustering(nodes, undefined, epoch);
  const ctx = getNodeClusteringContext();
  expect(ctx).not.toBeNull();
  return ctx!;
}

describe('index-backed builds under baked DoI', () => {
  it('filters columnar into a list spec and matches the resident lane exactly', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);
    applyOverlay(nodes, allIdx(), bakedOverlay(), THRESHOLDS);

    const inset = buildGroupsFromActiveClusters([cluster(FIRST, N)], ctx.hierarchyId, 'inset', 1)!
      .groups['0xRB']!;
    const annotation = buildGroupsFromActiveClusters(
      [cluster(FIRST, N)], ctx.hierarchyId, 'annotation', 1
    )!.groups['0xRB']!;

    // Filtered subsets: holey, list-spec'd, no leaf-range marker.
    expect(inset.length).toBe(20);
    expect(annotation.length).toBe(10);
    expect(groupMembersOf(inset)?.kind).toBe('list');
    expect((inset as unknown as { __leafRange?: unknown }).__leafRange).toBeUndefined();
    expect(0 in inset).toBe(false);
    expect(groupMemberRowAt(inset, 0)!.id).toBe(221);
    expect(groupMemberRowAt(annotation, 9)!.id).toBe(220);

    // Parity: the SAME nodes, rows resident, legacy per-row gate — same
    // memberships, same instances.
    materializeRowsBlocking(nodes);
    const legacyInset = buildGroupsFromActiveClusters(
      [cluster(FIRST, N)], ctx.hierarchyId, 'inset', 2
    )!.groups['0xRB']!;
    expect(legacyInset.map((p) => p.id)).toEqual(
      Array.from({ length: 20 }, (_v, k) => 221 + k)
    );
    expect(legacyInset[0]).toBe(groupMemberRowAt(inset, 0));
    const legacyAnn = buildGroupsFromActiveClusters(
      [cluster(FIRST, N)], ctx.hierarchyId, 'annotation', 2
    )!.groups['0xRB']!;
    expect(legacyAnn.map((p) => p.id)).toEqual(
      Array.from({ length: 10 }, (_v, k) => 211 + k)
    );
  });

  it('materializes real rows for groups of ≤ 2 members', async () => {
    const nodes = lazyNodes();
    const ctx = await bootServerCut(nodes);

    const pair = buildGroupsFromActiveClusters(
      [cluster(230, 232, '0xPAIR')], ctx.hierarchyId, 'inset', 1
    )!.groups['0xPAIR']!;
    expect(pair.length).toBe(2);
    expect(groupMembersOf(pair)).toBeUndefined(); // real rows, no spec
    expect(pair[0].id).toBe(231);
    expect(pair[1].id).toBe(232);
    // Full membership ⇒ the pair still carries the leaf-range marker.
    expect(
      (pair as unknown as { __leafRange?: { ranges: number[][] } }).__leafRange?.ranges
    ).toEqual([[230, 232]]);
  });
});
