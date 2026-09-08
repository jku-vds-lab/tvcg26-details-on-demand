/**
 * Step-11 GeoJSON gate (issue #315 R1a, census A9): the server-seeded boot
 * pass has NO active clusters — steps 7/9 are already gated on them, but the
 * GeoJSON build was not, so it materialized one turf feature per visible
 * node (1M at synth1m) with `cluster: undefined`, only for the caller to
 * discard the result. The gate returns an empty featureCollection on that
 * pass; the client lane (actives present) keeps building features.
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

import { ClusteringService } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import { bumpClusteringEpoch, runHdbscanClustering } from './hdbscanClustering';
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

function makeNodes(opts?: { marked?: boolean }): DataPoint[] {
  return POINTS.map((p, i) => {
    const node = {
      ...createEmptyDataPoint(),
      x: p.x,
      y: p.y,
      id: i + 1,
      line: 0,
      DoI: 1,
      ...(opts?.marked ? { doiGroup: 'inset' as const } : {}),
    } as DataPoint;
    if (!opts?.marked) delete node.doiGroup;
    return node;
  });
}

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

describe('step-11 GeoJSON gate (issue #315 R1a A9)', () => {
  it('builds ZERO features on the server-seeded boot pass', async () => {
    mockResolveCutProvider.mockReturnValue({
      getLeafOrder: jest.fn(async () => POINTS.map((_, i) => i)),
    });
    const nodes = makeNodes();

    const epoch = bumpClusteringEpoch();
    const result = await runHdbscanClustering(nodes, undefined, epoch);

    // Server-seeded: actives are empty until the first settled round trip;
    // the GeoJSON walk must not run (it built cluster:undefined features
    // for every visible node — 1M at synth1m — that no consumer read).
    expect(result.clusterCount).toBe(0);
    expect(result.clusters.features).toHaveLength(0);
  });

  it('keeps building features on the client lane once actives exist', async () => {
    const nodes = makeNodes({ marked: true });
    const coords = nodes.map((n) => [n.x, n.y] as [number, number]);
    const svc = new ClusteringService({
      minClusterSize: 1,
      minSamples: 1,
      alpha: 1.0,
      group: 'annotation',
    });
    svc.computeClustering(coords, nodes);
    const tree = svc.getHierarchyTree()!;

    const epoch = bumpClusteringEpoch();
    const result = await runHdbscanClustering(nodes, { hierarchyTree: tree }, epoch);

    // The gate keys on actives, not on the lane: with a real cut the
    // per-node features (id + cluster id) are built exactly as before.
    const s = store.getState().clustering;
    const actives =
      (s.annotationClusteringResults?.activeClusters.length ?? 0) +
      (s.insetClusteringResults?.activeClusters.length ?? 0);
    expect(actives).toBeGreaterThan(0);
    expect(result.clusters.features).toHaveLength(nodes.length);
    expect(
      result.clusters.features.some((f) => f.properties?.cluster != null)
    ).toBe(true);
  });
});
