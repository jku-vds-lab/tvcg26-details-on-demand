/**
 * Visibility-masked classification mean (issue #315 §10.2 package B2).
 *
 * The annotation/inset split ranks a cluster by its MEAN DoI. Since coarse-first
 * and flood routing cut the FULL-dataset hierarchy, a candidate's leaf range
 * covers mostly unselected near-zero-DoI leaves — the plain mean dilutes below
 * insetDoiThreshold for every candidate and the user gets annotations and ZERO
 * insets, silently. The split therefore averages over the VISIBLE leaves only
 * (DoI ≥ the hidden threshold).
 *
 * Guarded here: the dilution case flips back to inset, the all-visible case is
 * bit-identical to the old mean (default/no-selection behavior must not move),
 * and an all-hidden cluster reports 0 (neither annotation nor inset).
 */

import { describe, expect, it } from '@jest/globals';

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

import { ClusteringService } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import type { ClusterCutProvider } from '../scaling.types';
import { initialVisualizationSettings } from '../store';

// The live defaults the split compares against.
const HIDDEN = initialVisualizationSettings.grayOutDoiThreshold;   // 0.05
const INSET = initialVisualizationSettings.insetDoiThreshold;      // 0.9

const stubProvider: ClusterCutProvider = {
  manifest: { kind: 'test', baseUrl: 'http://localhost:0' },
  cutKey: () => 'k',
  getCut: async () => ({ tree: 'points', candidates: [] }),
  getLeafOrder: async () => new Uint32Array(0),
  cancel: () => {},
};

/** `visible` leading points with DoI 1, the rest DoI 0. */
function makeNodes(total: number, visible: number): DataPoint[] {
  return Array.from({ length: total }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: (i + 0.5) / total,
    y: (i + 0.5) / total,
    id: i + 1,
    line: 0,
    DoI: i < visible ? 1 : 0,
  }));
}

/** A frontier candidate over the half-open leaf range [first, last). */
function candidateNode(first: number, last: number): ClusterTreeNode {
  return {
    uid: `0x${first}-${last}`,
    id: first,
    size: last - first,
    stability: 1,
    firstLeaf: first,
    lastLeaf: last,
  } as unknown as ClusterTreeNode;
}

/** A service whose leaf order is the identity permutation over `nodes`. */
function serviceOver(nodes: DataPoint[]): ClusteringService {
  const service = new ClusteringService({
    minClusterSize: 1,
    minSamples: 1,
    alpha: 1.0,
    group: 'annotation',
  });
  service.initServerCut(
    stubProvider,
    'points',
    nodes.map((_, i) => i),
    nodes
  );
  return service;
}

describe('clusterVisibleMeanFromPrefix', () => {
  it('undilutes a mostly-hidden candidate so it classifies as inset again', () => {
    // 100 selected leaves (DoI 1) inside a 1000-leaf full-tree candidate.
    const nodes = makeNodes(1000, 100);
    const service = serviceOver(nodes);
    const candidate = candidateNode(0, 1000);

    const plain = service.clusterMeanFromPrefix(candidate, service.getDoiPrefix()!);
    const visible = service.clusterVisibleMeanFromPrefix(
      candidate,
      service.getVisibleDoiPrefix(HIDDEN)!
    );

    expect(plain).toBeCloseTo(0.1, 12);
    expect(visible).toBe(1);
    // The classification flips: diluted ⇒ not even an annotation; masked ⇒ inset.
    expect(plain! >= INSET).toBe(false);
    expect(visible! >= INSET).toBe(true);
  });

  it('is bit-identical to the plain mean when every leaf is visible', () => {
    // Uniform boot DoI — the default/no-selection state.
    const nodes = makeNodes(500, 500);
    const service = serviceOver(nodes);
    for (const range of [[0, 500], [0, 1], [123, 456]] as Array<[number, number]>) {
      const candidate = candidateNode(range[0], range[1]);
      expect(
        service.clusterVisibleMeanFromPrefix(candidate, service.getVisibleDoiPrefix(HIDDEN)!)
      ).toBe(service.clusterMeanFromPrefix(candidate, service.getDoiPrefix()!));
    }
  });

  it('is bit-identical to the plain mean at a 0 threshold, mixed DoI', () => {
    const nodes = makeNodes(1000, 100);
    const service = serviceOver(nodes);
    const candidate = candidateNode(0, 1000);
    expect(
      service.clusterVisibleMeanFromPrefix(candidate, service.getVisibleDoiPrefix(0)!)
    ).toBe(service.clusterMeanFromPrefix(candidate, service.getDoiPrefix()!));
  });

  it('reports 0 for an all-hidden cluster (neither annotation nor inset)', () => {
    const nodes = makeNodes(1000, 100);
    const service = serviceOver(nodes);
    // Entirely inside the DoI-0 tail.
    const candidate = candidateNode(200, 900);
    expect(
      service.clusterVisibleMeanFromPrefix(candidate, service.getVisibleDoiPrefix(HIDDEN)!)
    ).toBe(0);
  });

  it('returns null exactly where the plain mean does (no contiguous range)', () => {
    const nodes = makeNodes(100, 50);
    const service = serviceOver(nodes);
    const legacy = { uid: 'legacy', id: 1, size: 2, stability: 1 } as unknown as ClusterTreeNode;
    const empty = candidateNode(5, 5);
    const masked = service.getVisibleDoiPrefix(HIDDEN)!;
    const plain = service.getDoiPrefix()!;
    expect(service.clusterVisibleMeanFromPrefix(legacy, masked)).toBeNull();
    expect(service.clusterMeanFromPrefix(legacy, plain)).toBeNull();
    expect(service.clusterVisibleMeanFromPrefix(empty, masked)).toBeNull();
    expect(service.clusterMeanFromPrefix(empty, plain)).toBeNull();
  });

  it('rebuilds the cached prefix when the hidden threshold moves', () => {
    // Three bands: DoI 1, DoI 0.5, DoI 0 — a threshold above 0.5 must drop
    // the middle band from both the sum and the count.
    const nodes: DataPoint[] = Array.from({ length: 300 }, (_, i) => ({
      ...createEmptyDataPoint(),
      x: i / 300,
      y: i / 300,
      id: i + 1,
      line: 0,
      DoI: i < 100 ? 1 : i < 200 ? 0.5 : 0,
    }));
    const service = serviceOver(nodes);
    const candidate = candidateNode(0, 300);

    // Hidden = 0.05: 200 visible, mean (100·1 + 100·0.5) / 200 = 0.75.
    expect(
      service.clusterVisibleMeanFromPrefix(candidate, service.getVisibleDoiPrefix(0.05)!)
    ).toBeCloseTo(0.75, 12);
    // Hidden = 0.6: only the DoI-1 band survives.
    expect(
      service.clusterVisibleMeanFromPrefix(candidate, service.getVisibleDoiPrefix(0.6)!)
    ).toBe(1);
  });
});
