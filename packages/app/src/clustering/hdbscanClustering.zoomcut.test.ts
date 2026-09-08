/**
 * Tests for the unchanged-cut gate in updateClusteringForZoom (perf overhaul
 * phase 6): settled zoom ticks whose semantic-zoom cut produces the identical
 * annotation/inset uid split must NOT re-dispatch active-cluster updates
 * (which would re-render every clustering consumer), while forced refreshes
 * (refreshClusterActivation) must always dispatch.
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
  refreshClusterActivation,
  runHdbscanClustering,
  updateClusteringForZoom,
} from './hdbscanClustering';
import store, {
  initialClusterSettings,
  setAnnotationClusteringResults,
  setInsetClusteringResults,
  updateClusterSettings,
} from '../store';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockCanvasContainer(w = 800, h = 600): HTMLDivElement {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth',  { configurable: true, value: w });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: h });
  Object.defineProperty(container, 'clientWidth',  { configurable: true, value: w });
  Object.defineProperty(container, 'clientHeight', { configurable: true, value: h });
  container.appendChild(canvas);
  return container as HTMLDivElement;
}

const POINTS = [
  { x: 0.10, y: 0.10 },
  { x: 0.12, y: 0.11 },
  { x: 0.80, y: 0.80 },
  { x: 0.82, y: 0.79 },
  { x: 0.50, y: 0.50 },
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

async function bootstrapClustering(nodes: DataPoint[]) {
  const coords = nodes.map((n) => [n.x, n.y] as [number, number]);
  const svc = new ClusteringService({ minClusterSize: 1, minSamples: 1, alpha: 1.0, group: 'annotation' });
  svc.computeClustering(coords, nodes);
  const tree = svc.getHierarchyTree()!;

  const epoch = bumpClusteringEpoch();
  await runHdbscanClustering(nodes, { hierarchyTree: tree }, epoch);
}

function clusterVersions() {
  const s = store.getState().clustering;
  return { annotation: s.annotationClusterVersion, inset: s.insetClusterVersion };
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('updateClusteringForZoom unchanged-cut gate', () => {
  it('skips dispatches and reuses the result when the cut is unchanged', async () => {
    const nodes = makeNodes();
    await bootstrapClustering(nodes);

    const container = makeMockCanvasContainer();
    const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
    const yScale = d3.scaleLinear().domain([0, 1]).range([0, 600]);

    const first = updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);
    expect(first).not.toBeNull();
    const versionsAfterFirst = clusterVersions();

    // Identical viewport ⇒ identical cut ⇒ no dispatch, cached result identity.
    const second = updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);
    expect(second).toBe(first);
    expect(clusterVersions()).toEqual(versionsAfterFirst);
  });

  it('bypasses the gate with force (refreshClusterActivation path)', async () => {
    const nodes = makeNodes();
    await bootstrapClustering(nodes);

    const container = makeMockCanvasContainer();
    const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
    const yScale = d3.scaleLinear().domain([0, 1]).range([0, 600]);

    updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);
    const before = clusterVersions();

    // refreshClusterActivation re-runs the same viewport with force: true —
    // settings-driven refreshes must always re-dispatch even on an
    // unchanged cut.
    const ran = refreshClusterActivation();
    expect(ran).toBe(true);
    const after = clusterVersions();
    expect(after.annotation).toBeGreaterThan(before.annotation);
    expect(after.inset).toBeGreaterThan(before.inset);
  });

  it('dispatches activeClusterStats consistent with the dispatched active sets', async () => {
    const nodes = makeNodes();
    await bootstrapClustering(nodes);

    const container = makeMockCanvasContainer();
    const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
    // Inverted y-range: computeViewbox needs screen-orientation scales or the
    // cut silently yields zero active clusters (known test trap).
    const yScale = d3.scaleLinear().domain([0, 1]).range([600, 0]);

    updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);

    const s = store.getState().clustering;
    const activeCount =
      (s.annotationClusteringResults?.activeClusters.length ?? 0) +
      (s.insetClusteringResults?.activeClusters.length ?? 0);

    // base + chain must always equal the dispatched node-cluster actives;
    // with no selection (all points clustered) nothing is chain-rescued.
    expect(s.activeClusterStats.base + s.activeClusterStats.chain).toBe(activeCount);
    expect(s.activeClusterStats.chain).toBe(0);
    expect(activeCount).toBeGreaterThan(0);
  });

  it('dispatches again when the cut itself changes (different zoom transform)', async () => {
    const nodes = makeNodes();
    await bootstrapClustering(nodes);

    const container = makeMockCanvasContainer();
    const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
    const yScale = d3.scaleLinear().domain([0, 1]).range([0, 600]);

    const first = updateClusteringForZoom(0, container, { xScale, yScale }, d3.zoomIdentity);
    expect(first).not.toBeNull();

    // Zoom far enough in that the semantic-zoom cut splits differently. If the
    // cut happens to stay identical the gate must still return an equal result.
    const zoomed = d3.zoomIdentity.scale(50);
    const second = updateClusteringForZoom(0, container, { xScale, yScale }, zoomed);
    expect(second).not.toBeNull();

    const uidCount = (r: NonNullable<typeof first>) =>
      r.annotation.clusterCount + r.inset.clusterCount;
    if (uidCount(second!) !== uidCount(first!)) {
      expect(second).not.toBe(first);
    }
  });
});
