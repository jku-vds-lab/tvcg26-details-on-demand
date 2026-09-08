/**
 * Server-select mode on the pull lane (issue #315 P7 S2,
 * plan-315-p7-server-select.md §4 / design-seam-first §4.1).
 *
 * The server walks, scores, gates, and selects; the client applies the ≤ budget
 * ANSWER. This suite pins the four things that adoption can silently get wrong:
 *
 *  1. request assembly — the `select` block's WIRE names + Redux values, and an
 *     echo that is the pool split of the last APPLIED frame;
 *  2. apply — actives, the server group split, and the rescued readout, with NO
 *     client scoring/hysteresis/classification in between (a frame active that
 *     the client scorer would have filtered still applies verbatim);
 *  3. echo bookkeeping — split by `reserved` (NOT `rescued`, plan §3b.1) and
 *     reset at the epoch/refit/dataset-switch site;
 *  4. the guards — doiRevision staleness (freeze + re-request),
 *     capability-absent fallback to the candidates lane, G9's midpoints split,
 *     and degradation to the freshest stash when a request dies.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
import * as fs from 'fs';
import * as path from 'path';
import { ClusteringService, setCommittedDoiRevisionProvider } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type {
  ClusterCutProvider,
  CutCandidate,
  CutRequest,
  CutResponse,
  CutSubscriptionHandlers,
  SelectCutRequest,
  SelectedActive,
  SelectFrame,
  SelectParams,
} from '../scaling.types';
import store, {
  initialClusterSettings,
  initialVisualizationSettings,
  updateClusterSettings,
  updateSettings,
} from '../store';
import { progressResetAll } from '../slices/progressSlice';

const W = 800;
const H = 600;

function makeNodes(n: number): DataPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    ...createEmptyDataPoint(),
    x: (i + 0.5) / n,
    y: (i + 0.5) / n,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: 'inset' as const,
  }));
}

/** One server-selected winner; every field the frame carries is explicit so a
 * schema drift on either side shows up here. */
function active(uid: string, overrides: Partial<SelectedActive> = {}): SelectedActive {
  return {
    uid,
    size: 10,
    stability: 10,
    saliency: 0.5,
    doiMass: 5,
    visibleMeanDoi: 0.95,
    group: 2,
    rescued: false,
    reserved: false,
    bbox: { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 },
    centroid: [0.4, 0.4],
    insetPos: [0.45, 0.45],
    leafRanges: [[0, 10]],
    hull: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6]],
    ...overrides,
  };
}

function frameOf(actives: SelectedActive[], overrides: Partial<SelectFrame> = {}): SelectFrame {
  return {
    tree: 'points',
    actives,
    borderScore: 0.25,
    examined: 1234,
    clipped: false,
    fallbackRanking: false,
    focusActive: false,
    doiRevision: null,
    serverMs: { score: 3, walk: 20 },
    ...overrides,
  };
}

function candidate(uid: string): CutCandidate {
  return {
    uid,
    size: 10,
    stability: 10,
    bbox: { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 },
    leafRanges: [[0, 10]],
  };
}

interface FakeProvider extends ClusterCutProvider {
  /** Select requests, in call order, with their resolvers. */
  selects: Array<{
    request: SelectCutRequest;
    key: string;
    resolve: (f: SelectFrame) => void;
    reject: (e: Error) => void;
  }>;
  /** Candidate-lane requests (must stay empty in select mode). */
  cuts: Array<{ key: string; resolve: (r: CutResponse) => void }>;
}

/**
 * `capabilities` decides the lane exactly the way the real CutProvider does
 * (own-property `selectCut` assigned only when the manifest advertises it).
 * The key deliberately ignores the echo — the production key does too (§6.2),
 * and the doiRevision re-request test depends on it.
 */
function makeProvider(
  capabilities: string[] = ['cut', 'select-cut'],
  opts: { selectCutWithoutCapability?: boolean } = {}
): FakeProvider {
  const provider = {
    manifest: { kind: 'test', baseUrl: 'http://localhost:0', capabilities },
    selects: [],
    cuts: [],
    cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
    getCut(request: CutRequest) {
      const key = provider.cutKey(request);
      return new Promise<CutResponse>((resolve) => {
        provider.cuts.push({ key, resolve });
      });
    },
    getLeafOrder: async () => new Uint32Array(0),
    cancel: () => {},
  } as unknown as FakeProvider;
  if (capabilities.includes('select-cut') || opts.selectCutWithoutCapability) {
    provider.selectCut = (request: SelectCutRequest) => {
      const key = provider.cutKey(request);
      return new Promise<SelectFrame>((resolve, reject) => {
        provider.selects.push({ request, key, resolve, reject });
      });
    };
  }
  return provider;
}

function makeSubCapable(provider: FakeProvider): FakeProvider & {
  pushed: number;
  handlers?: CutSubscriptionHandlers;
} {
  const sub = provider as FakeProvider & { pushed: number; handlers?: CutSubscriptionHandlers };
  sub.pushed = 0;
  sub.subscribe = (_tree: CutRequest['tree'], handlers: CutSubscriptionHandlers) => {
    sub.handlers = handlers;
    return () => {};
  };
  sub.pushViewport = () => {
    sub.pushed += 1;
    return true;
  };
  return sub;
}

function makeService(
  nodes: DataPoint[],
  provider: ClusterCutProvider,
  tree: CutRequest['tree'] = 'points'
): ClusteringService {
  const svc = new ClusteringService({
    minClusterSize: 1, minSamples: 1, alpha: 1.0, group: 'annotation',
  });
  svc.initServerCut(provider, tree, nodes.map((_, i) => i), nodes);
  return svc;
}

const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);

const VIEW_A = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const VIEW_B = { minX: 0.05, minY: 0.05, maxX: 1.05, maxY: 1.05 };

function run(svc: ClusteringService, viewbox: typeof VIEW_A, allowStale = true) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H, allowStale);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
  store.dispatch(progressResetAll());
  setCommittedDoiRevisionProvider(null);
});

afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
  setCommittedDoiRevisionProvider(null);
});

// ── 1. request assembly ──────────────────────────────────────────────────────

describe('server-select request assembly', () => {
  it('sends the select block with WIRE names and the current Redux values', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    store.dispatch(updateClusterSettings({
      maxActiveClusters: 7,
      chainRescueBudget: 2,
      stabilityWeight: 0.31,
      doiMassWeight: 0.52,
      footprintWeight: 0.23,
      doiDensityWeight: 0.44,
      labelMinFraction: 0.02,
      chainDoiThreshold: 0.8,
      hysteresisActivateFactor: 1.2,
      hysteresisDeactivateFactor: 0.75,
    }));
    store.dispatch(updateSettings({
      grayOutDoiThreshold: 0.06,
      annotationDoiThreshold: 0.71,
      insetDoiThreshold: 0.91,
    }));

    run(svc, VIEW_A);
    expect(provider.selects).toHaveLength(1);
    expect(provider.cuts).toHaveLength(0); // the candidate lane never fires
    const select: SelectParams = provider.selects[0].request.select;
    expect(select).toEqual({
      weights: { stability: 0.31, doiMass: 0.52, footprint: 0.23, doiDensity: 0.44 },
      labelMinFraction: 0.02,
      chainDoiThreshold: 0.8,
      budget: 7,
      chainRescueBudget: 2,
      hysteresis: { activate: 1.2, deactivate: 0.75 },
      thresholds: { grayOut: 0.06, annotation: 0.71, inset: 0.91 },
      actives: { main: [], rescue: [] },
      fmt: 'json',
      settled: true,
    });
    // The cut-request half is untouched by the select block.
    expect(provider.selects[0].request.tree).toBe('points');
    expect(provider.selects[0].request.viewbox).toEqual(VIEW_A);
  });

  it('echoes the APPLIED frame pools on the next request (contract b)', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([
      active('0x1'),
      active('0x2', { reserved: true, rescued: true }),
      // Rescue-ELIGIBLE but holding a MAIN slot: it must echo into `main`.
      active('0x3', { rescued: true, reserved: false }),
    ]));
    await flushMicrotasks();
    run(svc, VIEW_A); // applies the frame (same key)

    run(svc, VIEW_B);
    expect(provider.selects).toHaveLength(2);
    expect(provider.selects[1].request.select.actives).toEqual({
      main: ['0x1', '0x3'],
      rescue: ['0x2'],
    });
  });

  /**
   * S3 reverses the S2 pin that used to live here (select mode was pull-only
   * while the push lane still spoke candidate deltas): the subscription now
   * serves BOTH lanes, so a select-capable dataset pushes and pulls only as a
   * fallback. The push-lane guards live in clusteringService.selectPush.test.ts.
   */
  it('pushes the viewport instead of pulling when a stream is up (S3)', () => {
    const provider = makeSubCapable(makeProvider());
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    expect(svc.isCutSubscribed()).toBe(true);
    expect(provider.pushed).toBe(1);
    expect(provider.selects).toHaveLength(0); // no pull while the stream lives
  });

  it('keeps the midpoints tree on the candidates lane (G9)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider, 'midpoints');

    expect(svc.serverSelectMode).toBe(false);
    run(svc, VIEW_A);
    expect(provider.selects).toHaveLength(0);
    expect(provider.cuts).toHaveLength(1);
  });
});

// ── 2. frame apply ───────────────────────────────────────────────────────────

describe('server-select frame apply', () => {
  it('applies actives, the server group split and the rescued readout verbatim', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([
      active('0x1', { group: 2 }),
      active('0x2', { group: 1, leafRanges: [[10, 20]] }),
      active('0x3', { group: 0, rescued: true, reserved: true, size: 1, leafRanges: [[5, 6]] }),
    ]));
    await flushMicrotasks();

    const result = run(svc, VIEW_A);
    expect(result.activeClusters.map((c) => c.uid)).toEqual(['0x1', '0x2', '0x3']);
    expect(result.serverGroups).toEqual(new Map([['0x1', 2], ['0x2', 1], ['0x3', 0]]));
    expect(result.rescuedUids).toEqual(['0x3']);
    // Winner payload lands on the synthetic node: ranges, hull and inset seed.
    const first = result.activeClusters[0];
    expect([first.firstLeaf, first.lastLeaf]).toEqual([0, 10]);
    expect(first.precomputedHull).toHaveLength(3);
    expect(first.insetPos).toEqual([0.45, 0.45]);
    expect(svc.membersOfCluster(result.activeClusters[1])).toEqual(
      Array.from({ length: 10 }, (_, i) => 10 + i)
    );
    // No O(dataset) labels materialization on the answer lane.
    expect(result.labels).toEqual([]);
  });

  it('does not re-score the frame: an active the client scorer would drop still applies', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    // Outside the viewbox AND below any plausible min-area gate: the client
    // pipeline would filter it, the answer lane must not touch it.
    provider.selects[0].resolve(frameOf([
      active('0xOUT', {
        size: 1,
        bbox: { minX: 5, minY: 5, maxX: 5.0001, maxY: 5.0001 },
        leafRanges: [[3, 4]],
      }),
    ]));
    await flushMicrotasks();

    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xOUT']);
  });

  it('freezes on the last applied frame while a newer key is in flight (at rest)', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0xA')]));
    await flushMicrotasks();
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xA']);

    // At rest (allowStaleCut = false) a pass for a not-yet-answered viewport
    // keeps the current actives — one transition, no A-then-B flip.
    expect(run(svc, VIEW_B, false).activeClusters.map((c) => c.uid)).toEqual(['0xA']);
    provider.selects[1].resolve(frameOf([active('0xB')]));
    await flushMicrotasks();
    expect(run(svc, VIEW_B, false).activeClusters.map((c) => c.uid)).toEqual(['0xB']);
  });

  it('shows the freshest ARRIVED frame mid-gesture (stale key, no re-scoring)', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0xA')]));
    await flushMicrotasks();
    // Mid-gesture pass at a viewport whose frame is still in flight.
    expect(run(svc, VIEW_B, true).activeClusters.map((c) => c.uid)).toEqual(['0xA']);
  });
});

// ── 3. echo bookkeeping ──────────────────────────────────────────────────────

describe('server-select echo memory', () => {
  it('resets the echo on an epoch/refit re-init', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0x1'), active('0x2', { reserved: true })]));
    await flushMicrotasks();
    run(svc, VIEW_A);
    run(svc, VIEW_B);
    expect(provider.selects[1].request.select.actives.main).toEqual(['0x1']);

    // A refit renumbers uids: the echo must go with the hysteresis it mirrors.
    const next = makeProvider();
    svc.initServerCut(next, 'points', nodes.map((_, i) => i), nodes);
    run(svc, VIEW_A);
    expect(next.selects[0].request.select.actives).toEqual({ main: [], rescue: [] });
  });

  /**
   * The S1 golden fixture already pins, frame by frame, which echo the server
   * was given and which pool each winner won. Replaying its expected actives
   * through the client's echo memory therefore checks the two halves of
   * contract (b) against each other: if the split key ever drifts back to
   * `rescued`, the rescue-bearing cases below go red.
   */
  it('reproduces the golden fixture echo, frame by frame (contract b, §3b.1)', async () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../semanticZoom/__tests__/fixtures/p7select/golden.json'),
        'utf-8'
      )
    ) as {
      records: Array<{ id: number; line: number; x: number; y: number }>;
      leafOrder: number[];
      cases: Array<{
        name: string;
        frames: Array<{
          viewbox: { minX: number; minY: number; maxX: number; maxY: number };
          echo: { main: string[]; rescue: string[] };
          expected: { actives: Array<{ uid: string; reserved: boolean; rescued: boolean }> };
        }>;
      }>;
    };
    const nodes = makeNodes(fixture.records.length);

    for (const testCase of fixture.cases) {
      const provider = makeProvider();
      // The FAKE key folds the echo in so every fixture frame is its own
      // request even when the viewbox repeats (several cases hold the viewport
      // still to iterate hysteresis). Production deliberately does NOT —
      // scalingSeam.test.ts pins that.
      provider.cutKey = (request: CutRequest) =>
        JSON.stringify([
          request.viewbox,
          (request as SelectCutRequest).select?.actives ?? null,
        ]);
      const svc = new ClusteringService({
        minClusterSize: 1, minSamples: 1, alpha: 1.0, group: 'annotation',
      });
      svc.initServerCut(provider, 'points', fixture.leafOrder, nodes);

      let previous = { main: [] as string[], rescue: [] as string[] };
      for (let k = 0; k < testCase.frames.length; k++) {
        const frame = testCase.frames[k];
        const expected = {
          case: testCase.name, frame: k,
          main: frame.echo.main.slice().sort(),
          rescue: frame.echo.rescue.slice().sort(),
        };
        const before = provider.selects.length;
        run(svc, frame.viewbox);
        if (provider.selects.length === before) {
          // Fixed point (gap G5): identical viewbox AND identical echo, so the
          // client asks nothing new — assert the skip is benign, i.e. the
          // fixture's echo for this frame IS the one already in flight.
          expect(expected).toEqual({ ...expected, ...previous });
          continue;
        }
        const sent = provider.selects[before].request.select.actives;
        expect({
          case: testCase.name, frame: k,
          main: sent.main.slice().sort(),
          rescue: sent.rescue.slice().sort(),
        }).toEqual(expected);
        previous = { main: expected.main, rescue: expected.rescue };
        provider.selects[before].resolve(
          frameOf(
            frame.expected.actives.map((a) =>
              active(a.uid, { reserved: a.reserved, rescued: a.rescued })
            )
          )
        );
        await flushMicrotasks();
        run(svc, frame.viewbox); // apply → advance the echo
      }
    }
  });

  it('resetSemanticZoom clears the echo too', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0x1')]));
    await flushMicrotasks();
    run(svc, VIEW_A);

    svc.resetSemanticZoom();
    run(svc, VIEW_B);
    expect(provider.selects[1].request.select.actives).toEqual({ main: [], rescue: [] });
  });
});

// ── 4. guards ────────────────────────────────────────────────────────────────

describe('server-select doiRevision coherence (§1.5.3)', () => {
  it('freezes and re-requests when a frame is revision-stale', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    setCommittedDoiRevisionProvider(() => 5);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0xOLD')], { doiRevision: 3 }));
    await flushMicrotasks();

    // Nothing applied (no stash), and the SAME key is re-requested with the
    // current echo.
    expect(run(svc, VIEW_A).activeClusters).toHaveLength(0);
    expect(provider.selects).toHaveLength(2);
    expect(provider.selects[1].key).toBe(provider.selects[0].key);

    provider.selects[1].resolve(frameOf([active('0xNEW')], { doiRevision: 5 }));
    await flushMicrotasks();
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xNEW']);
  });

  it('applies a revision-0 / stateless frame as server truth (A2(i))', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    setCommittedDoiRevisionProvider(() => 9);

    run(svc, VIEW_A);
    provider.selects[0].resolve(frameOf([active('0xR0')], { doiRevision: 0 }));
    await flushMicrotasks();
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xR0']);
    expect(provider.selects).toHaveLength(1); // no re-request loop
  });
});

describe('capability-absent fallback', () => {
  it('runs the candidates lane byte-identically when "select-cut" is missing', async () => {
    const nodes = makeNodes(20);
    // Same object graph, only the capability differs.
    const capable = makeProvider(['cut', 'select-cut']);
    const incapable = makeProvider(['cut'], { selectCutWithoutCapability: true });
    const control = makeProvider(['cut']); // no selectCut at all

    const svcCapable = makeService(nodes, capable);
    const svcIncapable = makeService(nodes, incapable);
    const svcControl = makeService(nodes, control);

    expect(svcCapable.serverSelectMode).toBe(true);
    expect(svcIncapable.serverSelectMode).toBe(false);

    run(svcCapable, VIEW_A);
    run(svcIncapable, VIEW_A);
    run(svcControl, VIEW_A);
    // The incapable provider is never asked to select, and its request carries
    // no `select` block at all.
    expect(incapable.selects).toHaveLength(0);
    expect(incapable.cuts).toHaveLength(1);
    expect(capable.cuts).toHaveLength(0);

    incapable.cuts[0].resolve({ tree: 'points', candidates: [candidate('0x1')] });
    control.cuts[0].resolve({ tree: 'points', candidates: [candidate('0x1')] });
    await flushMicrotasks();

    const fallback = run(svcIncapable, VIEW_A);
    const reference = run(svcControl, VIEW_A);
    expect(fallback.activeClusters.map((c) => c.uid)).toEqual(
      reference.activeClusters.map((c) => c.uid)
    );
    expect(fallback.labels).toEqual(reference.labels);
    expect(fallback.rescuedUids).toEqual(reference.rescuedUids);
    // The classification pass stays client-side on the fallback lane.
    expect(fallback.serverGroups).toBeUndefined();
    expect(reference.serverGroups).toBeUndefined();
  });
});

describe('a dead select request degrades instead of freezing', () => {
  it('re-applies the freshest stash when the request dies', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    provider.selects[0].reject(new Error('service down'));
    await flushMicrotasks();
    // Nothing has ever landed, so there is nothing to degrade TO.
    expect(onCutReady).toHaveBeenCalledTimes(0);

    // With a stashed frame, a later failure re-applies it instead of freezing.
    run(svc, VIEW_A);
    provider.selects[1].resolve(frameOf([active('0xA')]));
    await flushMicrotasks();
    run(svc, VIEW_A);
    run(svc, VIEW_B);
    provider.selects[2].reject(new Error('service down'));
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(2); // frame apply + degrade
  });
});
