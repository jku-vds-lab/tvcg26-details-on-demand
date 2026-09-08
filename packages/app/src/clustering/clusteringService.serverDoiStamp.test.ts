/**
 * Server-stamped DoI in cut frames (issue #315 A3 / P-d, plan §6e):
 * - a candidate's `doiMass` rides onto its synthetic node and SURVIVES a
 *   move-only delta frame (adoptPushedCut spreads the existing candidate);
 * - a frame's `focus_active` bit is preferred over the client's O(n)
 *   `computeDoiNonUniform` scan when building the NEXT cut request, and the
 *   scan stays the (correct) fallback when no frame stamps it.
 *
 * Mirrors clusteringService.serverCutStash.test.ts (rbush mock, fake provider).
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

function makeNodes(n: number): DataPoint[] {
  const nodes: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      ...createEmptyDataPoint(),
      x: (i + 0.5) / n,
      y: (i + 0.5) / n,
      id: i + 1,
      line: 0,
      DoI: 1, // uniform ⇒ computeDoiNonUniform is false
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

function run(svc: ClusteringService, viewbox: typeof VIEW_A) {
  return svc.updateClusteringSemanticZoom(viewbox, xScale, yScale, W, H);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});
afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
});

describe('server-stamped candidate doiMass (§6e)', () => {
  it('carries doiMass onto the active node and keeps it through a move-only delta', () => {
    const nodes = makeNodes(20);
    const provider = makeSubProvider();
    const svc = makeService(nodes, provider);

    // Reset frame: one candidate stamped with a server doiMass.
    run(svc, VIEW_A);
    const first = provider.pushed[0];
    provider.handlers!.onCut({
      seq: first.seq, tree: 'points', key: first.key, reset: true, leave: [], move: [],
      enter: [candidate('0xM', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10], 42.5)],
      doiRevision: 3, focus_active: true,
    });
    const before = run(svc, VIEW_A).activeClusters.find((c) => c.uid === '0xM');
    expect(before?.doiMass).toBe(42.5);

    // A later delta only MOVES the candidate — doiMass must survive the
    // mirror rebuild (adoptPushedCut spreads the existing candidate).
    run(svc, VIEW_B);
    const second = provider.pushed[1];
    provider.handlers!.onCut({
      seq: second.seq, tree: 'points', key: second.key,
      enter: [], leave: [], move: [['0xM', 0.42, 0.42]],
      doiRevision: 3, focus_active: true,
    });
    const after = run(svc, VIEW_B).activeClusters.find((c) => c.uid === '0xM');
    expect(after?.insetPos).toEqual([0.42, 0.42]);
    expect(after?.doiMass).toBe(42.5); // preserved through the move
  });
});

describe('server-stamped frame focus_active (§6e)', () => {
  it('prefers the frame focus_active over the client uniformity scan', async () => {
    const nodes = makeNodes(20); // uniform DoI ⇒ scan would say focusActive=false
    const provider = makeProvider();
    const svc = makeService(nodes, provider);

    // First request predates any frame: focusActive comes from the scan (false).
    run(svc, VIEW_A);
    expect(provider.requests[0].focusActive).toBe(false);

    // A frame stamps focus_active=true.
    provider.pending[0].resolve({
      tree: 'points',
      candidates: [candidate('0x1', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10])],
      focus_active: true,
    });
    await flushMicrotasks();

    // Next request prefers the stamped bit even though DoI is still uniform.
    run(svc, VIEW_B);
    expect(provider.requests[1].focusActive).toBe(true);
  });

  it('falls back to the scan when the frame does not stamp focus_active', async () => {
    const nodes = makeNodes(20);
    const provider = makeProvider();
    const svc = makeService(nodes, provider);

    run(svc, VIEW_A);
    expect(provider.requests[0].focusActive).toBe(false);

    // Unstamped frame (older server / no DoI state): nothing captured.
    provider.pending[0].resolve({
      tree: 'points',
      candidates: [candidate('0x1', { minX: 0.2, minY: 0.2, maxX: 0.6, maxY: 0.6 }, [0, 10])],
    });
    await flushMicrotasks();

    run(svc, VIEW_B);
    expect(provider.requests[1].focusActive).toBe(false); // scan, unchanged
  });
});
