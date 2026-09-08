/**
 * Server-cut stash flow (issue #315 stuck-actives): during a continuous
 * gesture every settled tick fires a cut fetch for a fresh viewport, so each
 * response used to be "superseded" by the next tick's fetch and dropped —
 * actives froze at gesture-start state for the whole interaction. The fix is
 * freshest-wins adoption (every response newer than the current stash is
 * stashed, only out-of-order OLDER responses drop) plus stale-key scoring
 * (a pass whose exact fetch is still in flight scores the freshest arrived
 * frontier against the CURRENT viewbox instead of returning the last result).
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
import { ClusteringService } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type {
  ClusterCutProvider,
  CutCandidate,
  CutPushEvent,
  CutRequest,
  CutResponse,
  CutSubscriptionHandlers,
} from '../scaling.types';
import store, { initialClusterSettings, updateClusterSettings } from '../store';

// ── helpers ──────────────────────────────────────────────────────────────────

const W = 800;
const H = 600;

function makeNodes(n: number): DataPoint[] {
  const nodes: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      ...createEmptyDataPoint(),
      x: (i + 0.5) / n,
      y: (i + 0.5) / n,
      id: i + 1,
      line: 0,
      DoI: 1,
      doiGroup: 'inset' as const,
    });
  }
  return nodes;
}

/** A candidate whose bbox sits inside `box` (data space). */
function candidate(
  uid: string,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  leafRange: [number, number]
): CutCandidate {
  return {
    uid,
    size: leafRange[1] - leafRange[0],
    stability: leafRange[1] - leafRange[0],
    bbox: box,
    leafRanges: [leafRange],
  };
}

interface FakeProvider extends ClusterCutProvider {
  /** Resolvers by cutKey, in call order. */
  pending: Array<{ key: string; resolve: (r: CutResponse) => void; reject: (e: Error) => void }>;
  calls: string[];
}

function makeProvider(): FakeProvider {
  const provider: FakeProvider = {
    manifest: { kind: 'test', baseUrl: 'http://localhost:0' },
    pending: [],
    calls: [],
    cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
    getCut(request: CutRequest) {
      const key = provider.cutKey(request);
      provider.calls.push(key);
      return new Promise<CutResponse>((resolve, reject) => {
        provider.pending.push({ key, resolve, reject });
      });
    },
    getLeafOrder: async () => new Uint32Array(0),
    cancel: () => {},
  };
  return provider;
}

interface SubProvider extends FakeProvider {
  handlers?: CutSubscriptionHandlers;
  pushed: Array<{ request: CutRequest; seq: number; key: string; wantReset: boolean }>;
}

/** A provider that advertises the viewport-subscription capabilities, so the
 * service pushes instead of fetching. Captures pushes and the live handlers
 * so tests can drive the stream by hand. */
function makeSubProvider(): SubProvider {
  const provider = makeProvider() as SubProvider;
  provider.pushed = [];
  provider.subscribe = (_tree: CutRequest['tree'], handlers: CutSubscriptionHandlers) => {
    provider.handlers = handlers;
    return () => {};
  };
  provider.pushViewport = (
    request: CutRequest, seq: number, key: string, wantReset: boolean
  ) => {
    provider.pushed.push({ request, seq, key, wantReset });
    return true;
  };
  return provider;
}

function makeService(nodes: DataPoint[], provider: ClusterCutProvider): ClusteringService {
  const svc = new ClusteringService({ minClusterSize: 1, minSamples: 1, alpha: 1.0, group: 'annotation' });
  const leafOrder = nodes.map((_, i) => i);
  svc.initServerCut(provider, 'points', leafOrder, nodes);
  return svc;
}

/** Data→screen scales over the unit square (y inverted, screen orientation). */
const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);

const VIEW_A = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const VIEW_B = { minX: 0.05, minY: 0.05, maxX: 1.05, maxY: 1.05 };
const VIEW_C = { minX: 0.1, minY: 0.1, maxX: 1.1, maxY: 1.1 };

function run(svc: ClusteringService, viewbox: typeof VIEW_A) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('server-cut stash (freshest-wins, stale-key scoring)', () => {
  it('adopts a response even when a newer fetch already superseded it', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    // Tick 1 (viewport A) fires fetch A; tick 2 (viewport B) supersedes it.
    expect(run(svc, VIEW_A).activeClusters).toHaveLength(0);
    expect(run(svc, VIEW_B).activeClusters).toHaveLength(0);
    expect(provider.calls).toHaveLength(2);

    // A's response lands AFTER being superseded — it must still be adopted,
    // but it must NOT trigger a refresh (issue #315 at-rest flips: B's exact
    // fetch is in flight, and applying A's frontier then B's reshuffles the
    // actives twice at rest). Only B's arrival refreshes.
    const inBoth = candidate('0x1', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10]);
    provider.pending[0].resolve({ tree: 'points', candidates: [inBoth] });
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(0);

    // A pass at viewport B (whose exact fetch is still in flight) scores A's
    // frontier against B — the candidate is inside both, so it activates.
    const result = run(svc, VIEW_B);
    expect(result.activeClusters.map((c) => c.uid)).toEqual(['0x1']);

    // B's exact response (the freshest requested key) does refresh.
    provider.pending[1].resolve({ tree: 'points', candidates: [inBoth] });
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(1);
  });

  it('falls back to the stashed frontier when the freshest fetch dies', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    run(svc, VIEW_B);

    // A's response is adopted silently (B is in flight)…
    const inBoth = candidate('0x1', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10]);
    provider.pending[0].resolve({ tree: 'points', candidates: [inBoth] });
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(0);

    // …then B's fetch fails: the refresh must fire anyway so the view
    // degrades to A's stashed frontier instead of freezing pre-gesture.
    provider.pending[1].reject(new Error('service down'));
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(1);
  });

  it('drops out-of-order older responses (a newer stash wins)', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    run(svc, VIEW_B);

    // B resolves FIRST (newer request), then A (older) — A must be dropped.
    const fromB = candidate('0xB', { minX: 0.3, minY: 0.3, maxX: 0.7, maxY: 0.7 }, [0, 10]);
    const fromA = candidate('0xA', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [10, 20]);
    provider.pending[1].resolve({ tree: 'points', candidates: [fromB] });
    await flushMicrotasks();
    provider.pending[0].resolve({ tree: 'points', candidates: [fromA] });
    await flushMicrotasks();

    expect(onCutReady).toHaveBeenCalledTimes(1); // only B's arrival
    const result = run(svc, VIEW_B);
    expect(result.activeClusters.map((c) => c.uid)).toEqual(['0xB']);
  });

  it('viewport subscription: pushes instead of fetching; pushed frames score identically to pulled ones (H0 parity twin)', async () => {
    const nodes = makeNodes(20);

    // Pull-mode reference service.
    const pullProvider = makeProvider();
    const pullSvc = makeService(nodes, pullProvider);

    // Subscribed service: subscribe/pushViewport capabilities present.
    const subProvider = makeSubProvider();
    const subSvc = makeService(nodes, subProvider);
    const onCutReady = jest.fn();
    subSvc.setOnCutReady(onCutReady);

    // While subscribed, a settled tick streams the viewport up and NEVER
    // calls getCut (the H0 ledger gate: zero client-initiated cut fetches).
    run(subSvc, VIEW_A);
    expect(subProvider.calls).toHaveLength(0);
    expect(subProvider.pushed).toHaveLength(1);
    const { seq, key } = subProvider.pushed[0];

    // Identical candidates via push vs pull must score identically.
    const candidates = [
      candidate('0x1', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10]),
      candidate('0x2', { minX: 0.65, minY: 0.65, maxX: 0.9, maxY: 0.9 }, [10, 20]),
    ];
    subProvider.handlers!.onCut({
      seq, tree: 'points', key, enter: candidates, leave: [], reset: true,
    });
    expect(onCutReady).toHaveBeenCalledTimes(1);

    run(pullSvc, VIEW_A);
    pullProvider.pending[0].resolve({ tree: 'points', candidates });
    await flushMicrotasks();

    const pushedResult = run(subSvc, VIEW_A);
    const pulledResult = run(pullSvc, VIEW_A);
    expect(pushedResult.activeClusters.map((c) => c.uid))
      .toEqual(pulledResult.activeClusters.map((c) => c.uid));
    expect(pushedResult.activeClusters.map((c) => c.uid).sort()).toEqual(['0x1', '0x2']);
  });

  it('viewport subscription: drops stale frames (H1 supersede)', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc, VIEW_A);
    run(svc, VIEW_B);
    expect(provider.pushed).toHaveLength(2);
    const [first, second] = provider.pushed;
    const frame = (p: { seq: number; key: string }, uid: string): CutPushEvent => ({
      seq: p.seq, tree: 'points', key: p.key, reset: true, leave: [],
      enter: [candidate(uid, { minX: 0.3, minY: 0.3, maxX: 0.7, maxY: 0.7 }, [0, 10])],
    });

    // Newer frame lands first (server freshest-wins skipped the older walk,
    // but a slow older frame can still arrive late) — the older one drops.
    provider.handlers!.onCut(frame(second, '0xB'));
    expect(onCutReady).toHaveBeenCalledTimes(1);
    provider.handlers!.onCut(frame(first, '0xA'));
    expect(onCutReady).toHaveBeenCalledTimes(1);
    expect(run(svc, VIEW_B).activeClusters.map((c) => c.uid)).toEqual(['0xB']);
  });

  it('viewport subscription: applies enter/leave/move deltas onto the mirror (H1)', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);

    // The very first push must ask for a full frame — nothing to delta onto.
    run(svc, VIEW_A);
    expect(provider.pushed[0].wantReset).toBe(true);

    const stay = candidate('0xS', { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.5 }, [0, 10]);
    const goes = candidate('0xG', { minX: 0.55, minY: 0.55, maxX: 0.9, maxY: 0.9 }, [10, 20]);
    provider.handlers!.onCut({
      seq: provider.pushed[0].seq, tree: 'points', key: provider.pushed[0].key,
      reset: true, enter: [stay, goes], leave: [], move: [],
    });
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid).sort()).toEqual(['0xG', '0xS']);

    // A later push is a delta — and must NOT ask for a reset any more.
    run(svc, VIEW_B);
    const second = provider.pushed[1];
    expect(second.wantReset).toBe(false);

    // '0xG' leaves, '0xN' enters, '0xS' survives but moves.
    const arrives = candidate('0xN', { minX: 0.6, minY: 0.6, maxX: 0.85, maxY: 0.85 }, [10, 20]);
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [arrives], leave: ['0xG'], move: [['0xS', 0.42, 0.42]],
    });
    const after = run(svc, VIEW_B);
    expect(after.activeClusters.map((c) => c.uid).sort()).toEqual(['0xN', '0xS']);
    // The move patch landed on the mirrored candidate, not a re-ship.
    const moved = after.activeClusters.find((c) => c.uid === '0xS');
    expect(moved?.insetPos).toEqual([0.42, 0.42]);
  });

  it('viewport subscription: an unapplicable delta triggers a reset request, not a partial frontier', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    const first = provider.pushed[0];
    const stay = candidate('0xS', { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.5 }, [0, 10]);
    provider.handlers!.onCut({
      seq: first.seq, tree: 'points', key: first.key,
      reset: true, enter: [stay], leave: [], move: [],
    });

    // A move patch for a uid the mirror never held means the mirror and the
    // server's frontier diverged: keep the last good frontier and ask for a
    // full frame on the next push.
    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [['0xUNKNOWN', 0.1, 0.1]],
    });
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xS']);

    run(svc, VIEW_C);
    expect(provider.pushed[2].wantReset).toBe(true);
  });

  it('viewport subscription: a delta arriving with no mirror is ignored (H1 resync)', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    const first = provider.pushed[0];
    // Server sends a delta before any reset (should not happen, but a
    // reconnect race could): applying it would render a partial frontier.
    provider.handlers!.onCut({
      seq: first.seq, tree: 'points', key: first.key,
      enter: [candidate('0xX', { minX: 0.2, minY: 0.2, maxX: 0.5, maxY: 0.5 }, [0, 10])],
      leave: [], move: [],
    });
    expect(run(svc, VIEW_A).activeClusters).toHaveLength(0);
    // Still asking for a full frame.
    run(svc, VIEW_B);
    expect(provider.pushed[1].wantReset).toBe(true);
  });

  it('viewport subscription: falls back to the pull path when the stream goes down', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    expect(provider.pushed).toHaveLength(1);
    expect(provider.calls).toHaveLength(0);
    expect(svc.isCutSubscribed()).toBe(true);

    // Stream drops: the pushed answer for VIEW_A will never arrive, so the
    // in-flight key must clear — the SAME viewport refetches via pull.
    provider.handlers!.onDown();
    run(svc, VIEW_A);
    expect(provider.calls).toHaveLength(1);
    expect(provider.pushed).toHaveLength(1); // no further pushes
    // The refresh defer keys off this (issue #315 H3): once cuts are pulled
    // again the caller must go back to the full arrival-coalescing wait.
    expect(svc.isCutSubscribed()).toBe(false);
  });

  it('isCutSubscribed reports false for a provider without push capabilities', () => {
    const svc = makeService(makeNodes(20), makeProvider());
    expect(svc.isCutSubscribed()).toBe(false);
  });

  it('viewport subscription: a dead registry entry (pushViewport false) falls through to pull in the same tick', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    provider.pushViewport = () => false;
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    expect(provider.calls).toHaveLength(1); // pulled immediately
  });

  it('drops stale-stash actives that left the current viewport', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    // Candidate near A's left edge — outside viewport C.
    const leftEdge = candidate('0xE', { minX: 0.0, minY: 0.2, maxX: 0.08, maxY: 0.6 }, [0, 10]);
    provider.pending[0].resolve({ tree: 'points', candidates: [leftEdge] });
    await flushMicrotasks();

    // Exact-key pass at A activates it…
    expect(run(svc, VIEW_A).activeClusters.map((c) => c.uid)).toEqual(['0xE']);
    // …but a pan to C (stale-key pass over the same stash) must drop it —
    // the scorer filters with the CURRENT viewbox.
    expect(run(svc, VIEW_C).activeClusters).toHaveLength(0);
  });
});
