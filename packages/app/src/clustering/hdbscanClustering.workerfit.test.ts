/**
 * Tests for the worker-fit slow path of runHdbscanClustering (datasets without
 * a precomputed hierarchy: drag & drop, in-app re-projection). The HDBSCAN
 * worker now returns the lightweight buildHdbscanHierarchy tree (leafIndex
 * leaves, no materialized children); the slow path must hydrate it with the
 * DFS leaf-order index before rehydrating the ClusteringService, and must
 * forward fit progress to the caller.
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

import { buildHdbscanHierarchy } from '../dataPreprocessing/hdbscanHierarchy';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import { bumpClusteringEpoch, runHdbscanClustering } from './hdbscanClustering';
import store, {
  setAnnotationClusteringResults,
  setInsetClusteringResults,
} from '../store';

// Two tight blobs far apart — any sane hierarchy separates them.
const POINTS = [
  { x: 0.10, y: 0.10 },
  { x: 0.12, y: 0.11 },
  { x: 0.11, y: 0.12 },
  { x: 0.80, y: 0.80 },
  { x: 0.82, y: 0.79 },
  { x: 0.81, y: 0.81 },
];

function makeNodes(): DataPoint[] {
  return POINTS.map((p, i) => ({
    ...createEmptyDataPoint(),
    x: p.x,
    y: p.y,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: 'inset' as const,
  }));
}

/** Mirrors the worker: fit resolves with the lightweight hierarchy tree. */
function mockWorkerFit() {
  mockFit.mockImplementation((...args: unknown[]) => {
    const coords = args[0] as number[][];
    const onProgress = args[2] as ((f: number) => void) | undefined;
    onProgress?.(0.5);
    const tree = buildHdbscanHierarchy(
      coords.map(([x, y]) => ({ x, y })),
      { minSamples: 1 }
    );
    return Promise.resolve({ tree });
  });
}

beforeEach(() => {
  mockFit.mockReset();
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
});

describe('runHdbscanClustering worker-fit slow path', () => {
  it('clusters via the lightweight worker tree when no precomputed hierarchy exists', async () => {
    mockWorkerFit();
    const nodes = makeNodes();

    const epoch = bumpClusteringEpoch();
    const result = await runHdbscanClustering(nodes, undefined, epoch);

    expect(mockFit).toHaveBeenCalledTimes(1);
    expect(result.clusterCount).toBeGreaterThan(0);

    // Every point got a cluster assignment (full-depth cut at threshold 1,
    // all DoI 1 ⇒ inset side).
    const ids = nodes.map((n) => n.insetClusterId ?? n.annotationClusterId);
    expect(ids.every((id) => id != null)).toBe(true);
  });

  it('forwards fit progress from the worker proxy to the caller', async () => {
    mockWorkerFit();
    const nodes = makeNodes();
    const progress: number[] = [];

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch, (f) => progress.push(f));

    expect(progress).toEqual([0.5]);
  });
});
