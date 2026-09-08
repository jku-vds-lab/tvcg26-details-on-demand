/**
 * Field drag-preview core (issue #315): the pure compute that the preview
 * worker runs, and the latest-wins scheduling helper. The parity test proves
 * computeFieldPreview produces byte-identical values to the main-thread
 * previewFalloffOpacity it replaces, so moving the math off-thread cannot
 * change what the user sees.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { getPropagationPrecomputation } from "./propagateDoi";
import {
  chainScanTrajectoryCore,
  computeFieldPreview,
  latestWinsComplete,
  latestWinsInitial,
  latestWinsRequest,
} from "./fieldPreviewCore";
import {
  getFalloffShape,
  getResidentField,
  getSeedClampIndices,
  previewFalloffOpacity,
  propagateSelectionOnServer,
  resetServerDoiState,
  setFalloffShape,
  type PropagationSliderSettings,
} from "./serverPropagation";
import { buildDst1Buffer } from "./dst1.test";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

const SETTINGS: PropagationSliderSettings = {
  proximitySlider: 0.6,
  pastSlider: 0.5,
  futureSlider: 0.4,
  maxEmbeddingDistance: 10,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function makeChainNodes(n: number, selected: number[] = []): DataPoint[] {
  const sel = new Set(selected);
  return Array.from({ length: n }, (_, i) =>
    ({ id: i + 100, x: i, y: 0, line: 0, DoI: 1, selected: sel.has(i) }) as unknown as DataPoint
  );
}

beforeEach(() => {
  resetServerDoiState();
  setFalloffShape("exp");
  scaling.resolveCutProvider.mockReset().mockReturnValue(null);
});

describe("computeFieldPreview", () => {
  it("matches previewFalloffOpacity exactly (worker parity)", async () => {
    // Build a resident field via the real server apply path (sets recordDist +
    // the seed clamp index cache), then compare the two compute routes.
    const dGeo = [0, 2, 4, Infinity];
    const provider = {
      selectPropagate: jest.fn(),
      selectPropagateField: jest.fn(async () => buildDst1Buffer(5, true, dGeo, [[0, 1]])),
      getLeafOrder: jest.fn(async () => new Uint32Array([3, 2, 1, 0])),
    };
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeChainNodes(4, [3]);
    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);

    const reference = Array.from(previewFalloffOpacity(nodes, SETTINGS)!);

    const field = getResidentField()!;
    const seeds = getSeedClampIndices()!;
    const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
    const out = computeFieldPreview({
      recordDist: field.recordDist,
      predIndex,
      succIndex,
      seedIdx: Int32Array.from(seeds),
      shape: getFalloffShape() as "exp",
      prox: SETTINGS.proximitySlider,
      past: SETTINGS.pastSlider,
      future: SETTINGS.futureSlider,
      maxEmb: SETTINGS.maxEmbeddingDistance,
    });

    expect(Array.from(out)).toEqual(reference);
  });

  it("clamps seeds to 1 before the chain, and unreachable points still chain", () => {
    // recordDist: only index 2 reachable (D=0); a line 0..4 so pred/succ exist.
    const recordDist = Float32Array.from([Infinity, Infinity, 0, Infinity, Infinity]);
    const predIndex = Int32Array.from([-1, 0, 1, 2, 3]);
    const succIndex = Int32Array.from([1, 2, 3, 4, -1]);
    const out = computeFieldPreview({
      recordDist,
      predIndex,
      succIndex,
      seedIdx: Int32Array.from([2]),
      shape: "exp",
      prox: 0.6,
      past: 0.5,
      future: 0.4,
      maxEmb: 10,
    });
    // future·seed cascades forward; past·seed cascades backward (one pass
    // each). Float32 storage, so compare with tolerance.
    expect(out[2]).toBe(1); // seed clamp
    expect(out[1]).toBeCloseTo(0.5, 6); // past·seed
    expect(out[0]).toBeCloseTo(0.25, 6); // past²·seed
    expect(out[3]).toBeCloseTo(0.4, 6); // future·seed
    expect(out[4]).toBeCloseTo(0.16, 6); // future²·seed
  });

  it("reuses a provided out buffer (ping-pong: no allocation)", () => {
    const recordDist = Float32Array.from([0, Infinity]);
    const out = new Float32Array(2);
    const result = computeFieldPreview(
      {
        recordDist,
        predIndex: Int32Array.from([-1, -1]),
        succIndex: Int32Array.from([-1, -1]),
        seedIdx: Int32Array.from([0]),
        shape: "exp",
        prox: 0.6,
        past: 0,
        future: 0,
        maxEmb: 10,
      },
      out
    );
    expect(result).toBe(out); // same buffer, written in place
    expect(Array.from(result)).toEqual([1, 0]);
  });
});

describe("chainScanTrajectoryCore", () => {
  it("cascades successors by future and predecessors by past in one pass each", () => {
    const v = Float32Array.from([0, 0, 1, 0, 0]);
    chainScanTrajectoryCore(
      v,
      Int32Array.from([-1, 0, 1, 2, 3]),
      Int32Array.from([1, 2, 3, 4, -1]),
      0.5,
      0.4
    );
    expect(v[3]).toBeCloseTo(0.4, 6);
    expect(v[4]).toBeCloseTo(0.16, 6);
    expect(v[1]).toBeCloseTo(0.5, 6);
    expect(v[0]).toBeCloseTo(0.25, 6);
  });
});

describe("latest-wins scheduling", () => {
  it("sends immediately when idle", () => {
    const { state, send } = latestWinsRequest(latestWinsInitial<number>(), 1);
    expect(send).toBe(1);
    expect(state).toEqual({ inFlight: true, pending: null });
  });

  it("stashes only the newest params while a tick is in flight (drops older)", () => {
    let state = latestWinsRequest(latestWinsInitial<number>(), 1).state;
    let r = latestWinsRequest(state, 2);
    expect(r.send).toBeNull();
    expect(r.state).toEqual({ inFlight: true, pending: 2 });
    r = latestWinsRequest(r.state, 3); // 2 is discarded, 3 is the latest
    expect(r.send).toBeNull();
    expect(r.state).toEqual({ inFlight: true, pending: 3 });
    state = r.state;

    const done = latestWinsComplete(state); // drains 3, still in flight
    expect(done.send).toBe(3);
    expect(done.state).toEqual({ inFlight: true, pending: null });
  });

  it("goes idle on completion when nothing is pending", () => {
    const state = latestWinsRequest(latestWinsInitial<number>(), 1).state;
    const done = latestWinsComplete(state);
    expect(done.send).toBeNull();
    expect(done.state).toEqual({ inFlight: false, pending: null });
  });
});
