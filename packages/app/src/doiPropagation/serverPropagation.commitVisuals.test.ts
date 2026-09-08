/**
 * "Nothing visual changes between propagate dispatch and apply" (issue #315
 * P7, defect round 2026-07-25).
 *
 * DEFECT: on a lasso commit CS saw the whole cloud shift the moment the DoI
 * chip appeared — a full RTT before the new field could possibly exist.
 *
 * Since S5 the state the renderer draws is *shared by reference*: the applied
 * f32 buffer is adopted as the DoI column (`adoptDoiColumn`) AND handed to
 * `setOpacityField`, which keeps it as its opacity override. So "the rendered
 * image did not change" is testable at module level as: between
 * `beginDoiChip()` (propagate dispatch) and the apply, neither the DoI column
 * nor the last applied opacity buffer may be mutated.
 *
 * The regression this pins is the reused falloff scratch: it made the LIVE
 * uploaded buffer the array `evalFalloffField` overwrites in place at the
 * start of the next commit, so a repaint landing in that window painted a
 * half-computed field (f(D) before the seed clamp and before the chain —
 * uniformly lower than both the old field and the new one, i.e. exactly
 * "everything slightly brighter").
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { attachPointColumns, columnsOf } from "../dataPreprocessing/pointColumns";
import {
  getAppliedFieldOpacity,
  propagateSelectionOnServer,
  resetServerDoiState,
  setFalloffShape,
} from "./serverPropagation";
import { buildDst1Buffer } from "./dst1.test";

jest.mock("@scaling", () => ({ resolveCutProvider: jest.fn(() => null) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mock must be resolved after jest.mock hoisting
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

const N = 6;

const SETTINGS = {
  proximitySlider: 0.6,
  pastSlider: 0.5,
  futureSlider: 0.4,
  maxEmbeddingDistance: 10,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function makeNodes(selected: number[]): DataPoint[] {
  const sel = new Set(selected);
  const nodes = Array.from(
    { length: N },
    (_, i) =>
      ({
        id: i + 100,
        x: i,
        y: 0,
        line: 0,
        DoI: 1,
        selected: sel.has(i),
      }) as unknown as DataPoint
  );
  attachPointColumns(nodes);
  return nodes;
}

/** DST1 field response; `dGeo` is in LEAF order (identity here). */
function dst1(dGeo: number[], revision: number): ArrayBuffer {
  return buildDst1Buffer(revision, true, dGeo, []);
}

/** A provider whose field propagate resolves only when the test says so. */
function gatedProvider(dGeo: number[], revision: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const provider = {
    selectPropagate: jest.fn(async () => {
      throw new Error("graph path must not be used");
    }),
    selectPropagateField: jest.fn(async () => {
      await gate;
      return dst1(dGeo, revision);
    }),
    getLeafOrder: jest.fn(async () => Uint32Array.from({ length: N }, (_, i) => i)),
  };
  return { provider, release: () => release() };
}

beforeEach(() => {
  resetServerDoiState();
  setFalloffShape("log");
  scaling.resolveCutProvider.mockReset().mockReturnValue(null);
});

describe("the propagate RTT window is visually inert", () => {
  it("leaves the DoI column and the applied opacity buffer untouched in flight", async () => {
    const nodes = makeNodes([0]);

    // ── commit 1: establishes a resident field + the adopted column ──────────
    const first = gatedProvider([0, 1, 2, 3, 4, 5], 1);
    scaling.resolveCutProvider.mockReturnValue(first.provider);
    const p1 = propagateSelectionOnServer(nodes, SETTINGS);
    first.release();
    expect(await p1).toBe(true);

    const cols = columnsOf(nodes)!;
    const liveColumn = cols.doi;
    const liveField = getAppliedFieldOpacity()!;
    expect(liveField).toBe(liveColumn); // S5 aliasing: same buffer by design
    const onScreen = Float32Array.from(liveField);

    // ── commit 2: dispatch, then inspect BEFORE the server answers ───────────
    const second = gatedProvider([5, 4, 3, 2, 1, 0], 2);
    scaling.resolveCutProvider.mockReturnValue(second.provider);
    const p2 = propagateSelectionOnServer(nodes, SETTINGS);
    // Drain the microtask queue so every synchronous prologue has run and the
    // propagate is genuinely parked on the network.
    await Promise.resolve();
    await Promise.resolve();

    expect(second.provider.selectPropagateField).toHaveBeenCalledTimes(1);
    // The chip is up and the answer is not back: what the renderer draws must
    // be bit-identical to the pre-dispatch frame.
    expect(cols.doi).toBe(liveColumn);
    expect(getAppliedFieldOpacity()).toBe(liveField);
    expect(Array.from(liveField)).toEqual(Array.from(onScreen));

    second.release();
    expect(await p2).toBe(true);

    // ── after apply: a NEW buffer, and the old one was never scribbled on ────
    const applied = getAppliedFieldOpacity()!;
    expect(applied).not.toBe(liveField);
    expect(columnsOf(nodes)!.doi).toBe(applied);
    expect(Array.from(liveField)).toEqual(Array.from(onScreen));
  });

  it("alternates the falloff scratch so no commit overwrites the live buffer", async () => {
    const nodes = makeNodes([0]);
    const buffers: Float32Array[] = [];
    for (let commit = 1; commit <= 4; commit++) {
      const gated = gatedProvider([0, 1, 2, 3, 4, 5].map((d) => d + commit), commit);
      scaling.resolveCutProvider.mockReturnValue(gated.provider);
      const pending = propagateSelectionOnServer(nodes, SETTINGS);
      gated.release();
      expect(await pending).toBe(true);
      buffers.push(getAppliedFieldOpacity()!);
    }
    // Consecutive commits must never reuse the same array object.
    expect(buffers[1]).not.toBe(buffers[0]);
    expect(buffers[2]).not.toBe(buffers[1]);
    expect(buffers[3]).not.toBe(buffers[2]);
    // Two slots, alternating — the pool stays bounded.
    expect(buffers[2]).toBe(buffers[0]);
    expect(buffers[3]).toBe(buffers[1]);
  });
});
