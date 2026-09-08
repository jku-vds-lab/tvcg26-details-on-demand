/**
 * The `doi` chip on the server propagation path (issue #315 P7 amendment A5):
 * set at propagate dispatch, cleared when the overlay / distance field has
 * been applied — or when the call falls back to the local pipeline. A commit
 * that never reaches the server (no provider, no selection) resolves inside
 * one tick, so React 18 batching leaves nothing to paint.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { DoiOverlay } from "../scaling.types";
import {
  propagateSelectionOnServer,
  propagateSliderCommitOnServer,
  resetServerDoiState,
  setFalloffShape,
} from "./serverPropagation";
import store from "../store";
import { progressResetAll } from "../slices/progressSlice";

const mockResolveCutProvider = jest.fn<() => unknown>(() => null);
jest.mock("@scaling", () => ({
  resolveCutProvider: (...args: unknown[]) =>
    (mockResolveCutProvider as (...a: unknown[]) => unknown)(...args),
}));

// The transport-failure case would otherwise fire the real §8.8d banner
// dispatch into the shared store this suite reads chips from.
jest.mock("../utils/serverLoss", () => ({
  warnServerLoss: jest.fn(),
}));

const SETTINGS = {
  proximitySlider: 0.6,
  pastSlider: 0.5,
  futureSlider: 0.4,
  maxEmbeddingDistance: 10,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

const chipUp = () =>
  Object.values(store.getState().progress.tasks).some(
    (t) => t.phase === "Updating interest…"
  );

function makeNodes(n: number, selected: number[] = []): DataPoint[] {
  const sel = new Set(selected);
  return Array.from({ length: n }, (_, i) =>
    ({ id: i + 100, x: i, y: 0, line: 0, DoI: 1, selected: sel.has(i) }) as unknown as DataPoint
  );
}

function overlay(revision = 1): DoiOverlay {
  return {
    revision,
    focusActive: true,
    runs: [[0, 2]],
    values: Float32Array.from([1.0, 0.8]),
    visibleRanges: [],
  };
}

/** A provider whose propagate resolves only when the test says so. */
function makeDeferredProvider() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    release: () => release(),
    provider: {
      selectPropagate: jest.fn(async () => {
        await gate;
        return { overlay: overlay(7), ranges: [], n: 2 };
      }),
      getLeafOrder: jest.fn(async () => new Uint32Array([0, 1, 2, 3])),
    },
  };
}

beforeEach(() => {
  resetServerDoiState();
  // The overlay flow routes by provider capability since #337 (the mock
  // providers here lack selectPropagateField).
  setFalloffShape("log");
  mockResolveCutProvider.mockReset().mockReturnValue(null);
  store.dispatch(progressResetAll());
});

describe("doi chip (A5)", () => {
  it("is up while the propagate is in flight and down once the overlay applies", async () => {
    const { provider, release } = makeDeferredProvider();
    mockResolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes(4, [1]);

    const inFlight = propagateSelectionOnServer(nodes, SETTINGS);
    expect(chipUp()).toBe(true);

    release();
    expect(await inFlight).toBe(true);
    expect(chipUp()).toBe(false);
    // Effect time really is the apply: the overlay is on the nodes.
    expect(nodes[0].DoI).toBe(1);
  });

  it("clears when the transport fails (the caller falls back locally)", async () => {
    mockResolveCutProvider.mockReturnValue({
      selectPropagate: jest.fn(async () => { throw new Error("boom"); }),
      getLeafOrder: jest.fn(async () => new Uint32Array([0, 1])),
    });
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
    expect(chipUp()).toBe(false);
  });

  it("never paints when the commit resolves synchronously (no flash)", async () => {
    // No provider at all: the routing returns before any dispatch.
    expect(await propagateSelectionOnServer(makeNodes(2, [0]), SETTINGS)).toBe(false);
    expect(chipUp()).toBe(false);

    // A provider but nothing selected: set and clear land in the SAME tick,
    // which React 18 batches — the store is clean by the end of the tick.
    mockResolveCutProvider.mockReturnValue({
      selectPropagate: jest.fn(),
      getLeafOrder: jest.fn(async () => new Uint32Array([0, 1])),
    });
    const settled = propagateSelectionOnServer(makeNodes(2), SETTINGS);
    expect(chipUp()).toBe(false); // already cleared, synchronously
    expect(await settled).toBe(false);
  });

  it("folds the slider commit's 409 re-seed into ONE chip", async () => {
    const err = Object.assign(new Error("stale revision"), { status: 409 });
    const provider = {
      // Every retained-revision seeding is 409'd, so the slider commit always
      // re-seeds through the selection path.
      selectPropagate: jest.fn(async (_tree: unknown, seeds: unknown) => {
        if ((seeds as { revision?: number }).revision !== undefined) throw err;
        return { overlay: overlay(11), ranges: [], n: 2 };
      }),
      getLeafOrder: jest.fn(async () => new Uint32Array([0, 1, 2, 3])),
    };
    mockResolveCutProvider.mockReturnValue(provider);
    const nodes = makeNodes(4, [1]);

    // Seed a revision so the slider commit takes the retained-revision path.
    await propagateSelectionOnServer(nodes, SETTINGS);
    expect(chipUp()).toBe(false);
    provider.selectPropagate.mockClear();

    const inFlight = propagateSliderCommitOnServer(nodes, SETTINGS);
    expect(chipUp()).toBe(true);
    expect(await inFlight).toBe(true);
    // The nested re-seed did NOT clear the chip early, and the outer commit
    // cleared it exactly once.
    expect(provider.selectPropagate).toHaveBeenCalledTimes(2);
    expect(chipUp()).toBe(false);
  });
});
