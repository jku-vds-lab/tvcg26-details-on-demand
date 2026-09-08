/**
 * Server-side DoI propagation client half (issue #315 A3 / P-d): routing
 * eligibility, overlay scatter + doiGroup ladder parity, the fused-lasso
 * pending-overlay handshake, and the revision-reuse/409-re-seed slider
 * commit. The wire contract is plan-315-a3-server-doi.md §6.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { DoiOverlay } from "../scaling.types";
import {
  applyOverlay,
  applyResidentFieldLocally,
  buildPropagateParams,
  chainScanTrajectory,
  consumePendingOverlay,
  getFalloffShape,
  getResidentField,
  propagateSelectionOnServer,
  propagateSliderCommitOnServer,
  resetServerDoiState,
  serverPropagationEligible,
  setFalloffShape,
  stashPendingOverlay,
  stashPendingPolygon,
  subscribeFalloffShape,
} from "./serverPropagation";
import { buildDst1Buffer } from "./dst1.test";
import { falloffValue } from "./falloff";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

jest.mock("../utils/serverLoss", () => ({
  warnServerLoss: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const serverLoss = require("../utils/serverLoss") as { warnServerLoss: jest.Mock };

/** The loss warn rides a floating probeHealth promise — drain microtasks. */
async function flushProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const THRESHOLDS = {
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

const SETTINGS = {
  proximitySlider: 0.6,
  pastSlider: 0.5,
  futureSlider: 0.4,
  maxEmbeddingDistance: 10,
  ...THRESHOLDS,
};

function makeNodes(n: number, selected: number[] = []): DataPoint[] {
  const sel = new Set(selected);
  return Array.from({ length: n }, (_, i) =>
    ({ id: i + 100, x: i, y: 0, line: 0, DoI: 1, selected: sel.has(i) }) as unknown as DataPoint
  );
}

/** Reversed leaf order: leaf position p holds record index n-1-p. */
function reversedLeafOrder(n: number): number[] {
  return Array.from({ length: n }, (_, p) => n - 1 - p);
}

function overlayOf(
  runs: Array<[number, number]>,
  values: number[],
  revision = 1
): DoiOverlay {
  return {
    revision,
    focusActive: true,
    runs,
    values: Float32Array.from(values),
    visibleRanges: [],
  };
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    selectPropagate: jest.fn(async () => ({
      overlay: overlayOf([[0, 2]], [1.0, 0.8], 7),
      ranges: [],
      n: 2,
    })),
    getLeafOrder: jest.fn(async () => new Uint32Array([0, 1, 2, 3])),
    ...overrides,
  };
}

beforeEach(() => {
  resetServerDoiState();
  // The round-1 suites test the overlay flow — routed by provider
  // capability since #337 (makeProvider lacks selectPropagateField); the
  // field-path suite below adds the capability explicitly.
  setFalloffShape("log");
  scaling.resolveCutProvider.mockReset().mockReturnValue(null);
  serverLoss.warnServerLoss.mockClear();
});

describe("serverPropagationEligible", () => {
  const deps = {
    nodeCount: 300_000,
    labeledExclusionActive: false,
    pinnedCount: 0,
  };

  it("is false without a provider or without selectPropagate", () => {
    expect(serverPropagationEligible(deps)).toBe(false);
    scaling.resolveCutProvider.mockReturnValue({});
    expect(serverPropagationEligible(deps)).toBe(false);
  });

  it("is true with a propagate-capable provider at any size (#337: the hop size rule retired)", () => {
    scaling.resolveCutProvider.mockReturnValue(makeProvider());
    expect(serverPropagationEligible(deps)).toBe(true);
    expect(serverPropagationEligible({ ...deps, nodeCount: 100 })).toBe(true);
  });

  it("labeled-exclusion mode and freehand pins stay local", () => {
    scaling.resolveCutProvider.mockReturnValue(makeProvider());
    expect(serverPropagationEligible({ ...deps, labeledExclusionActive: true })).toBe(false);
    expect(serverPropagationEligible({ ...deps, pinnedCount: 1 })).toBe(false);
  });
});

describe("buildPropagateParams", () => {
  it("maps the client slider names onto the §6a wire names + falloff routing", () => {
    expect(buildPropagateParams(SETTINGS, 5)).toEqual({
      proximity: 0.6,
      past: 0.5,
      future: 0.4,
      maxEmbeddingDistance: 10,
      k: 5,
      thresholds: { grayOut: 0.05, annotation: 0.7, inset: 0.9 },
      falloff: { shape: "log" },
    });
    setFalloffShape("linear");
    expect(buildPropagateParams(SETTINGS).falloff).toEqual({ shape: "linear" });
  });
});

describe("applyOverlay", () => {
  it("scatters runs through the leaf order and applies the group ladder", () => {
    const nodes = makeNodes(4);
    // Leaf positions 0..3 hold record indices 3,2,1,0; run [1,2] covers
    // leaf positions 1 and 2 => record indices 2 and 1.
    applyOverlay(nodes, reversedLeafOrder(4), overlayOf([[1, 2]], [0.95, 0.75]), THRESHOLDS);
    expect(nodes.map((n) => n.DoI)).toEqual([0, 0.75, expect.closeTo(0.95, 5), 0]);
    expect(nodes.map((n) => n.doiGroup)).toEqual(["gray", "annotation", "inset", "gray"]);
  });

  it("zeroes unreached points even when they held stale DoI", () => {
    const nodes = makeNodes(3);
    nodes.forEach((n) => { n.DoI = 1; });
    applyOverlay(nodes, [0, 1, 2], overlayOf([[0, 1]], [1.0]), THRESHOLDS);
    expect(nodes.map((n) => n.DoI)).toEqual([1, 0, 0]);
  });
});

describe("pending overlay handshake", () => {
  it("is one-shot and expires", () => {
    const overlay = overlayOf([[0, 1]], [1.0], 3);
    stashPendingOverlay(overlay, [100]);
    expect(consumePendingOverlay()).toEqual({ overlay, ids: [100] });
    expect(consumePendingOverlay()).toBeNull();

    const now = Date.now();
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    stashPendingOverlay(overlay, [100]);
    spy.mockReturnValue(now + 60_000);
    expect(consumePendingOverlay()).toBeNull();
    spy.mockRestore();
  });
});

describe("propagateSelectionOnServer", () => {
  it("consumes a fused-lasso overlay without a second propagation RTT", async () => {
    const provider = makeProvider();
    scaling.resolveCutProvider.mockReturnValue(provider);
    // Stashed ids must equal the commit's selection (node id 103 = index 3).
    stashPendingOverlay(overlayOf([[0, 1]], [1.0], 9), [103]);
    const nodes = makeNodes(4, [3]);
    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagate).not.toHaveBeenCalled();
    expect(nodes[0].DoI).toBe(1); // leaf order [0,1,2,3], run at position 0
  });

  it("a CHAINED selection ignores the stashed overlay and seeds by ids (CS bug)", async () => {
    const provider = makeProvider();
    scaling.resolveCutProvider.mockReturnValue(provider);
    // The stash covers only the last lasso (id 103); the ctrl-chained
    // selection also holds id 101 — the overlay must NOT be applied.
    stashPendingOverlay(overlayOf([[0, 1]], [1.0], 9), [103]);
    const nodes = makeNodes(4, [1, 3]);
    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagate).toHaveBeenCalledWith(
      "points", { ids: [1, 3] }, buildPropagateParams(SETTINGS)
    );
  });

  it("POSTs seeds:{ids} with selected RECORD indices when nothing is stashed", async () => {
    const provider = makeProvider();
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes(4, [1, 3]);
    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagate).toHaveBeenCalledWith(
      "points",
      { ids: [1, 3] },
      buildPropagateParams(SETTINGS)
    );
    // Overlay [[0,2]] over identity leaf order reaches records 0 and 1.
    expect(nodes[1].DoI).toBeCloseTo(0.8, 5);
    expect(nodes[2].DoI).toBe(0);
  });

  it("returns false on transport failure (caller keeps the local path)", async () => {
    const provider = makeProvider({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
    });
    scaling.resolveCutProvider.mockReturnValue(provider);
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
  });

  // §8.8d server-loss surface (CS #337 row-4 verdict): the field degradation
  // is exact, but it must ANNOUNCE itself — probe-first so a transient error
  // against a live server stays silent.
  it("warns server loss on failure when the health probe fails", async () => {
    const provider = makeProvider({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
      probeHealth: jest.fn(async () => false),
    });
    scaling.resolveCutProvider.mockReturnValue(provider);
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
    await flushProbe();
    expect(serverLoss.warnServerLoss).toHaveBeenCalled();
  });

  it("stays silent on failure when the probe says the server is alive", async () => {
    const provider = makeProvider({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
      probeHealth: jest.fn(async () => true),
    });
    scaling.resolveCutProvider.mockReturnValue(provider);
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
    await flushProbe();
    expect(serverLoss.warnServerLoss).not.toHaveBeenCalled();
  });

  it("warns without a probe capability (the thrown propagate is the evidence)", async () => {
    const provider = makeProvider({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
    });
    scaling.resolveCutProvider.mockReturnValue(provider);
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
    expect(serverLoss.warnServerLoss).toHaveBeenCalled();
  });

  it("does not warn on a clean success", async () => {
    scaling.resolveCutProvider.mockReturnValue(makeProvider());
    expect(await propagateSelectionOnServer(makeNodes(4, [1]), SETTINGS)).toBe(true);
    await flushProbe();
    expect(serverLoss.warnServerLoss).not.toHaveBeenCalled();
  });
});

describe("field path (field-first v2)", () => {
  /** Nodes on one trajectory line so the chain term is exercised. */
  function makeChainNodes(n: number, selected: number[] = []): DataPoint[] {
    const nodes = makeNodes(n, selected);
    nodes.forEach((node) => { (node as { line?: number }).line = 0; });
    return nodes;
  }

  function makeFieldProvider(dGeo: number[], revision = 5) {
    return {
      selectPropagate: jest.fn(),
      selectPropagateField: jest.fn(async () =>
        buildDst1Buffer(revision, true, dGeo, [[0, 1]])
      ),
      getLeafOrder: jest.fn(async () => Uint32Array.from(dGeo.map((_v, pos) => pos))),
    };
  }

  it("falloff store: default exp after reset-to-exp, subscribers notified once per change", () => {
    setFalloffShape("exp");
    expect(getFalloffShape()).toBe("exp");
    const seen: string[] = [];
    const unsubscribe = subscribeFalloffShape(() => seen.push(getFalloffShape()));
    setFalloffShape("linear");
    setFalloffShape("linear"); // no-op, no second notification
    unsubscribe();
    setFalloffShape("gauss");
    expect(seen).toEqual(["linear"]);
  });

  it("chainScanTrajectory: successors take future^h, predecessors past^h", () => {
    const nodes = makeChainNodes(5);
    const v = Float32Array.from([0, 0, 1, 0, 0]); // seed mid-line
    chainScanTrajectory(nodes, v, 0.5, 0.4);
    expect(v[3]).toBeCloseTo(0.4, 6);       // future * seed
    expect(v[4]).toBeCloseTo(0.16, 6);      // future^2 (cascades in one pass)
    expect(v[1]).toBeCloseTo(0.5, 6);       // past * seed
    expect(v[0]).toBeCloseTo(0.25, 6);      // past^2
  });

  it("commits by ids, scatters DST1 through the leaf order, applies f(D)+chain", async () => {
    setFalloffShape("exp");
    // Leaf pos p -> record n-1-p; distances rise along leaf order.
    const dGeo = [0, 2, 4, Infinity];
    const provider = {
      ...makeFieldProvider(dGeo),
      getLeafOrder: jest.fn(async () => new Uint32Array([3, 2, 1, 0])),
    };
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeChainNodes(4, [3]);
    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagateField).toHaveBeenCalledWith(
      "points", { ids: [3] }, buildPropagateParams(SETTINGS)
    );
    expect(provider.selectPropagate).not.toHaveBeenCalled();
    // Record 3 holds D=0 (seed), record 2 D=2, record 1 D=4, record 0 D=inf.
    const f = (d: number) => falloffValue(d, "exp", SETTINGS.proximitySlider, SETTINGS.maxEmbeddingDistance);
    expect(nodes[3].DoI).toBe(1);
    // The chain cascades over the spatially-raised values (alternation
    // round 1): each predecessor takes past * max(spatial, chained).
    const past = SETTINGS.pastSlider;
    const v2 = Math.max(f(2), past * 1);
    const v1 = Math.max(f(4), past * v2);
    expect(nodes[2].DoI).toBeCloseTo(v2, 5);
    expect(nodes[1].DoI).toBeCloseTo(v1, 5);
    // Unreachable record 0 (D=inf, spatial 0) still gets the chain term.
    expect(nodes[0].DoI).toBeCloseTo(past * v1, 5);
    expect(getResidentField()?.revision).toBe(5);
    expect(getResidentField()?.visibleRanges).toEqual([[0, 1]]);
  });

  it("radio/slider remap is purely local once a field is resident", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 3, 6, 9]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeChainNodes(4, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    const callsAfterCommit = provider.selectPropagateField.mock.calls.length;

    setFalloffShape("linear");
    expect(applyResidentFieldLocally(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagateField.mock.calls.length).toBe(callsAfterCommit);
    const linear = (d: number) =>
      falloffValue(d, "linear", SETTINGS.proximitySlider, SETTINGS.maxEmbeddingDistance);
    // Record 3: D=9 beyond the linear reach 6 -> spatial 0; the chain
    // cascades over the raised values: future*(future*max(linear(3), future)).
    const future = SETTINGS.futureSlider;
    const v1 = Math.max(linear(3), future * 1);
    const v2 = Math.max(linear(6), future * v1);
    expect(nodes[3].DoI).toBeCloseTo(Math.max(linear(9), future * v2), 5);
  });

  it("prefers the stashed lasso polygon over ids on the field path", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    stashPendingPolygon([[0, 0], [1, 0], [1, 1]], [101]); // id 101 = index 1
    await propagateSelectionOnServer(makeChainNodes(4, [1]), SETTINGS);
    expect(provider.selectPropagateField).toHaveBeenCalledWith(
      "points", { polygon: [[0, 0], [1, 0], [1, 1]] }, buildPropagateParams(SETTINGS)
    );
    // One-shot: the next commit falls back to ids seeding.
    await propagateSelectionOnServer(makeChainNodes(4, [1]), SETTINGS);
    expect(provider.selectPropagateField).toHaveBeenLastCalledWith(
      "points", { ids: [1] }, buildPropagateParams(SETTINGS)
    );
  });

  it("slider commit on the field path reuses the retained revision", async () => {
    setFalloffShape("gauss");
    const provider = makeFieldProvider([0, 1], 8);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeChainNodes(2, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    await propagateSliderCommitOnServer(nodes, SETTINGS);
    expect(provider.selectPropagateField).toHaveBeenLastCalledWith(
      "points", { revision: 8 }, buildPropagateParams(SETTINGS)
    );
  });

  it("shape-3 response without a distance array keeps the resident distances", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3], 5);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeChainNodes(4, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    const distBefore = getResidentField()!.recordDist;

    provider.selectPropagateField.mockResolvedValue(
      buildDst1Buffer(6, true, [], [[1, 2]])
    );
    await propagateSliderCommitOnServer(nodes, SETTINGS);
    const field = getResidentField()!;
    expect(field.revision).toBe(6);
    expect(field.visibleRanges).toEqual([[1, 2]]);
    expect(field.recordDist).toBe(distBefore); // distances retained
  });

  it("p=0 with a coincident non-seed: no leak, chain spreads only along the seeds' line (CS repro)", async () => {
    setFalloffShape("exp");
    // Records 0,1 on line 0 (both selected = the whole trajectory); record 2
    // grid-coincident with record 0 (D=0) but on line 1 with a successor 3.
    const provider = makeFieldProvider([0, 0, 0, 4], 5);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes(4, [0, 1]);
    (nodes[0] as { line?: number }).line = 0;
    (nodes[1] as { line?: number }).line = 0;
    (nodes[2] as { line?: number }).line = 1;
    (nodes[3] as { line?: number }).line = 1;
    const settings = { ...SETTINGS, proximitySlider: 0 };
    expect(await propagateSelectionOnServer(nodes, settings)).toBe(true);
    // Seeds stay 1 via the selection clamp; the coincident D=0 point gets
    // NOTHING at p=0, so its trajectory stays dark despite past/future > 0.
    expect(nodes[0].DoI).toBe(1);
    expect(nodes[1].DoI).toBe(1);
    expect(nodes[2].DoI).toBe(0);
    expect(nodes[3].DoI).toBe(0);
  });

  it("returns false without a resident field (caller falls back)", () => {
    setFalloffShape("exp");
    expect(applyResidentFieldLocally(makeChainNodes(2), SETTINGS)).toBe(false);
  });
});

describe("propagateSliderCommitOnServer", () => {
  it("re-propagates from the retained revision", async () => {
    const provider = makeProvider();
    scaling.resolveCutProvider.mockReturnValue(provider);
    stashPendingOverlay(overlayOf([[0, 1]], [1.0], 4), [100]);
    consumePendingOverlay(); // stash set lastRevision = 4
    expect(await propagateSliderCommitOnServer(makeNodes(4, [0]), SETTINGS)).toBe(true);
    expect(provider.selectPropagate).toHaveBeenCalledWith(
      "points",
      { revision: 4 },
      buildPropagateParams(SETTINGS)
    );
  });

  it("re-seeds from the current selection on 409", async () => {
    const rejection = Object.assign(new Error("propagate failed (409)"), { status: 409 });
    const selectPropagate = jest
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValue({ overlay: overlayOf([[0, 1]], [1.0], 11), ranges: [], n: 1 });
    const provider = makeProvider({ selectPropagate });
    scaling.resolveCutProvider.mockReturnValue(provider);
    stashPendingOverlay(overlayOf([[0, 1]], [1.0], 4), [100]);
    consumePendingOverlay();

    const nodes = makeNodes(4, [2]);
    expect(await propagateSliderCommitOnServer(nodes, SETTINGS)).toBe(true);
    expect(selectPropagate).toHaveBeenNthCalledWith(
      1, "points", { revision: 4 }, buildPropagateParams(SETTINGS)
    );
    expect(selectPropagate).toHaveBeenNthCalledWith(
      2, "points", { ids: [2] }, buildPropagateParams(SETTINGS)
    );
  });

  it("falls back to selection seeding when no revision is retained", async () => {
    const provider = makeProvider();
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes(4, [0]);
    expect(await propagateSliderCommitOnServer(nodes, SETTINGS)).toBe(true);
    expect(provider.selectPropagate).toHaveBeenCalledWith(
      "points", { ids: [0] }, buildPropagateParams(SETTINGS)
    );
  });

  it("warns server loss on a non-409 failure when the probe fails (§8.8d)", async () => {
    const provider = makeProvider({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
      probeHealth: jest.fn(async () => false),
    });
    scaling.resolveCutProvider.mockReturnValue(provider);
    stashPendingOverlay(overlayOf([[0, 1]], [1.0], 4), [100]);
    consumePendingOverlay(); // stash set lastRevision = 4
    expect(await propagateSliderCommitOnServer(makeNodes(4, [0]), SETTINGS)).toBe(false);
    await flushProbe();
    expect(serverLoss.warnServerLoss).toHaveBeenCalled();
  });
});
