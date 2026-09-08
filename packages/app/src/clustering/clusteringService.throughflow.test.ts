/**
 * clusteringService.throughflow.test.ts
 *
 * Integration test for singleton chain rescue (issue #258 phase C): the
 * trajectory through-flow derivation inside ClusteringService, exercised
 * through the real semantic-zoom pipeline (HDBSCAN tree, gap disclosure,
 * rescue gate).
 *
 * Fixture: trajectory line 0 flows A(3 pts) → b(single stark-transition
 * point) → C(3 pts), all selected (doiGroup "inset").  A second trajectory
 * line 1 contributes a lasso-straggler s whose trajectory neighbors are
 * UNSELECTED (doiGroup "gray", present only in allNodes).  b must activate;
 * s must not.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
import * as d3 from 'd3';
import { ClusteringService } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type { ClusterTreeNode } from './ExtendedHDBSCAN';
import store, { initialClusterSettings, updateClusterSettings } from '../store';

function mkPoint(
  id: number,
  x: number,
  y: number,
  line: number,
  doiGroup: 'inset' | 'gray'
): DataPoint {
  return {
    ...createEmptyDataPoint(),
    id,
    x,
    y,
    line,
    DoI: doiGroup === 'inset' ? 1 : 0,
    doiGroup,
  };
}

const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
const yScale = d3.scaleLinear().domain([0, 1]).range([0, 600]);
const viewbox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

/**
 * Build allNodes (trajectory order = array order per line) and the
 * DoI-filtered subset, run real clustering + one semantic-zoom frame.
 * `bAtEnd` moves b to the end of line 0 (trajectory endpoint → no succ).
 */
function runFrame(bAtEnd: boolean) {
  const A = [
    mkPoint(1, 0.10, 0.10, 0, 'inset'),
    mkPoint(2, 0.12, 0.11, 0, 'inset'),
    mkPoint(3, 0.11, 0.13, 0, 'inset'),
  ];
  const b = mkPoint(4, 0.50, 0.50, 0, 'inset');
  const C = [
    mkPoint(5, 0.80, 0.80, 0, 'inset'),
    mkPoint(6, 0.82, 0.79, 0, 'inset'),
    mkPoint(7, 0.81, 0.82, 0, 'inset'),
  ];
  const line0 = bAtEnd ? [...A, ...C, b] : [...A, b, ...C];

  // Straggler trajectory: only s was lassoed; its neighbors stayed gray.
  const g1 = mkPoint(8, 0.88, 0.08, 1, 'gray');
  const s = mkPoint(9, 0.90, 0.10, 1, 'inset');
  const g2 = mkPoint(10, 0.92, 0.12, 1, 'gray');

  const allNodes = [...line0, g1, s, g2];
  const filtered = allNodes.filter(
    (n) => n.doiGroup === 'annotation' || n.doiGroup === 'inset'
  );
  expect(filtered.length).toBeLessThan(allNodes.length); // selectionActive

  const svc = new ClusteringService({
    minClusterSize: 1,
    minSamples: 1,
    alpha: 1.0,
    group: 'annotation',
  });
  svc.computeClustering(filtered.map((n) => [n.x, n.y]), filtered, allNodes);

  const { activeClusters } = svc.updateClusteringSemanticZoom(
    viewbox, xScale, yScale, 800, 600
  );
  return activeClusters;
}

function bboxCenter(c: ClusterTreeNode): [number, number] {
  const bb = c.bbox!;
  return [(bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2];
}

function activeSingletonNear(
  active: ClusterTreeNode[],
  x: number,
  y: number
): boolean {
  return active.some((c) => {
    if (c.size !== 1) return false;
    const [cx, cy] = bboxCenter(c);
    return Math.hypot(cx - x, cy - y) < 0.05;
  });
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

describe('singleton through-flow derivation (real pipeline)', () => {
  it('activates the stark-transition singleton but not the straggler', () => {
    const active = runFrame(false);

    // b: both trajectory neighbors (a3, c1) are selected → rescued.
    expect(activeSingletonNear(active, 0.5, 0.5)).toBe(true);

    // s: trajectory neighbors are gray → never rescued, no cluster there.
    expect(activeSingletonNear(active, 0.9, 0.1)).toBe(false);
  });

  it('does not rescue a trajectory endpoint (no successor)', () => {
    const active = runFrame(true);
    expect(activeSingletonNear(active, 0.5, 0.5)).toBe(false);
  });
});
