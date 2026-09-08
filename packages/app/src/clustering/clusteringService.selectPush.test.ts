/**
 * Server-select on the PUSH lane (issue #315 P7 S3,
 * plan-315-p7-server-select.md §4 / design-seam-first §1.3).
 *
 * S2 answered zooms with a pull, so every settle paid a full RTT before insets
 * appeared. S3 puts the answer lane back on the subscription: the viewport
 * streams up mid-gesture and `event: sel` full frames stream down, so the frame
 * for the destination is usually already stashed when the gesture settles — and
 * a DoI commit pushes a fresh selection with NO client request at all (A3).
 *
 * What this suite pins:
 *  1. lane choice — a live stream means push, not pull, and the push carries the
 *     `select` block with the current echo;
 *  2. the drop rules (plan A2's matrix + A3's seq contract): older seq dropped,
 *     same-seq duplicate dropped, same-seq re-select with a NEWER doiRevision
 *     applied over the already-applied frame, revision-stale frame re-asked;
 *  3. arrival semantics — pushed frames land in the same stash the pull lane
 *     uses, so key-at-rest and freshest-arrived-mid-gesture behaviour are the
 *     same code path;
 *  4. the wheel-destination prefetch rides the select lane: the settle pass
 *     applies a frame that arrived without asking for it again;
 *  5. stream death falls back to the pull lane.
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
      search() { return this.items; }
    },
  };
});

import * as d3 from 'd3';
import { ClusteringService, setCommittedDoiRevisionProvider } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type {
  ClusterCutProvider,
  CutPushEvent,
  CutRequest,
  CutResponse,
  CutSubscriptionHandlers,
  SelectCutRequest,
  SelectFrame,
  SelectPushEvent,
  SelectedActive,
} from '../scaling.types';
import store, {
  initialClusterSettings,
  initialVisualizationSettings,
  setServerLossWarning,
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
    hull: null,
    ...overrides,
  };
}

/** One pushed `sel` envelope: the frame plus seq/key/subOrdinal. */
function pushFrame(
  uids: string[],
  envelope: { seq: number; key: string; subOrdinal: number } & Partial<SelectPushEvent>
): SelectPushEvent {
  return {
    tree: 'points',
    actives: uids.map((uid) => active(uid)),
    borderScore: 0.25,
    examined: 1234,
    clipped: false,
    fallbackRanking: false,
    focusActive: false,
    doiRevision: null,
    serverMs: { score: 3, walk: 20, wait: 1 },
    ...envelope,
  };
}

interface PushProvider extends ClusterCutProvider {
  /** Every viewport push, in order. */
  pushes: Array<{ request: CutRequest | SelectCutRequest; seq: number; key: string }>;
  /** Pull-lane select requests (the fallback) with their resolvers. */
  selects: Array<{ request: SelectCutRequest; key: string; resolve: (f: SelectFrame) => void }>;
  handlers?: CutSubscriptionHandlers;
  /** Flip to false to simulate a dead registry entry (pushViewport → false). */
  live: boolean;
  unsubscribed: number;
}

function makeProvider(capabilities: string[] = ['cut', 'select-cut']): PushProvider {
  const provider = {
    manifest: { kind: 'test', baseUrl: 'http://localhost:0', datasetId: 'd1', capabilities },
    pushes: [],
    selects: [],
    live: true,
    unsubscribed: 0,
    // The production key folds the select SCALARS in but never the echo (§6.2);
    // the viewbox alone reproduces that for these tests.
    cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
    getCut(request: CutRequest) {
      return new Promise<CutResponse>(() => {
        void request;
      });
    },
    getLeafOrder: async () => new Uint32Array(0),
    cancel: () => {},
    subscribe(_tree: CutRequest['tree'], handlers: CutSubscriptionHandlers) {
      provider.handlers = handlers;
      return () => {
        provider.unsubscribed += 1;
      };
    },
    pushViewport(request: CutRequest | SelectCutRequest, seq: number, key: string) {
      if (!provider.live) return false;
      provider.pushes.push({ request, seq, key });
      return true;
    },
  } as unknown as PushProvider;
  if (capabilities.includes('select-cut')) {
    provider.selectCut = (request: SelectCutRequest) => {
      const key = provider.cutKey(request);
      return new Promise<SelectFrame>((resolve) => {
        provider.selects.push({ request, key, resolve });
      });
    };
  }
  return provider;
}

function makeService(nodes: DataPoint[], provider: ClusterCutProvider): ClusteringService {
  const svc = new ClusteringService({
    minClusterSize: 1, minSamples: 1, alpha: 1.0, group: 'annotation',
  });
  svc.initServerCut(provider, 'points', nodes.map((_, i) => i), nodes);
  return svc;
}

const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);

const VIEW_A = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const VIEW_B = { minX: 0.05, minY: 0.05, maxX: 1.05, maxY: 1.05 };
const KEY_A = JSON.stringify(VIEW_A);
const KEY_B = JSON.stringify(VIEW_B);

function run(svc: ClusteringService, viewbox: typeof VIEW_A, allowStale = true) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H, allowStale);
}

const uidsOf = (result: { activeClusters: Array<{ uid?: string }> }) =>
  result.activeClusters.map((c) => c.uid);

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
  store.dispatch(progressResetAll());
  store.dispatch(setServerLossWarning(null));
  setCommittedDoiRevisionProvider(null);
});

// ── 1. lane choice ───────────────────────────────────────────────────────────

describe('select push lane', () => {
  it('pushes the select block up instead of pulling, at the gesture cadence', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    expect(svc.isCutSubscribed()).toBe(true);
    expect(provider.selects).toHaveLength(0);
    expect(provider.pushes).toHaveLength(1);
    const request = provider.pushes[0].request as SelectCutRequest;
    expect(request.select.budget).toBe(initialClusterSettings.maxActiveClusters);
    expect(request.select.actives).toEqual({ main: [], rescue: [] });
    expect(provider.pushes[0].key).toBe(KEY_A);
    expect(provider.pushes[0].seq).toBe(1);

    // One push per distinct question — a repeat pass for the same key is
    // coalesced exactly like the pull lane's in-flight key.
    run(svc, VIEW_A);
    expect(provider.pushes).toHaveLength(1);
    run(svc, VIEW_B);
    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[1].seq).toBe(2);
  });

  it('carries the APPLIED frame pools as the echo on the next push (contract b)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!({
      ...pushFrame([], { seq: 1, key: KEY_A, subOrdinal: 1 }),
      actives: [
        active('0x1'),
        active('0x2', { reserved: true, rescued: true }),
        active('0x3', { rescued: true }),
      ],
    });
    run(svc, VIEW_A); // apply → advance the echo

    run(svc, VIEW_B);
    const request = provider.pushes[1].request as SelectCutRequest;
    expect(request.select.actives).toEqual({ main: ['0x1', '0x3'], rescue: ['0x2'] });
  });

  it('ignores a candidate `cut` frame in select mode instead of mixing lanes', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xSEL'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xSEL']);

    // An older server that ignored the unknown `select` field would answer with
    // candidates; adopting them under a select stash key would mix the lanes.
    const stale: CutPushEvent = {
      seq: 2, tree: 'points', key: KEY_A,
      enter: [{ uid: '0xCAND', size: 5, stability: 1, bbox: null, leafRanges: [[0, 5]] }],
      leave: [], move: [], reset: true,
    };
    provider.handlers!.onCut(stale);
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xSEL']);
  });
});

// ── 2. arrival semantics: the same guards as the pull lane ───────────────────

describe('pushed frame apply', () => {
  it('applies through the pull lane guards: key-at-rest, then the exact frame', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xA']);

    // At rest, a pass for a not-yet-answered viewport keeps the current actives.
    expect(uidsOf(run(svc, VIEW_B, false))).toEqual(['0xA']);
    provider.handlers!.onSelect!(pushFrame(['0xB'], { seq: 2, key: KEY_B, subOrdinal: 2 }));
    expect(uidsOf(run(svc, VIEW_B, false))).toEqual(['0xB']);
  });

  it('stashes a mid-gesture arrival and applies it at rest (one transition)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    run(svc, VIEW_A);

    // Mid-gesture tick for the next viewport: the frame for B arrives while the
    // gesture is still running. The service stashes it; the CALLER's
    // gesture-deferred refresh (scheduleCutRefresh) decides when to apply.
    run(svc, VIEW_B);
    onCutReady.mockClear();
    provider.handlers!.onSelect!(pushFrame(['0xB'], { seq: 2, key: KEY_B, subOrdinal: 2 }));
    expect(onCutReady).toHaveBeenCalledTimes(1);
    // A mid-gesture pass (allowStale) shows the freshest ARRIVED frame; the
    // settle pass for the same key applies exactly it — no A-then-B flip.
    expect(uidsOf(run(svc, VIEW_B, true))).toEqual(['0xB']);
    expect(uidsOf(run(svc, VIEW_B, false))).toEqual(['0xB']);
  });

  it('drops an out-of-order older frame', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    run(svc, VIEW_B);
    provider.handlers!.onSelect!(pushFrame(['0xB'], { seq: 2, key: KEY_B, subOrdinal: 2 }));
    expect(uidsOf(run(svc, VIEW_B))).toEqual(['0xB']);

    // A late frame for the superseded viewport must not resurrect it.
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    expect(uidsOf(run(svc, VIEW_B))).toEqual(['0xB']);
  });

  it('drops an aborted frame without touching the applied actives', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    run(svc, VIEW_A);
    run(svc, VIEW_B);
    provider.handlers!.onSelect!({
      ...pushFrame([], { seq: 2, key: KEY_B, subOrdinal: 2 }),
      aborted: true,
    });
    expect(uidsOf(run(svc, VIEW_B))).toEqual(['0xA']);
  });
});

// ── 3. A3 — the server-initiated re-select ──────────────────────────────────

describe('A3 server-initiated re-select', () => {
  it('lets a same-seq frame with a NEWER doiRevision beat the applied frame', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(
      pushFrame(['0xCOLD'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 4 })
    );
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xCOLD']);

    // The DoI commit's frame: same seq (the server cannot invent a newer one),
    // newer subOrdinal, newer revision, `reselect` marker. It must win.
    provider.handlers!.onSelect!(
      pushFrame(['0xHOT'], {
        seq: 1, key: KEY_A, subOrdinal: 2, doiRevision: 7, reselect: 'doi',
      })
    );
    expect(uidsOf(run(svc, VIEW_A, false))).toEqual(['0xHOT']);
  });

  it('refreshes without any client request in flight (the whole point of A3)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(
      pushFrame(['0xCOLD'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 4 })
    );
    run(svc, VIEW_A);
    // A newer viewport is in flight, so the re-select answers a key nobody is
    // waiting on — it must STILL trigger a refresh.
    run(svc, VIEW_B);
    onCutReady.mockClear();
    const pushesBefore = provider.pushes.length;

    provider.handlers!.onSelect!(
      pushFrame(['0xHOT'], {
        seq: 1, key: KEY_A, subOrdinal: 2, doiRevision: 7, reselect: 'doi',
      })
    );
    expect(onCutReady).toHaveBeenCalledTimes(1);
    expect(provider.pushes).toHaveLength(pushesBefore); // nothing was asked
    expect(uidsOf(run(svc, VIEW_A, false))).toEqual(['0xHOT']);
  });

  it('drops a same-seq duplicate that carries no newer revision', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(
      pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 4 })
    );
    run(svc, VIEW_A);
    svc.setOnCutReady(onCutReady);

    // Same seq, newer ordinal, SAME revision — a re-send, not an answer.
    provider.handlers!.onSelect!(
      pushFrame(['0xDUP'], {
        seq: 1, key: KEY_A, subOrdinal: 2, doiRevision: 4, reselect: 'doi',
      })
    );
    // …and an older ordinal, whatever the revision.
    provider.handlers!.onSelect!(
      pushFrame(['0xOLDER'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 9 })
    );
    expect(onCutReady).not.toHaveBeenCalled();
    expect(uidsOf(run(svc, VIEW_A, false))).toEqual(['0xA']);
  });

  it('freezes and re-asks when a pushed frame is revision-stale (§1.5.3)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    setCommittedDoiRevisionProvider(() => 5);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(
      pushFrame(['0xOLD'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 3 })
    );
    // Nothing applied, and the SAME question re-asked (same key, fresh echo).
    expect(run(svc, VIEW_A).activeClusters).toHaveLength(0);
    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[1].key).toBe(KEY_A);

    provider.handlers!.onSelect!(
      pushFrame(['0xNEW'], { seq: 2, key: KEY_A, subOrdinal: 2, doiRevision: 5 })
    );
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xNEW']);
  });

  it('applies a revision-0 pushed frame as server truth (A2(i))', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    setCommittedDoiRevisionProvider(() => 9);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(
      pushFrame(['0xR0'], { seq: 1, key: KEY_A, subOrdinal: 1, doiRevision: 0 })
    );
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xR0']);
    expect(provider.pushes).toHaveLength(1); // no re-ask loop
  });
});

// ── 4. the wheel-destination prefetch rides the select lane ─────────────────

describe('destination prefetch on the select lane', () => {
  it('stashes the destination frame so the settle pass never asks again', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    run(svc, VIEW_A);

    // Mid-burst: App pushes the wheel DESTINATION viewport (not the eased one).
    svc.prefetchCut(VIEW_B, W, H);
    expect(provider.pushes).toHaveLength(2);
    const destination = provider.pushes[1].request as SelectCutRequest;
    expect(destination.viewbox).toEqual(VIEW_B);
    // Same `settled` bit as the settle-time request — `settled` is part of the
    // cut key, so flipping it here would throw the prefetched frame away.
    expect(destination.select.settled).toBe(true);

    provider.handlers!.onSelect!(pushFrame(['0xB'], { seq: 2, key: KEY_B, subOrdinal: 2 }));

    // The settle pass applies the already-stashed answer and issues nothing.
    expect(uidsOf(run(svc, VIEW_B, false))).toEqual(['0xB']);
    expect(provider.pushes).toHaveLength(2);
    expect(provider.selects).toHaveLength(0);
  });
});

// ── 5. stream death → pull ──────────────────────────────────────────────────

describe('stream death', () => {
  it('falls back to the select PULL lane when the subscription drops', async () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);

    run(svc, VIEW_A);
    provider.handlers!.onSelect!(pushFrame(['0xA'], { seq: 1, key: KEY_A, subOrdinal: 1 }));
    expect(uidsOf(run(svc, VIEW_A))).toEqual(['0xA']);

    provider.handlers!.onDown();
    expect(svc.isCutSubscribed()).toBe(false);

    run(svc, VIEW_B);
    expect(provider.pushes).toHaveLength(1); // no further pushes
    expect(provider.selects).toHaveLength(1);
    provider.selects[0].resolve({
      tree: 'points',
      actives: [active('0xPULL')],
      borderScore: 0.1,
      examined: 5,
      clipped: false,
      fallbackRanking: false,
      focusActive: false,
      doiRevision: null,
    });
    await flushMicrotasks();
    expect(uidsOf(run(svc, VIEW_B))).toEqual(['0xPULL']);
  });

  it('pulls when the registry entry is already dead (pushViewport false)', () => {
    const provider = makeProvider();
    const svc = makeService(makeNodes(20), provider);
    provider.live = false;

    run(svc, VIEW_A);
    expect(provider.pushes).toHaveLength(0);
    expect(provider.selects).toHaveLength(1);
    expect(svc.isCutSubscribed()).toBe(false);
  });

  // §8.8d (2026-08-05): the interaction-triggered banner arrived seconds
  // late — stream loss now probes /health and warns IMMEDIATELY when the
  // server is unreachable, before any further interaction.
  it('warns server loss when the down-stream probe finds the server unreachable', async () => {
    const provider = makeProvider();
    let resolveProbe!: (ok: boolean) => void;
    (provider as { probeHealth?: () => Promise<boolean> }).probeHealth = () =>
      new Promise<boolean>((resolve) => { resolveProbe = resolve; });
    const svc = makeService(makeNodes(20), provider);
    run(svc, VIEW_A);

    provider.handlers!.onDown();
    expect(store.getState().ui.serverLossWarning).toBeNull();
    resolveProbe(false);
    await flushMicrotasks();
    expect(store.getState().ui.serverLossWarning).not.toBeNull();
  });

  it('stays silent when the probe answers healthy, or when the dataset moved on', async () => {
    const provider = makeProvider();
    let resolveProbe!: (ok: boolean) => void;
    (provider as { probeHealth?: () => Promise<boolean> }).probeHealth = () =>
      new Promise<boolean>((resolve) => { resolveProbe = resolve; });
    const svc = makeService(makeNodes(20), provider);
    run(svc, VIEW_A);

    provider.handlers!.onDown();
    resolveProbe(true); // transient stream drop, server alive
    await flushMicrotasks();
    expect(store.getState().ui.serverLossWarning).toBeNull();

    // Re-subscribe, drop again — but a dataset switch replaces the provider
    // before the probe resolves: the stale probe must not warn.
    run(svc, VIEW_A);
    provider.handlers!.onDown();
    svc.initServerCut(makeProvider(), 'points', [0, 1], makeNodes(2));
    resolveProbe(false);
    await flushMicrotasks();
    expect(store.getState().ui.serverLossWarning).toBeNull();
  });
});
