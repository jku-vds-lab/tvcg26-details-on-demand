/**
 * Baked-DoI visibility (#337 toggle bug, CS 2026-08-08; #342): while a bake
 * owns DoI the per-node doiGroup strings are stale BY DESIGN (issue #315 P7
 * S5) — a labeled-mode commit writes real capped strings, the next baked
 * commit never rewrites them, and the fit's string filter then excluded
 * labeled points from every subsequent clustering (no contours/insets after
 * the unlabeled-only toggle, plus a spurious subset worker refit). With a
 * bake active the fit must never consult the strings — but the baked FIELD
 * is fresh truth, and it must produce the same DoI-filtered subset the
 * string lane produced (#342: treating every baked commit as uniformly
 * visible sent focused query selections onto the full-tree route, whose
 * τ-cut clusters mix focused and unfocused members — wrong inset labels,
 * wrong active count). Uniform fields (select-all, boot) still take the
 * full-tree route.
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

jest.mock('@scaling', () => ({
  resolveCutProvider: () => null,
  resolveInsetProvider: () => null,
  hasLiveCutSubscription: () => false,
  warmBootCut: () => () => {},
}));

import { buildHdbscanHierarchy } from '../dataPreprocessing/hdbscanHierarchy';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import { attachPointColumns } from '../dataPreprocessing/pointColumns';
import { clearBakedDoi, isDoiBaked, setBakedDoi } from '../doiPropagation/bakedDoi';
import { computeRecordDistances } from '../doiPropagation/fieldDistanceCore';
import type { computeRecordDistancesInWorker } from '../doiPropagation/fieldDistanceWorker';
import {
  resetServerDoiState,
  runLocalFieldPropagation,
  setFalloffShape,
} from '../doiPropagation/serverPropagation';
import { bumpClusteringEpoch, runHdbscanClustering } from './hdbscanClustering';

const POINTS = [
  { x: 0.10, y: 0.10 },
  { x: 0.12, y: 0.11 },
  { x: 0.11, y: 0.12 },
  { x: 0.80, y: 0.80 },
  { x: 0.82, y: 0.79 },
  { x: 0.81, y: 0.81 },
];

/** Nodes after a labeled-mode commit: real capped strings on half the set —
 * the state the next BAKED commit leaves behind untouched. */
function makeStaleStringNodes(): DataPoint[] {
  return POINTS.map((p, i) => ({
    ...createEmptyDataPoint(),
    x: p.x,
    y: p.y,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: i < 3 ? 'inset' : 'transparent',
  })) as DataPoint[];
}

function mockWorkerFit() {
  mockFit.mockImplementation((...args: unknown[]) => {
    const coords = args[0] as number[][];
    const tree = buildHdbscanHierarchy(
      coords.map(([x, y]) => ({ x, y })),
      { minSamples: 1 }
    );
    return Promise.resolve({ tree });
  });
}

/** Inline runner: the pure core, no worker (jsdom). */
const inlineRunner: typeof computeRecordDistancesInWorker = async (input) =>
  computeRecordDistances(input).recordDist;

beforeEach(() => {
  mockFit.mockReset();
  clearBakedDoi();
  resetServerDoiState();
  setFalloffShape('log');
});

describe('baked-DoI visibility filter (#337)', () => {
  it('treats stale strings as uniformly visible while a bake is active', async () => {
    mockWorkerFit();
    const nodes = makeStaleStringNodes();
    setBakedDoi(new Float32Array(nodes.length).fill(1), {
      grayOutDoiThreshold: 0.05,
      annotationDoiThreshold: 0.7,
      insetDoiThreshold: 0.9,
    });

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // The stale "transparent" strings must NOT shrink the fit: all 6 points
    // reach the worker (the string filter would have passed only 3).
    expect(mockFit).toHaveBeenCalledTimes(1);
    expect((mockFit.mock.calls[0][0] as number[][]).length).toBe(nodes.length);
  });

  it('shrinks the fit to the ≥annotation subset of a NON-uniform baked field (#342)', async () => {
    mockWorkerFit();
    const nodes = makeStaleStringNodes();
    // Stale strings claim the FIRST three points are visible; the baked field
    // (fresh truth) focuses the LAST three. The fit must follow the field.
    setBakedDoi(new Float32Array([0.1, 0.1, 0.1, 1, 1, 1]), {
      grayOutDoiThreshold: 0.05,
      annotationDoiThreshold: 0.7,
      insetDoiThreshold: 0.9,
    });

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    expect(mockFit).toHaveBeenCalledTimes(1);
    const coords = mockFit.mock.calls[0][0] as number[][];
    expect(coords.length).toBe(3);
    expect(coords.map(([x]) => x)).toEqual([0.8, 0.82, 0.81]);
  });

  it('query-replay chain (#342): a focused field commit reclusters the matched points, not the full tree', async () => {
    // The rubik10 figure-link regression end to end minus the query parser:
    // a columnar dataset (the bake engages exactly as on manifest datasets),
    // a semantic selection (scattered seeds = blob A), the REAL field lane
    // (inline-runner seam), then the recluster. Pre-fix the bake made the
    // pass "uniformly visible" and the fit saw all 7 points.
    mockWorkerFit();
    const blobA = [
      { x: 0.0, selected: true },
      { x: 0.1, selected: true },
      { x: 0.2, selected: true },
      { x: 0.3, selected: false }, // halo: inside the falloff, above annotation
    ];
    const blobB = [{ x: 8.0, selected: false }, { x: 8.1, selected: false }, { x: 8.2, selected: false }];
    const nodes = [...blobA, ...blobB].map((p, i) => ({
      ...createEmptyDataPoint(),
      x: p.x,
      y: 0,
      id: i + 1,
      line: 0,
      DoI: 1,
      selected: p.selected,
      doiGroup: 'inset', // stale boot-uniform strings
    })) as DataPoint[];
    attachPointColumns(nodes);

    const applied = await runLocalFieldPropagation(
      nodes,
      {
        proximitySlider: 0.5, // log support r = s/5·M = 1.1 · 2 = 2.2 data units
        pastSlider: 0,
        futureSlider: 0,
        maxEmbeddingDistance: 11,
        grayOutDoiThreshold: 0.05,
        annotationDoiThreshold: 0.7,
        insetDoiThreshold: 0.9,
      },
      undefined,
      { runner: inlineRunner }
    );
    expect(applied).toBe(true);
    // The fixture must reproduce the manifest-dataset lane: the bake engaged.
    expect(isDoiBaked()).toBe(true);

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    expect(mockFit).toHaveBeenCalledTimes(1);
    const coords = mockFit.mock.calls[0][0] as number[][];
    // Exactly blob A (3 seeds + the ≥annotation halo point); blob B is out.
    expect(coords.length).toBe(4);
    expect(coords.every(([x]) => x < 1)).toBe(true);
  });

  it('keeps the string filter when the client owns DoI (no bake)', async () => {
    mockWorkerFit();
    const nodes = makeStaleStringNodes();

    const epoch = bumpClusteringEpoch();
    await runHdbscanClustering(nodes, undefined, epoch);

    // Labeled-mode commits clear the bake and write fresh strings — there
    // the filter is authoritative: only the 3 visible points are fitted.
    expect(mockFit).toHaveBeenCalledTimes(1);
    expect((mockFit.mock.calls[0][0] as number[][]).length).toBe(3);
  });
});
