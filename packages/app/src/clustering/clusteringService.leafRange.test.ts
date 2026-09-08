/**
 * leafRangeMembers ↔ membersOfCluster agreement (issue #315 insets-at-boot
 * I2): the zoom-pass write loops iterate the leaf order in place through
 * leafRangeMembers; it must yield exactly the members membersOfCluster
 * returns, and must return null wherever membersOf would NOT take the
 * leaf-range branch (legacy children array, lightweight leaf) so callers
 * fall back and the two paths can never diverge.
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
    x: i,
    y: i,
    id: i + 1,
    line: 0,
    DoI: 1,
  }));
}

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

function rangeNode(first: number, last: number): ClusterTreeNode {
  return {
    uid: `0x${first}-${last}`,
    id: first,
    size: last - first,
    stability: 1,
    firstLeaf: first,
    lastLeaf: last,
  } as unknown as ClusterTreeNode;
}

describe('leafRangeMembers', () => {
  it('yields exactly the members membersOfCluster returns for range nodes', () => {
    const service = serviceOver(makeNodes(100));
    for (const [first, last] of [[0, 100], [0, 1], [42, 77]] as Array<[number, number]>) {
      const node = rangeNode(first, last);
      const range = service.leafRangeMembers(node)!;
      expect(range).not.toBeNull();
      const viaRange: number[] = [];
      for (let i = range.first; i < range.last; i++) viaRange.push(range.order[i]);
      expect(viaRange).toEqual(service.membersOfCluster(node));
    }
  });

  it('returns null for a legacy children-array node (membersOf precedence rule 1)', () => {
    const service = serviceOver(makeNodes(10));
    const legacy = {
      uid: 'legacy',
      id: 0,
      size: 3,
      stability: 1,
      children: [7, 8, 9],
      firstLeaf: 0,
      lastLeaf: 3, // deliberately disagrees with children — children must win
    } as unknown as ClusterTreeNode;
    expect(service.leafRangeMembers(legacy)).toBeNull();
    expect(service.membersOfCluster(legacy)).toEqual([7, 8, 9]);
  });

  it('returns null for a lightweight leaf (membersOf precedence rule 2)', () => {
    const service = serviceOver(makeNodes(10));
    const leaf = {
      uid: 'leaf',
      id: 0,
      size: 1,
      stability: 1,
      leafIndex: 5,
      firstLeaf: 0,
      lastLeaf: 10,
    } as unknown as ClusterTreeNode;
    expect(service.leafRangeMembers(leaf)).toBeNull();
    expect(service.membersOfCluster(leaf)).toEqual([5]);
  });
});
