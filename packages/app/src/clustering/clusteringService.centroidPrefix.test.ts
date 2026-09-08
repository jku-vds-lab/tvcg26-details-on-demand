/**
 * Centroid prefix columnar fast path (issue #315 insets-at-boot I2).
 *
 * The lazy x/y prefix behind clusterCentroidFromPrefix used a per-point
 * object walk (121–232 ms at 1M on the first boot-frame apply); it now rides
 * the columnar buildLeafOrderPrefixFromArray when point columns are attached.
 * Guarded here: the columnar path is bit-identical to the object path, and
 * the null contracts (legacy node, empty range) are unchanged.
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
import { attachPointColumns, columnsOf } from '../dataPreprocessing/pointColumns';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import type { ClusterCutProvider } from '../scaling.types';

const stubProvider: ClusterCutProvider = {
  manifest: { kind: 'test', baseUrl: 'http://localhost:0' },
  cutKey: () => 'k',
  getCut: async () => ({ tree: 'points', candidates: [] }),
  getLeafOrder: async () => new Uint32Array(0),
  cancel: () => {},
};

function makeNodes(total: number): DataPoint[] {
  return Array.from({ length: total }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: Math.sin(i) * 10,
    y: Math.cos(i) * 7,
    id: i + 1,
    line: 0,
    DoI: 1,
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

describe('clusterCentroidFromPrefix columnar fast path', () => {
  it('is bit-identical between the columnar and the object path', () => {
    const plainNodes = makeNodes(500);
    const columnarNodes = makeNodes(500);
    attachPointColumns(columnarNodes);
    expect(columnsOf(plainNodes)).toBeNull();
    expect(columnsOf(columnarNodes)).not.toBeNull();

    const plainService = serviceOver(plainNodes);
    const columnarService = serviceOver(columnarNodes);

    for (const [first, last] of [[0, 500], [0, 1], [123, 456]] as Array<[number, number]>) {
      const plain = plainService.clusterCentroidFromPrefix(candidateNode(first, last));
      const columnar = columnarService.clusterCentroidFromPrefix(candidateNode(first, last));
      expect(columnar).not.toBeNull();
      expect(columnar!.x).toBe(plain!.x);
      expect(columnar!.y).toBe(plain!.y);
    }
  });

  it('computes the exact range mean on the columnar path', () => {
    const nodes = makeNodes(100);
    attachPointColumns(nodes);
    const service = serviceOver(nodes);
    const c = service.clusterCentroidFromPrefix(candidateNode(10, 20))!;
    let sx = 0, sy = 0;
    for (let i = 10; i < 20; i++) { sx += nodes[i].x; sy += nodes[i].y; }
    expect(c.x).toBeCloseTo(sx / 10, 12);
    expect(c.y).toBeCloseTo(sy / 10, 12);
  });

  it('keeps the null contracts (legacy node, empty range)', () => {
    const nodes = makeNodes(50);
    attachPointColumns(nodes);
    const service = serviceOver(nodes);
    const legacy = { uid: 'legacy', id: 1, size: 2, stability: 1 } as unknown as ClusterTreeNode;
    expect(service.clusterCentroidFromPrefix(legacy)).toBeNull();
    expect(service.clusterCentroidFromPrefix(candidateNode(5, 5))).toBeNull();
  });
});
