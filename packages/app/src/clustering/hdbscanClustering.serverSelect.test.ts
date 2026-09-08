/**
 * Server-select mode through the dispatch tail (issue #315 P7 S2,
 * design-seam-first §4.1 step 3 / §4.3): the settled zoom pass hands the
 * frame's actives AND the server's group split straight to
 * `updateClusteringForZoom`, which dispatches the unchanged action vocabulary
 * (`updateAnnotationActiveClusters` / `updateInsetActiveClusters` / stats) and
 * writes the delta clusterIds — WITHOUT running the client's masked
 * visible-mean classification pass.
 *
 * The give-away in this fixture: every point carries DoI 0, so the client
 * classification would put every cluster in group "neither" and dispatch two
 * empty lists. The server frame says otherwise, and the server wins.
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

jest.mock('../doiPropagation/serverPropagation', () => ({
  getResidentField: () => null,
  getLastDoiRevision: () => null,
}));

import * as d3 from 'd3';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  bumpClusteringEpoch,
  runHdbscanClustering,
  updateClusteringForZoom,
} from './hdbscanClustering';
import type { SelectCutRequest, SelectFrame, SelectedActive } from '../scaling.types';
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
const N = 20;

/** Uniform DoI 0: the CLIENT classification would activate nothing. */
function makeNodes(): DataPoint[] {
  return Array.from({ length: N }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: (i + 0.5) / N,
    y: (i + 0.5) / N,
    id: i + 1,
    line: 0,
    DoI: 0,
    doiGroup: 'inset' as const,
  }));
}

function active(uid: string, overrides: Partial<SelectedActive> = {}): SelectedActive {
  return {
    uid,
    size: 10,
    stability: 10,
    saliency: 0.5,
    doiMass: 0,
    visibleMeanDoi: 0,
    group: 1,
    rescued: false,
    reserved: false,
    bbox: { minX: 0.05, minY: 0.05, maxX: 0.45, maxY: 0.45 },
    centroid: [0.25, 0.25],
    insetPos: [0.3, 0.3],
    leafRanges: [[0, 10]],
    hull: null,
    ...overrides,
  };
}

function makeProvider(frame: SelectFrame) {
  const requests: SelectCutRequest[] = [];
  const provider = {
    manifest: {
      kind: 'test',
      baseUrl: 'http://localhost:0',
      datasetId: 'd1',
      capabilities: ['cut', 'select-cut'],
    },
    cutKey: (request: { viewbox: unknown }) => JSON.stringify(request.viewbox),
    getCut: jest.fn(),
    getLeafOrder: jest.fn(async () => Array.from({ length: N }, (_, i) => i)),
    selectCut: jest.fn(async (request: SelectCutRequest) => {
      requests.push(request);
      return frame;
    }),
    cancel: () => {},
  };
  return { provider, requests };
}

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

const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
// Inverted y-range: computeViewbox needs screen-orientation scales (test trap).
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);

function runZoomPass(opts?: { force?: boolean }) {
  return updateClusteringForZoom(
    0,
    makeMockCanvasContainer(),
    { xScale, yScale },
    d3.zoomIdentity,
    opts
  );
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const results = () => ({
  annotation: store.getState().clustering.annotationClusteringResults!.activeClusters.map(
    (c) => c.uid
  ),
  inset: store.getState().clustering.insetClusteringResults!.activeClusters.map((c) => c.uid),
});

beforeEach(() => {
  mockFit.mockReset();
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  store.dispatch(setAnnotationClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(setInsetClusteringResults({ activeClusters: [], hierarchyId: 0 }));
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
});

describe('updateClusteringForZoom in server-select mode', () => {
  it('dispatches the SERVER group split, not a client classification', async () => {
    const frame: SelectFrame = {
      tree: 'points',
      actives: [
        active('0xANN', { group: 1, leafRanges: [[0, 10]] }),
        active('0xINS', {
          group: 2,
          leafRanges: [[10, 20]],
          bbox: { minX: 0.55, minY: 0.55, maxX: 0.95, maxY: 0.95 },
        }),
        active('0xNONE', { group: 0, size: 1, leafRanges: [[7, 8]] }),
      ],
      borderScore: 0.1,
      examined: 99,
      clipped: false,
      fallbackRanking: false,
      focusActive: false,
      doiRevision: null,
    };
    const { provider, requests } = makeProvider(frame);
    mockResolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes();

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // First pass fires the select request; nothing has landed yet.
    runZoomPass();
    await flushMicrotasks();
    expect(provider.selectCut).toHaveBeenCalledTimes(1);
    expect(provider.getCut).not.toHaveBeenCalled();
    expect(requests[0].select.budget).toBe(initialClusterSettings.maxActiveClusters);

    // The frame's answer reaches Redux through the unchanged actions.
    const result = runZoomPass()!;
    expect(result).not.toBeNull();
    expect(results()).toEqual({ annotation: ['0xANN'], inset: ['0xINS'] });
    expect(result.annotation.activeUids).toEqual(['0xANN']);
    expect(result.inset.activeUids).toEqual(['0xINS']);
    // group 0 is dispatched nowhere (neither annotation nor inset).
    expect(results().annotation).not.toContain('0xNONE');

    // NO per-point cluster ids on the server lane (issue #315 R1a step 5, CS
    // decision 2026-08-02): the delta writeback that stamped every winner
    // member — ~2M property writes at 1M, where the winners span the dataset —
    // is deleted. Cluster identity now rides the member group instead; the
    // group registry is asserted in clustering/groupClusterUid.test.ts and the
    // dispatched split above is unchanged.
    expect(nodes.every((n) => n.annotationClusterId === undefined)).toBe(true);
    expect(nodes.every((n) => n.insetClusterId === undefined)).toBe(true);

    // The unchanged-cut gate still absorbs a repeat pass.
    expect(runZoomPass()).toBe(result);
  });

  it('reports the server rescued flags in the base-vs-chain stats', async () => {
    const frame: SelectFrame = {
      tree: 'points',
      actives: [
        active('0xBASE', { group: 1 }),
        active('0xCHAIN', {
          group: 1,
          rescued: true,
          reserved: true,
          size: 1,
          leafRanges: [[12, 13]],
        }),
      ],
      borderScore: 0.1,
      examined: 7,
      clipped: false,
      fallbackRanking: false,
      focusActive: true,
      doiRevision: 4,
    };
    const { provider } = makeProvider(frame);
    mockResolveCutProvider.mockReturnValue(provider);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(makeNodes(), undefined, epoch);
    runZoomPass();
    await flushMicrotasks();
    runZoomPass();

    expect(results().annotation.sort()).toEqual(['0xBASE', '0xCHAIN']);
    expect(store.getState().clustering.activeClusterStats).toEqual({ base: 1, chain: 1 });
  });
});
