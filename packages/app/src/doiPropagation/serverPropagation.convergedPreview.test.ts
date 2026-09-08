/**
 * Converged drag-preview contract (CS 14.08): what the held thumb shows IS
 * what the release commit paints. `previewFalloffOpacity` and the commit
 * apply run the same converged executor on the same inputs, so their value
 * buffers must be IDENTICAL — on a fixture whose chain actually raises
 * states and whose re-spread actually recruits off-trajectory points (a
 * fixture where the alternation is inert would pass vacuously under the old
 * round-0 preview too).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { computeConvergedPreview } from "./convergedField";
import {
  computeRecordDistances,
  FIELD_GRID_RESOLUTION,
  rasterize,
  type FieldRaster,
} from "./fieldDistanceCore";
import type { computeRecordDistancesInWorker } from "./fieldDistanceWorker";
import { getPropagationPrecomputation } from "./propagateDoi";
import {
  applyResidentFieldLocally,
  getResidentField,
  getSeedClampIndices,
  previewFalloffOpacity,
  resetServerDoiState,
  runLocalFieldPropagation,
  setFalloffShape,
  snapshotCoords,
} from "./serverPropagation";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

const SETTINGS = {
  // prox 0.5 ⇒ log support R = 2.2 in this fixture's units: the chain-raised
  // trajectory end (v ≈ 0.35, offset ≈ 1.6) keeps ~0.6 units of continued
  // reach — enough to recruit the 0.15-lateral off-trajectory points, while
  // the seed itself (9+ units away) never touches them in round 0.
  proximitySlider: 0.5,
  pastSlider: 0.9,
  futureSlider: 0.9,
  maxEmbeddingDistance: 11,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

/** Bridge fixture: an 11-point trajectory (line 0) along x with the seed at
 * its head, plus three OFF-trajectory singleton points parked near the far
 * end — reachable only via the converged re-spread (round 0 leaves them at
 * ~0: far from the seed, off every line). */
function makeBridgeNodes(): DataPoint[] {
  const nodes: DataPoint[] = [];
  for (let i = 0; i <= 10; i++) {
    nodes.push({
      id: 100 + i,
      x: i,
      y: 0,
      line: 0,
      DoI: 1,
      selected: i === 0,
    } as unknown as DataPoint);
  }
  for (let j = 0; j < 3; j++) {
    nodes.push({
      id: 200 + j,
      x: 9.5 + j * 0.25,
      y: 0.15,
      line: 1 + j,
      DoI: 1,
      selected: false,
    } as unknown as DataPoint);
  }
  return nodes;
}

const inlineRunner: typeof computeRecordDistancesInWorker = async (input) =>
  computeRecordDistances(input).recordDist;

beforeEach(() => {
  resetServerDoiState();
  setFalloffShape("log");
});

describe("converged preview == commit (value identity)", () => {
  it("the preview buffer at the committed settings equals the committed DoI exactly", async () => {
    const nodes = makeBridgeNodes();
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(applied).toBe(true);
    const committed = nodes.map((n) => n.DoI!);
    // The fixture must actually exercise the alternation: the off-trajectory
    // points are colored ONLY because a chain-raised trajectory end re-spread
    // onto them.
    for (let j = 11; j < 14; j++) {
      expect(committed[j]).toBeGreaterThan(SETTINGS.grayOutDoiThreshold);
    }
    const preview = previewFalloffOpacity(nodes, SETTINGS);
    expect(preview).not.toBeNull();
    expect(Array.from(preview!)).toEqual(committed);
  });

  it("the preview at MOVED sliders equals the commit that follows at those sliders", async () => {
    const nodes = makeBridgeNodes();
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    const moved = { ...SETTINGS, proximitySlider: 0.15, pastSlider: 0.6, futureSlider: 0.7 };
    // Drag tick first (the preview must not depend on the commit having run
    // at these values), commit second — the release/settle path over the
    // resident field.
    const preview = Float32Array.from(previewFalloffOpacity(nodes, moved)!);
    expect(applyResidentFieldLocally(nodes, moved)).toBe(true);
    const committed = nodes.map((n) => n.DoI!);
    expect(Array.from(preview)).toEqual(committed);
  });

  it("the WORKER-marshaled compute (copied buffers + coords raster) equals the commit", async () => {
    // Mirror fieldPreview.worker.ts exactly: the client transfers COPIES of
    // recordDist/pred/succ/seeds plus the coords snapshot, and the worker
    // rasterizes lazily from the coords — the off-thread preview must still
    // be value-identical to the main-thread commit.
    const nodes = makeBridgeNodes();
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    const committed = nodes.map((n) => n.DoI!);
    const field = getResidentField()!;
    const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
    const { x, y } = snapshotCoords(nodes);
    let raster: FieldRaster | null = null;
    const out = computeConvergedPreview(
      {
        recordDist: new Float32Array(field.recordDist),
        predIndex: new Int32Array(predIndex),
        succIndex: new Int32Array(succIndex),
        seedIdx: Int32Array.from(getSeedClampIndices()!),
        getRaster: () => {
          if (!raster) raster = rasterize(x, y, FIELD_GRID_RESOLUTION);
          return raster;
        },
        shape: "log",
        prox: SETTINGS.proximitySlider,
        past: SETTINGS.pastSlider,
        future: SETTINGS.futureSlider,
        maxEmb: SETTINGS.maxEmbeddingDistance,
      },
      undefined,
      {}
    );
    expect(Array.from(out)).toEqual(committed);
    expect(raster).not.toBeNull(); // the bridge fixture really re-spreads
  });

  it("holds with pins and labeled exclusion replayed on the preview", async () => {
    const nodes = makeBridgeNodes();
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["104"]),
      pinnedNodeIds: new Set([201]),
    });
    const committedOpacity = nodes.map((n, i) =>
      // Labeled points paint transparent in unlabeled-only mode — the
      // dispatch sites zero them in the opacity rebuild; the preview replays
      // exactly that (labeledZeroIdx).
      nodes[i].id === 104 ? 0 : n.DoI!
    );
    const preview = previewFalloffOpacity(nodes, SETTINGS);
    expect(Array.from(preview!)).toEqual(committedOpacity);
    // Pin clamped to 1 in both lanes.
    expect(nodes[12].DoI).toBe(1);
    expect(preview![12]).toBe(1);
  });
});
