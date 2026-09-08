/**
 * Server DoI revision expiry of carried-over candidate stamps (issue #315
 * A3 / P-d, plan §6e).
 *
 * The server only re-ships a cut candidate whose STABLE part changed
 * (`stats_server._stable_part` = size/stability/bbox/leafRanges/hull) —
 * `doiMass` is NOT part of it. So a candidate that merely moved (or did not
 * change at all) is carried over from the client's mirror, and when a new DoI
 * revision lands at an unchanged viewport it keeps the PREVIOUS revision's
 * mass: small newly-hot clusters score as cold and are filtered out.
 *
 * adoptPushedCut therefore wipes the stamp of every candidate carried over
 * across a `doiRevision` change; candidates shipped in that same frame's
 * `enter` keep their (fresh) stamp, and same-revision deltas are untouched.
 *
 * Mirrors clusteringService.serverDoiStamp.test.ts (rbush mock, fake provider).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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
  CutRequest,
  CutResponse,
  CutSubscriptionHandlers,
} from '../scaling.types';
import store, { initialClusterSettings, updateClusterSettings } from '../store';

const W = 800;
const H = 600;
/** Uniform per-point DoI — the client-side prefix mass of a [a, b) leaf range
 * is therefore exactly (b - a) * POINT_DOI. */
const POINT_DOI = 0.5;

function makeNodes(n: number): DataPoint[] {
  const nodes: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      ...createEmptyDataPoint(),
      x: (i + 0.5) / n,
      y: (i + 0.5) / n,
      id: i + 1,
      line: 0,
      DoI: POINT_DOI,
      doiGroup: 'inset' as const,
    });
  }
  return nodes;
}

function candidate(
  uid: string,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  leafRange: [number, number],
  doiMass?: number
): CutCandidate {
  return {
    uid,
    size: leafRange[1] - leafRange[0],
    stability: leafRange[1] - leafRange[0],
    bbox: box,
    leafRanges: [leafRange],
    doiMass,
  };
}

interface FakeProvider extends ClusterCutProvider {
  pending: Array<{ resolve: (r: CutResponse) => void; reject: (e: Error) => void }>;
  requests: CutRequest[];
}

function makeProvider(): FakeProvider {
  const provider: FakeProvider = {
    manifest: { kind: 'test', baseUrl: 'http://localhost:0' },
    pending: [],
    requests: [],
    cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
    getCut(request: CutRequest) {
      provider.requests.push(request);
      return new Promise<CutResponse>((resolve, reject) => {
        provider.pending.push({ resolve, reject });
      });
    },
    getLeafOrder: async () => new Uint32Array(0),
    cancel: () => {},
  };
  return provider;
}

interface SubProvider extends FakeProvider {
  handlers?: CutSubscriptionHandlers;
  pushed: Array<{ seq: number; key: string }>;
}

function makeSubProvider(): SubProvider {
  const provider = makeProvider() as SubProvider;
  provider.pushed = [];
  provider.subscribe = (_tree: CutRequest['tree'], handlers: CutSubscriptionHandlers) => {
    provider.handlers = handlers;
    return () => {};
  };
  provider.pushViewport = (_request: CutRequest, seq: number, key: string) => {
    provider.pushed.push({ seq, key });
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

const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);
const VIEW_A = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const VIEW_B = { minX: 0.05, minY: 0.05, maxX: 1.05, maxY: 1.05 };

const BOX_CARRIED = { minX: 0.2, minY: 0.2, maxX: 0.55, maxY: 0.55 };
const BOX_SHIPPED = { minX: 0.6, minY: 0.6, maxX: 0.95, maxY: 0.95 };

function run(svc: ClusteringService, viewbox: typeof VIEW_A) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Drive one service through a reset frame (revision `revision`) carrying a
 * stamped candidate '0xC' plus a stamped '0xS', and return everything the
 * revision-change tests need to push the follow-up delta.
 */
function bootWithStamps(revision: number | undefined) {
  const nodes = makeNodes(20);
  const provider = makeSubProvider();
  const svc = makeService(nodes, provider);

  run(svc, VIEW_A);
  const first = provider.pushed[0];
  provider.handlers!.onCut({
    seq: first.seq, tree: 'points', key: first.key, reset: true, leave: [], move: [],
    enter: [
      candidate('0xC', BOX_CARRIED, [0, 10], 42.5),
      candidate('0xS', BOX_SHIPPED, [10, 20], 7),
    ],
    doiRevision: revision, focus_active: true,
  });
  const booted = run(svc, VIEW_A).activeClusters;
  expect(booted.find((c) => c.uid === '0xC')?.doiMass).toBe(42.5);
  expect(booted.find((c) => c.uid === '0xS')?.doiMass).toBe(7);

  return { svc, provider };
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});
afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

describe('doiRevision expiry of carried-over candidate stamps (§6e)', () => {
  it('wipes carried-over stamps when the revision advances, keeps freshly shipped ones', () => {
    const { svc, provider } = bootWithStamps(3);

    // A new DoI revision at a (nearly) unchanged viewport: '0xC' only MOVES
    // (its stable part is untouched, so the server never re-ships it) while
    // '0xS' is re-shipped whole with a revision-4 stamp.
    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [candidate('0xS', BOX_SHIPPED, [8, 20], 99)],
      leave: [], move: [['0xC', 0.42, 0.42]],
      doiRevision: 4, focus_active: true,
    });

    const after = run(svc, VIEW_B).activeClusters;
    const carried = after.find((c) => c.uid === '0xC');
    const shipped = after.find((c) => c.uid === '0xS');
    // The move patch still applied — only the expired stamp is gone.
    expect(carried?.insetPos).toEqual([0.42, 0.42]);
    expect(carried?.doiMass).toBeUndefined();
    expect(shipped?.doiMass).toBe(99);
  });

  it('wipes a carried-over stamp even when the candidate did not move at all', () => {
    const { svc, provider } = bootWithStamps(3);

    // An empty delta (nothing entered, left or moved) under a new revision:
    // '0xC' and '0xS' are both carried, so both stamps expire.
    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [],
      doiRevision: 4, focus_active: true,
    });

    const after = run(svc, VIEW_B).activeClusters;
    expect(after.find((c) => c.uid === '0xC')?.doiMass).toBeUndefined();
    expect(after.find((c) => c.uid === '0xS')?.doiMass).toBeUndefined();
  });

  it('keeps stamps across a same-revision delta (byte-identical to before)', () => {
    const { svc, provider } = bootWithStamps(3);

    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [['0xC', 0.42, 0.42]],
      doiRevision: 3, focus_active: true,
    });

    const after = run(svc, VIEW_B).activeClusters;
    expect(after.find((c) => c.uid === '0xC')?.doiMass).toBe(42.5);
    expect(after.find((c) => c.uid === '0xS')?.doiMass).toBe(7);
  });

  it('treats an undefined revision as its own value (transitions expire, steady state does not)', () => {
    // Unstamped frames carry no doiMass at all, so the only thing to assert
    // is that the undefined↔number transitions neither crash nor keep a stale
    // stamp: a stamped boot followed by an UNSTAMPED delta expires the stamp.
    const { svc, provider } = bootWithStamps(3);

    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [['0xC', 0.42, 0.42]],
    });
    expect(run(svc, VIEW_B).activeClusters.find((c) => c.uid === '0xC')?.doiMass)
      .toBeUndefined();

    // …and an unstamped steady state stays inert (no crash, nothing to wipe).
    const nodes = makeNodes(20);
    const plainProvider = makeSubProvider();
    const plainSvc = makeService(nodes, plainProvider);
    run(plainSvc, VIEW_A);
    plainProvider.handlers!.onCut({
      seq: plainProvider.pushed[0].seq, tree: 'points', key: plainProvider.pushed[0].key,
      reset: true, leave: [], move: [], enter: [candidate('0xU', BOX_CARRIED, [0, 10])],
    });
    run(plainSvc, VIEW_B);
    plainProvider.handlers!.onCut({
      seq: plainProvider.pushed[1].seq, tree: 'points', key: plainProvider.pushed[1].key,
      enter: [], leave: [], move: [['0xU', 0.1, 0.1]],
    });
    const plain = run(plainSvc, VIEW_B).activeClusters.find((c) => c.uid === '0xU');
    expect(plain?.doiMass).toBeUndefined();
    expect(plain?.insetPos).toEqual([0.1, 0.1]);
  });

  it('scoring falls back to the client leaf-order prefix after a wipe', () => {
    const { svc, provider } = bootWithStamps(3);

    // While the stamp is live, clusterDoiMassFromPrefix short-circuits to it…
    const stamped = run(svc, VIEW_A).activeClusters.find((c) => c.uid === '0xC')!;
    expect(svc.clusterDoiMassFromPrefix(stamped)).toBe(42.5);

    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [['0xC', 0.42, 0.42]],
      doiRevision: 4, focus_active: true,
    });

    // …and after the wipe it computes the exact prefix mass over leaves
    // [0, 10) — 10 points at DoI 0.5 — the pre-stamp behavior.
    const wiped = run(svc, VIEW_B).activeClusters.find((c) => c.uid === '0xC')!;
    expect(wiped.doiMass).toBeUndefined();
    expect(svc.clusterDoiMassFromPrefix(wiped)).toBeCloseTo(10 * POINT_DOI, 10);
  });

  it('a pull response records its revision without wiping (full frontier, all stamps fresh)', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    provider.pending[0].resolve({
      tree: 'points',
      candidates: [candidate('0xP', BOX_CARRIED, [0, 10], 12.5)],
      doiRevision: 9,
    });
    await flushMicrotasks();

    const pulled = run(svc, VIEW_A).activeClusters.find((c) => c.uid === '0xP');
    expect(pulled?.doiMass).toBe(12.5);
  });
});
