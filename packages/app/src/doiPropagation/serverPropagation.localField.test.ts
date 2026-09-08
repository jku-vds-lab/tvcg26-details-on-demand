/**
 * Client field lane (issue #315 field parity / #337): THE local propagation
 * lane — the hop oracle is gone, and the field lane runs whenever the
 * server did not apply. Covers: the commit populating residentField +
 * applying decay + clamp + chain, the seed clamp coming from selection
 * flags (never D=0 grid coincidence), the labeled/pinned semantics (labeled
 * never seed + group cap without a bake; the all-labeled full-space branch;
 * pins clamp post-chain, never chain sources; preview replay), deselect
 * clearing the resident state, abort supersession, the worker→inline
 * fallback, and the per-dataset-epoch revision reset.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { isDoiBaked } from "./bakedDoi";
import { computeRecordDistances } from "./fieldDistanceCore";
import type { computeRecordDistancesInWorker } from "./fieldDistanceWorker";
import {
  applyResidentFieldLocally,
  canReuseResidentField,
  fieldPreviewRequiresSync,
  getAppliedFieldOpacity,
  getResidentField,
  hasResidentFieldPreview,
  previewFalloffOpacity,
  resetServerDoiState,
  runLocalFieldPropagation,
  setFalloffShape,
} from "./serverPropagation";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

const SETTINGS = {
  proximitySlider: 0.5,
  pastSlider: 0,
  futureSlider: 0,
  maxEmbeddingDistance: 11,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

/** A line of points along x (record order = trajectory order, line 0). */
function makeNodes(n: number, selected: number[] = []): DataPoint[] {
  const sel = new Set(selected);
  return Array.from({ length: n }, (_, i) =>
    ({
      id: i + 100,
      x: i,
      y: 0,
      line: 0,
      DoI: 1,
      selected: sel.has(i),
    }) as unknown as DataPoint
  );
}

/** Inline runner: the pure core, no worker (jsdom). */
const inlineRunner: typeof computeRecordDistancesInWorker = async (input) =>
  computeRecordDistances(input).recordDist;

beforeEach(() => {
  resetServerDoiState();
  setFalloffShape("log");
  scaling.resolveCutProvider.mockReturnValue(null);
});

describe("runLocalFieldPropagation (issue #315 field parity)", () => {
  it("populates residentField and applies decay + clamp to DoI", async () => {
    // exp: infinite tail, so the decay is STRICTLY decreasing over the whole
    // line (log's compact support would zero the far half).
    setFalloffShape("exp");
    const nodes = makeNodes(12, [0]);
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(applied).toBe(true);

    const field = getResidentField();
    expect(field).not.toBeNull();
    expect(field!.revision).toBe(1);
    expect(field!.recordDist).toBeInstanceOf(Float32Array);
    expect(field!.recordDist.length).toBe(12);
    expect(field!.visibleRanges).toEqual([]);
    expect(hasResidentFieldPreview(12)).toBe(true);

    // Seed exactly 1; falloff decays with distance from the seed.
    expect(nodes[0].DoI).toBe(1);
    for (let i = 2; i < 12; i++) {
      expect(nodes[i].DoI!).toBeLessThan(nodes[i - 1].DoI!);
    }
    // The applied buffer is retained for the renderer fast lane.
    expect(getAppliedFieldOpacity()).not.toBeNull();
    expect(getAppliedFieldOpacity()!.length).toBe(12);
  });

  it("clamps seeds from selection flags, never from D=0 coincidence", async () => {
    // Two coincident points; only one is selected. At prox 0 the falloff is
    // 0 EVERYWHERE (including D=0) — only the selection clamp may yield 1.
    const nodes = makeNodes(4, [1]);
    (nodes[2] as { x: number }).x = 1; // coincident with the seed
    const applied = await runLocalFieldPropagation(
      nodes,
      { ...SETTINGS, proximitySlider: 0 },
      undefined,
      { runner: inlineRunner }
    );
    expect(applied).toBe(true);
    expect(nodes[1].DoI).toBe(1);
    expect(nodes[2].DoI).toBe(0);
  });

  it("runs the trajectory chain over the field", async () => {
    // Seed at one end, prox 0 (no spatial term): only the chain can spread.
    const nodes = makeNodes(4, [0]);
    await runLocalFieldPropagation(
      nodes,
      { ...SETTINGS, proximitySlider: 0, futureSlider: 0.5 },
      undefined,
      { runner: inlineRunner }
    );
    expect(nodes[0].DoI).toBe(1);
    expect(nodes[1].DoI).toBeCloseTo(0.5, 6);
    expect(nodes[2].DoI).toBeCloseTo(0.25, 6);
  });

  it("deselect clears the resident field and returns false", async () => {
    const nodes = makeNodes(6, [2]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, { runner: inlineRunner });
    expect(getResidentField()).not.toBeNull();

    for (const nd of nodes) (nd as { selected: boolean }).selected = false;
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(applied).toBe(false);
    expect(getResidentField()).toBeNull();
    expect(hasResidentFieldPreview(6)).toBe(false);
  });

  it("rejects with AbortError when superseded and leaves no resident field", async () => {
    const nodes = makeNodes(6, [0]);
    const controller = new AbortController();
    const hangingRunner: typeof computeRecordDistancesInWorker = (_input, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Field distance aborted", "AbortError"))
        );
      });
    const pending = runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      signal: controller.signal,
      runner: hangingRunner,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(getResidentField()).toBeNull();
  });

  it("falls back to the inline core when the worker path fails", async () => {
    // No runner: the lazy import resolves the jest workerFactories mock,
    // whose factory throws — the catch must land on the pure core.
    const nodes = makeNodes(8, [0]);
    const applied = await runLocalFieldPropagation(nodes, SETTINGS);
    expect(applied).toBe(true);
    expect(getResidentField()).not.toBeNull();
    expect(nodes[0].DoI).toBe(1);
    expect(nodes[7].DoI!).toBeLessThan(nodes[1].DoI!);
  });

  it("resets the revision counter with the dataset epoch", async () => {
    const nodes = makeNodes(6, [0]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, { runner: inlineRunner });
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, { runner: inlineRunner });
    expect(getResidentField()!.revision).toBe(2);

    resetServerDoiState(); // dataset switch
    expect(getResidentField()).toBeNull();
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, { runner: inlineRunner });
    expect(getResidentField()!.revision).toBe(1);
  });

  it("accepts a seed-index hint without scanning the rows", async () => {
    const nodes = makeNodes(6); // nothing flagged selected
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, [3], {
      runner: inlineRunner,
    });
    expect(applied).toBe(true);
    expect(nodes[3].DoI).toBe(1);
    expect(nodes[0].DoI!).toBeLessThan(1);
  });
});

describe("labeled-exclusion + pins on the field lane (#337)", () => {
  it("labeled selected points never seed and their group caps at transparent", async () => {
    // exp: strictly decreasing decay. Nodes 0 and 6 selected; node 6 is
    // labeled (id 106) — the distance field must be seeded at node 0 ONLY,
    // so node 6 receives a decayed value < 1, and although that value sits
    // above the annotation threshold, the labeled cap holds it at
    // "transparent" (the _group_codes_vec excluded rule).
    setFalloffShape("exp");
    const nodes = makeNodes(12, [0, 6]);
    const applied = await runLocalFieldPropagation(nodes, {
      ...SETTINGS,
      proximitySlider: 0.9,
    }, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["106"]),
    });
    expect(applied).toBe(true);
    expect(nodes[0].DoI).toBe(1);
    expect(nodes[6].DoI!).toBeLessThan(1); // received, not seeded
    expect(nodes[6].DoI!).toBeGreaterThan(SETTINGS.annotationDoiThreshold);
    expect(nodes[6].doiGroup).toBe("transparent"); // the cap
    expect(nodes[0].doiGroup).toBe("inset");
    // Labeled mode takes the legacy per-point loop: no bake, no applied
    // opacity buffer — the dispatch sites rebuild with the zeroing branch.
    expect(isDoiBaked()).toBe(false);
    expect(getAppliedFieldOpacity()).toBeNull();
  });

  it("an all-labeled selection takes the full-space branch (#337 PR B)", async () => {
    // The python no-seed twin, formerly the graph oracle's fallback: DoI 1
    // everywhere, ladder + excluded cap — the labeled selected point stays
    // capped at transparent, everyone else classifies inset.
    const nodes = makeNodes(6, [2]);
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["102"]),
    });
    expect(applied).toBe(true);
    expect(getResidentField()).toBeNull(); // no seeds ⇒ no distances
    for (const node of nodes) expect(node.DoI).toBe(1);
    expect(nodes[2].doiGroup).toBe("transparent");
    expect(nodes[0].doiGroup).toBe("inset");
    expect(getAppliedFieldOpacity()).toBeNull();
  });

  it("a genuine deselect still returns false", async () => {
    const nodes = makeNodes(6); // nothing selected
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["102"]),
    });
    expect(applied).toBe(false);
    expect(getResidentField()).toBeNull();
  });

  it("pins clamp to DoI 1 post-chain and classify as inset", async () => {
    // log at prox 0.5 has compact support — node 11 is beyond it (DoI 0
    // without the pin). Unlike labeled mode, pins keep the normal apply
    // (bake on columnar arrays; here the non-columnar legacy loop) and the
    // applied opacity buffer carries the clamp.
    const nodes = makeNodes(12, [0]);
    const applied = await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      pinnedNodeIds: new Set([111]),
    });
    expect(applied).toBe(true);
    expect(nodes[11].DoI).toBe(1);
    expect(nodes[11].doiGroup).toBe("inset");
    const opacity = getAppliedFieldOpacity();
    expect(opacity).not.toBeNull();
    expect(opacity![11]).toBe(1);
  });

  it("pins are never chain sources", async () => {
    // prox 0 (no spatial term), future 0.5, seed at 0, pin at 6: node 7's
    // chain value must come from the seed cascade (0.5^7), NOT from the
    // pinned 1 · 0.5 — the clamp lands AFTER the chain.
    const nodes = makeNodes(12, [0]);
    await runLocalFieldPropagation(nodes, {
      ...SETTINGS,
      proximitySlider: 0,
      futureSlider: 0.5,
    }, undefined, {
      runner: inlineRunner,
      pinnedNodeIds: new Set([106]),
    });
    expect(nodes[6].DoI).toBe(1);
    expect(nodes[7].DoI!).toBeCloseTo(0.5 ** 7, 6);
  });

  it("the drag preview replays the pin clamp and the labeled zeroing", async () => {
    setFalloffShape("exp");
    const nodes = makeNodes(12, [0, 4]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["104"]),
      pinnedNodeIds: new Set([111]),
    });
    expect(fieldPreviewRequiresSync()).toBe(true);
    const opacity = previewFalloffOpacity(nodes, SETTINGS);
    expect(opacity).not.toBeNull();
    expect(opacity![11]).toBe(1); // pin clamp replayed
    expect(opacity![4]).toBe(0); // labeled zeroing replayed
    expect(opacity![0]).toBe(1); // seed untouched
  });

  it("fieldPreviewRequiresSync stays true in every state (converged previews)", async () => {
    // Since converged previews (CS 14.08) EVERY field drag takes the
    // synchronous lane — the alternation runs neither in the shader nor in
    // the preview worker. The pins/labeled routing this used to guard is
    // subsumed; the invariant now is that no state ever re-opens the
    // round-0 shader/worker preview paths.
    const nodes = makeNodes(6, [0]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      pinnedNodeIds: new Set([103]),
    });
    expect(fieldPreviewRequiresSync()).toBe(true);
    // A follow-up commit without exclusions (pin removed) — still sync.
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(fieldPreviewRequiresSync()).toBe(true);
    resetServerDoiState();
    expect(fieldPreviewRequiresSync()).toBe(true);
  });

  it("refuses resident-field reuse across the unlabeled-only toggle", async () => {
    // The distances are seed-dependent and a labeled commit seeds them from
    // selected & ~labeled — the toggle-OFF restoration bug (CS 2026-08-08):
    // reusing that field spread from the wrong seed set.
    setFalloffShape("exp");
    const nodes = makeNodes(12, [0, 6]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(canReuseResidentField(12, false)).toBe(true);
    expect(canReuseResidentField(12, true)).toBe(false); // labeled: always recompute

    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["106"]),
    });
    expect(canReuseResidentField(12, false)).toBe(false); // labeled-seeded field

    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(canReuseResidentField(12, false)).toBe(true); // full-seed again
  });

  it("recomputing after the toggle restores full-seed distances", async () => {
    // Labeled commit: node 6 is excluded from the EDT seeds, so node 5 sees
    // distance 5 (from node 0). After the toggle-OFF recompute node 6 seeds
    // again and node 5 sees distance 1 — its DoI must rise.
    setFalloffShape("exp");
    const nodes = makeNodes(12, [0, 6]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
      labeledNodeIds: new Set(["106"]),
    });
    const labeledSeeded = nodes[5].DoI!;
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    expect(nodes[6].DoI).toBe(1);
    expect(nodes[5].DoI!).toBeGreaterThan(labeledSeeded);
  });

  it("applyResidentFieldLocally re-clamps the CURRENT pin set on a slider commit", async () => {
    // The resident field is reusable across pin changes (pins never affect
    // the distances) — the slider-commit path calls the apply directly with
    // the fresh set.
    const nodes = makeNodes(12, [0]);
    await runLocalFieldPropagation(nodes, SETTINGS, undefined, {
      runner: inlineRunner,
    });
    const applied = applyResidentFieldLocally(nodes, SETTINGS, undefined, {
      pinnedNodeIds: new Set([110]),
    });
    expect(applied).toBe(true);
    expect(nodes[10].DoI).toBe(1);
    expect(getAppliedFieldOpacity()![10]).toBe(1);
  });
});
