/**
 * Annotation/inset split under a full-tree cut (issue #315 §10.2 package B2).
 *
 * End-to-end twin of clusteringService.visibleMean.test.ts: the settled-zoom
 * pass must classify a cluster by the mean DoI of its VISIBLE members. A
 * coarse/flood cut hands it candidates whose leaf ranges are mostly hidden
 * (DoI ≈ 0) leaves — with the plain mean every candidate diluted below both
 * thresholds and the view showed NO insets at all.
 *
 * The control case (hidden threshold 0 ⇒ everything visible) reproduces the
 * old diluted behavior exactly, which is also the invariant that keeps the
 * default/no-selection path unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Mock the Web Worker proxy to avoid import.meta.url and Worker issues in Jest.
jest.mock('src/workers/hdbscanWorkerProxy', () => ({
  hdbscanWorkerProxy: { fit: jest.fn(), cancel: jest.fn() },
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

import * as d3 from 'd3';
import { ClusteringService } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  bumpClusteringEpoch,
  runHdbscanClustering,
  updateClusteringForZoom,
} from './hdbscanClustering';
import store, {
  initialClusterSettings,
  initialVisualizationSettings,
  setAnnotationClusteringResults,
  setInsetClusteringResults,
  updateClusterSettings,
  updateSettings,
} from '../store';

const W = 800;
const H = 600;

function makeMockCanvasContainer(): HTMLDivElement {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: W });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: H });
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: W });
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: H });
  container.appendChild(canvas);
  return container as HTMLDivElement;
}

/**
 * 100 points spread over the view; every 10th is selected (DoI 1), the rest are
 * hidden (DoI 0). doiGroup stays "inset" throughout because that is what a
 * full-tree cut produces: the hidden points ARE part of the clustered set.
 * Any cluster of ≥ 10 members therefore has plain mean ≈ 0.1 and visible mean 1.
 */
function makeMixedNodes(): DataPoint[] {
  return Array.from({ length: 100 }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: 0.1 + ((i * 37) % 100) * 0.008,
    y: 0.1 + ((i * 53) % 100) * 0.008,
    id: i + 1,
    line: 0,
    DoI: i % 10 === 0 ? 1 : 0,
    doiGroup: 'inset' as const,
  }));
}

async function bootstrapClustering(nodes: DataPoint[]) {
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
  await runHdbscanClustering(nodes, { hierarchyTree: tree }, epoch);
}

function runZoomPass() {
  const container = makeMockCanvasContainer();
  const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
  // Inverted y-range: computeViewbox needs screen-orientation scales or the
  // cut silently yields zero active clusters (known test trap).
  const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);
  return updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);
}

beforeEach(() => {
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
});

afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
});

describe('updateClusteringForZoom annotation/inset split', () => {
  it('classifies mostly-hidden clusters by their visible members', async () => {
    await bootstrapClustering(makeMixedNodes());
    const masked = runZoomPass()!;
    expect(masked).not.toBeNull();
    const activeCount =
      store.getState().clustering.insetClusteringResults!.activeClusters.length +
      store.getState().clustering.annotationClusteringResults!.activeClusters.length;
    expect(activeCount).toBeGreaterThan(0);
    // Multi-member candidates are 10% selected: diluted they classify as
    // nothing, masked they are inset.
    expect(masked.inset.clusterCount).toBeGreaterThan(0);

    // Same geometry, hidden threshold 0 ⇒ the DoI-0 members count as visible
    // ⇒ the plain (pre-fix) mean. Only the accidental all-selected singletons
    // survive the 0.9 gate, so strictly fewer clusters carry insets.
    store.dispatch(updateSettings({ grayOutDoiThreshold: 0 }));
    await bootstrapClustering(makeMixedNodes());
    const diluted = runZoomPass()!;
    expect(diluted).not.toBeNull();
    expect(diluted.inset.clusterCount).toBeLessThan(masked.inset.clusterCount);
  });

  it('leaves the split untouched when every point is visible', async () => {
    // Uniform DoI 1 (the boot / no-selection state): masking is a no-op, so
    // the default hidden threshold and a 0 threshold must agree exactly.
    const uniform = () =>
      makeMixedNodes().map((n) => ({ ...n, DoI: 1 }));

    await bootstrapClustering(uniform());
    const withThreshold = runZoomPass()!;

    store.dispatch(updateSettings({ grayOutDoiThreshold: 0 }));
    await bootstrapClustering(uniform());
    const withoutThreshold = runZoomPass()!;

    expect(withoutThreshold.inset.activeUids).toEqual(withThreshold.inset.activeUids);
    expect(withoutThreshold.annotation.activeUids).toEqual(withThreshold.annotation.activeUids);
    expect(withThreshold.inset.clusterCount).toBeGreaterThan(0);
  });
});
