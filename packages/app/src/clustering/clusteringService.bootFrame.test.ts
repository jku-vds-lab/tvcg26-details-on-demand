/**
 * Boot warm-frame adoption (issue #315 insets-at-boot I1,
 * plan-315-insets-at-boot.md).
 *
 * The boot warmer's subscription receives the server's full boot-viewport
 * select frame while the dataset is still downloading; `initServerCut` takes
 * it (optional provider hook `takeBootSelectFrame`) and adopts it as the
 * seq-0 stash. This suite pins the semantics that adoption can silently get
 * wrong:
 *
 *  1. the first settled pass applies the boot frame WITHOUT waiting for any
 *     request to resolve;
 *  2. the live lane still REGISTERS its select question (one push/pull fires
 *     despite the stash-key hit — A3 reselects and content memory need it);
 *  3. the registration answer, when identical, is bookkeeping-only
 *     (`sel:bootDup` — no second refresh, no second O(members) apply);
 *  4. a DIFFERENT real frame supersedes the boot frame normally;
 *  5. a fit-tagged boot frame is rejected (vocabulary mismatch).
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
import { ClusteringService, setCommittedDoiRevisionProvider } from './clusteringService';
import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import type {
  ClusterCutProvider,
  CutRequest,
  CutResponse,
  CutSubscriptionHandlers,
  SelectCutRequest,
  SelectedActive,
  SelectFrame,
  SelectPushEvent,
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
    ...overrides,
  };
}

interface FakeProvider extends ClusterCutProvider {
  selects: Array<{
    request: SelectCutRequest;
    key: string;
    resolve: (f: SelectFrame) => void;
    reject: (e: Error) => void;
  }>;
  cuts: Array<{ key: string; resolve: (r: CutResponse) => void }>;
  pushed: number;
  handlers?: CutSubscriptionHandlers;
  bootFrame: SelectPushEvent | null;
}

/** Sub-capable select provider with a stashed boot frame (single-consume,
 * like the real `CutProvider.takeBootSelectFrame`). */
function makeProvider(bootFrame: SelectPushEvent | null): FakeProvider {
  const provider = {
    manifest: { kind: 'test', baseUrl: 'http://localhost:0', capabilities: ['cut', 'select-cut'] },
    selects: [],
    cuts: [],
    pushed: 0,
    bootFrame,
    cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
    getCut(request: CutRequest) {
      const key = provider.cutKey(request);
      return new Promise<CutResponse>((resolve) => {
        provider.cuts.push({ key, resolve });
      });
    },
    getLeafOrder: async () => new Uint32Array(0),
    cancel: () => {},
    takeBootSelectFrame: () => {
      const taken = provider.bootFrame;
      provider.bootFrame = null;
      return taken;
    },
  } as unknown as FakeProvider;
  provider.selectCut = (request: SelectCutRequest) => {
    const key = provider.cutKey(request);
    return new Promise<SelectFrame>((resolve, reject) => {
      provider.selects.push({ request, key, resolve, reject });
    });
  };
  return provider;
}

function withSubscription(provider: FakeProvider): FakeProvider {
  provider.subscribe = (_tree: CutRequest['tree'], handlers: CutSubscriptionHandlers) => {
    provider.handlers = handlers;
    return () => {};
  };
  provider.pushViewport = () => {
    provider.pushed += 1;
    return true;
  };
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

function run(svc: ClusteringService, viewbox = VIEW_A, allowStale = true) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H, allowStale);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The boot key must be what the first real request asks (the warmer and the
 * service share `buildSelectParams`; the fake key is the viewbox). */
const BOOT_KEY = JSON.stringify(VIEW_A);

function bootEvent(
  actives: SelectedActive[],
  overrides: Partial<SelectPushEvent> = {}
): SelectPushEvent {
  return { ...frameOf(actives), seq: 1, key: BOOT_KEY, subOrdinal: 1, ...overrides };
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

describe('boot warm-frame adoption', () => {
  it('applies the boot frame on the first pass without any request resolving', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa'), active('0xb')])));
    const svc = makeService(makeNodes(20), provider);

    const result = run(svc);

    expect(result.activeClusters.map((c) => c.uid)).toEqual(['0xa', '0xb']);
    expect(result.serverGroups?.get('0xa')).toBe(2);
    // Nothing resolved: the answer came from the adopted stash alone.
    expect(provider.selects).toHaveLength(0);
  });

  it('still registers the select question: exactly one push despite the stash-key hit', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const svc = makeService(makeNodes(20), provider);

    run(svc);
    expect(provider.pushed).toBe(1);
    // One-shot: the next pass with the same key does not re-push.
    run(svc);
    expect(provider.pushed).toBe(1);
  });

  it('marks the registration push — and ONLY it — with `registration: true`', () => {
    // Ack fix (issue #315, 2026-08-03): the server acks an identical re-ask
    // only when the asker declares it holds the frame. The boot registration
    // holds the adopted stash, so it carries the marker; any ask made
    // without a boot stash (a warm first ask, a plain boot) must not.
    const withStash = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const pushedRequests: Array<CutRequest | SelectCutRequest> = [];
    withStash.pushViewport = (request) => {
      pushedRequests.push(request);
      return true;
    };
    run(makeService(makeNodes(20), withStash));
    expect(pushedRequests).toHaveLength(1);
    expect((pushedRequests[0] as SelectCutRequest).registration).toBe(true);

    const noStash = withSubscription(makeProvider(null));
    const bareRequests: Array<CutRequest | SelectCutRequest> = [];
    noStash.pushViewport = (request) => {
      bareRequests.push(request);
      return true;
    };
    run(makeService(makeNodes(20), noStash));
    expect(bareRequests).toHaveLength(1);
    expect((bareRequests[0] as SelectCutRequest).registration).toBeUndefined();
  });

  it('suppresses the identical registration answer (no second refresh)', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa'), active('0xb')])));
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc);
    // The server re-pushes the identical answer to the registration ask.
    provider.handlers!.onSelect!(bootEvent([active('0xa'), active('0xb')]));
    expect(onCutReady).toHaveBeenCalledTimes(0);

    // The suppression is one-shot: a LATER identical push refreshes normally.
    provider.handlers!.onSelect!(
      bootEvent([active('0xa'), active('0xb')], { seq: 2, subOrdinal: 2 })
    );
    expect(onCutReady).toHaveBeenCalledTimes(1);
  });

  it('suppresses the identical registration answer on the PULL lane too', async () => {
    const provider = makeProvider(bootEvent([active('0xa')])); // no subscription
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc);
    expect(provider.selects).toHaveLength(1); // registration pull fired
    provider.selects[0].resolve(frameOf([active('0xa')]));
    await flushMicrotasks();
    expect(onCutReady).toHaveBeenCalledTimes(0);
  });

  it('a DIFFERENT registration answer supersedes the boot frame normally', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc);
    provider.handlers!.onSelect!(bootEvent([active('0xc'), active('0xd')]));
    expect(onCutReady).toHaveBeenCalledTimes(1);
    const result = run(svc);
    expect(result.activeClusters.map((c) => c.uid)).toEqual(['0xc', '0xd']);
  });

  it('rejects a fit-tagged boot frame (vocabulary mismatch)', () => {
    const provider = withSubscription(
      makeProvider(bootEvent([active('0xa')], { key: `cut:x:fit=abc:${BOOT_KEY}` }))
    );
    const svc = makeService(makeNodes(20), provider);

    const result = run(svc);
    // No stash: frozen degradation (empty result), the real ask is in flight.
    expect(result.activeClusters).toHaveLength(0);
    expect(provider.pushed).toBe(1);
  });

  it('boots unchanged when the provider has no boot frame', () => {
    const provider = withSubscription(makeProvider(null));
    const svc = makeService(makeNodes(20), provider);

    const result = run(svc);
    expect(result.activeClusters).toHaveLength(0);
    expect(provider.pushed).toBe(1);
    // The pushed answer applies through the normal lane.
    provider.handlers!.onSelect!(bootEvent([active('0xe')]));
    const after = run(svc);
    expect(after.activeClusters.map((c) => c.uid)).toEqual(['0xe']);
  });
});

describe('registration-ack (issue #315 insets-at-boot I3b)', () => {
  const ledgerEvents = () =>
    window.__insetLedger!.snapshot().events.map((e) => e.name);

  beforeEach(() => window.__insetLedger!.reset());

  it('adopts the ack bookkeeping and consumes the boot-dup one-shot', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa'), active('0xb')])));
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc); // applies the boot stash + fires the registration push (seq 1)
    provider.handlers!.onSelectAck!({ seq: 1, key: BOOT_KEY, subOrdinal: 0 });
    expect(onCutReady).toHaveBeenCalledTimes(0);
    expect(ledgerEvents()).toContain('sel:bootAck');

    // One-shot consumed: a LATER identical push adopts through the NORMAL
    // lane (select:stash), never the boot-dup suppression.
    provider.handlers!.onSelect!(
      bootEvent([active('0xa'), active('0xb')], { seq: 2, subOrdinal: 1 })
    );
    expect(ledgerEvents()).toContain('select:stash');
    expect(ledgerEvents()).not.toContain('sel:bootDup');
  });

  it('adopts the skipped push\'s seq: an OLDER frame drops after the ack', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const svc = makeService(makeNodes(20), provider);

    run(svc);
    provider.handlers!.onSelectAck!({ seq: 1, key: BOOT_KEY, subOrdinal: 0 });
    // A stale frame from the retired seq space must not clobber the view.
    provider.handlers!.onSelect!(
      bootEvent([active('0xz')], { seq: 0, subOrdinal: 1 })
    );
    const after = run(svc);
    expect(after.activeClusters.map((c) => c.uid)).toEqual(['0xa']);
  });

  it('a same-seq server re-select still applies after the ack', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc);
    provider.handlers!.onSelectAck!({ seq: 1, key: BOOT_KEY, subOrdinal: 0 });
    // The DoI-commit answer: re-answers the CURRENT seq with a newer
    // subOrdinal and revision (A3) — the exact liveness the registration
    // exists to keep.
    provider.handlers!.onSelect!(
      bootEvent([active('0xc')], {
        seq: 1,
        subOrdinal: 1,
        doiRevision: 3,
        reselect: 'doi',
      })
    );
    expect(onCutReady).toHaveBeenCalledTimes(1);
    const after = run(svc);
    expect(after.activeClusters.map((c) => c.uid)).toEqual(['0xc']);
  });

  it('ignores an ack that does not match the adopted boot stash', () => {
    const provider = withSubscription(makeProvider(null));
    const svc = makeService(makeNodes(20), provider);

    run(svc);
    provider.handlers!.onSelect!(bootEvent([active('0xe')]));
    // A stray ack after a REAL frame: bookkeeping must stay untouched.
    provider.handlers!.onSelectAck!({ seq: 5, key: BOOT_KEY, subOrdinal: 0 });
    expect(ledgerEvents()).toContain('sel:ackIgnored');
    provider.handlers!.onSelect!(
      bootEvent([active('0xf')], { seq: 2, subOrdinal: 2 })
    );
    const after = run(svc);
    expect(after.activeClusters.map((c) => c.uid)).toEqual(['0xf']);
  });

  it('rejects a fit-tagged ack (vocabulary mismatch)', () => {
    const provider = withSubscription(makeProvider(bootEvent([active('0xa')])));
    const svc = makeService(makeNodes(20), provider);
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    run(svc);
    provider.handlers!.onSelectAck!({
      seq: 1,
      key: `cut:x:fit=abc:${BOOT_KEY}`,
      subOrdinal: 0,
    });
    expect(ledgerEvents()).toContain('sel:ackDropFitScope');
    // The one-shot was NOT consumed: the identical registration answer is
    // still suppressed as sel:bootDup (older-server fallback intact).
    provider.handlers!.onSelect!(bootEvent([active('0xa')]));
    expect(onCutReady).toHaveBeenCalledTimes(0);
    expect(ledgerEvents()).toContain('sel:bootDup');
  });
});
