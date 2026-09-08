/**
 * Server-baked DoI (issue #315 P7 S5). The provider path must stop
 * materializing per-point DoI state: no `node.DoI =`, no `cols.doi[i] =`, no
 * per-node `doiGroup` STRING. This suite pins
 *   1. ZERO per-point writes on a propagate apply (spied at the two write
 *      surfaces: the DoI accessor setter and the doiGroup field),
 *   2. buffer-direct opacity on BOTH server paths (field + graph overlay),
 *   3. the `doiOf` / `doiGroupOfPoint` accessors against a fixture field,
 *   4. the client-complete / non-columnar fallback staying byte-identical.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import {
  attachPointColumns,
  canonicalIndexOf,
  columnsOf,
} from "../dataPreprocessing/pointColumns";
import type { DoiOverlay } from "../scaling.types";
import {
  bakedDoiRevision,
  clearBakedDoi,
  doiGroupOf,
  doiGroupOfPoint,
  doiOf,
  getBakedDoi,
  isDoiBaked,
  setBakedDoi,
} from "./bakedDoi";
import {
  applyOverlay,
  applyResidentFieldLocally,
  getAppliedFieldOpacity,
  propagateSelectionOnServer,
  resetServerDoiState,
  setFalloffShape,
} from "./serverPropagation";
import { buildDst1Buffer } from "./dst1.test";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

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

/** Canonical, column-backed points — the shape every real dataset has. */
function makeColumnarNodes(n: number, selected: number[] = []): DataPoint[] {
  const sel = new Set(selected);
  const nodes = Array.from(
    { length: n },
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

/**
 * Instrument the two per-point DoI write surfaces on a columnar dataset:
 *  - `node.DoI = v` (the accessor setter installed by attachPointColumns),
 *  - `node.doiGroup = "…"` (a plain field, so it needs its own trap).
 * Direct `cols.doi[i] = v` writes are covered by the accessor count: both
 * land in the same buffer, and the apply loop wrote BOTH per point.
 */
function spyPerPointWrites(nodes: DataPoint[]) {
  const counts = { doi: 0, group: 0 };
  for (const node of nodes) {
    const own = Object.getOwnPropertyDescriptor(node, "DoI")!;
    Object.defineProperty(node, "DoI", {
      enumerable: true,
      configurable: true,
      get: own.get,
      set(v: number) {
        counts.doi += 1;
        own.set!.call(this, v);
      },
    });
    let group: string | undefined = node.doiGroup;
    Object.defineProperty(node, "doiGroup", {
      enumerable: true,
      configurable: true,
      get: () => group,
      set: (v: string | undefined) => {
        counts.group += 1;
        group = v;
      },
    });
  }
  return counts;
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

beforeEach(() => {
  resetServerDoiState();
  // Overlay-flow routing is by provider capability since #337 (the mock
  // providers here lack selectPropagateField).
  setFalloffShape("log");
  scaling.resolveCutProvider.mockReset().mockReturnValue(null);
});

describe("baked-DoI store", () => {
  it("answers doiOf / doiGroupOf against a fixture field, and clears", () => {
    setBakedDoi(Float32Array.from([0.0, 0.3, 0.8, 0.95]), THRESHOLDS);
    expect(isDoiBaked()).toBe(true);
    expect(doiOf(0)).toBe(0);
    expect(doiOf(2)).toBeCloseTo(0.8, 6);
    expect(doiOf(9)).toBeNull(); // out of range
    expect([0, 1, 2, 3].map((i) => doiGroupOf(i))).toEqual([
      "gray",
      "transparent",
      "annotation",
      "inset",
    ]);
    clearBakedDoi();
    expect(isDoiBaked()).toBe(false);
    expect(doiOf(0)).toBeNull();
    expect(doiGroupOf(0)).toBeNull();
  });

  it("bumps a content revision on every bake and clear", () => {
    const before = bakedDoiRevision();
    setBakedDoi(Float32Array.from([1]), THRESHOLDS);
    expect(bakedDoiRevision()).toBe(before + 1);
    clearBakedDoi();
    expect(bakedDoiRevision()).toBe(before + 2);
    clearBakedDoi(); // already clear — no churn
    expect(bakedDoiRevision()).toBe(before + 2);
  });
});

describe("applyOverlay (graph path)", () => {
  it("writes NOTHING per point and hands the buffer straight to the opacity lane", () => {
    const nodes = makeColumnarNodes(4);
    const counts = spyPerPointWrites(nodes);
    applyOverlay(nodes, [0, 1, 2, 3], overlayOf([[1, 2]], [0.75, 0.95]), THRESHOLDS);

    expect(counts).toEqual({ doi: 0, group: 0 });
    // Buffer-direct: App uploads exactly this, no cols.doi re-copy.
    const applied = getAppliedFieldOpacity();
    expect(applied).not.toBeNull();
    expect(Array.from(applied!)).toEqual([0, 0.75, expect.closeTo(0.95, 5), 0]);
    // The buffer IS the DoI column, so every p.DoI reader stays correct.
    expect(nodes.map((n) => n.DoI)).toEqual([0, 0.75, expect.closeTo(0.95, 5), 0]);
    expect(columnsOf(nodes)!.doi).toBe(applied);
    // …and the ladder is evaluated, not stored.
    expect(nodes.map((n) => doiGroupOfPoint(n))).toEqual([
      "gray",
      "annotation",
      "inset",
      "gray",
    ]);
    expect(nodes.map((n) => n.doiGroup)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("non-columnar arrays keep the legacy per-point apply (byte-identical)", () => {
    // Plain object points — the client-complete/synthetic shape.
    const nodes = Array.from(
      { length: 3 },
      (_, i) => ({ id: i, x: i, y: 0, line: 0, DoI: 1 }) as unknown as DataPoint
    );
    applyOverlay(nodes, [0, 1, 2], overlayOf([[0, 2]], [1.0, 0.8]), THRESHOLDS);
    expect(nodes.map((n) => n.DoI)).toEqual([1, expect.closeTo(0.8, 5), 0]);
    expect(nodes.map((n) => n.doiGroup)).toEqual(["inset", "annotation", "gray"]);
    expect(isDoiBaked()).toBe(false);
    expect(getAppliedFieldOpacity()).toBeNull();
  });
});

describe("field path", () => {
  function makeFieldProvider(dGeo: number[], revision = 5) {
    return {
      selectPropagate: jest.fn(),
      selectPropagateField: jest.fn(async () =>
        buildDst1Buffer(revision, true, dGeo, [[0, 2]])
      ),
      getLeafOrder: jest.fn(async () => Uint32Array.from(dGeo.map((_v, pos) => pos))),
    };
  }

  it("a propagate apply performs ZERO per-point DoI/doiGroup writes at commit", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeColumnarNodes(4, [0]);
    const counts = spyPerPointWrites(nodes);

    expect(await propagateSelectionOnServer(nodes, SETTINGS)).toBe(true);
    expect(counts).toEqual({ doi: 0, group: 0 });
    expect(isDoiBaked()).toBe(true);
    // The applied buffer is the column AND the opacity upload.
    const applied = getAppliedFieldOpacity()!;
    expect(columnsOf(nodes)!.doi).toBe(applied);
    expect(getBakedDoi()).toBe(applied);
    expect(nodes[0].DoI).toBe(1); // seed clamp still exact
  });

  it("a local falloff remap also bakes — the radio/slider stays write-free", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeColumnarNodes(4, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);

    const counts = spyPerPointWrites(nodes);
    setFalloffShape("linear");
    expect(applyResidentFieldLocally(nodes, SETTINGS)).toBe(true);
    expect(counts).toEqual({ doi: 0, group: 0 });
    expect(getAppliedFieldOpacity()).toBe(columnsOf(nodes)!.doi);
  });

  it("the seed-index hint replaces the O(n) selected scan without changing seeds", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 5, 5, 5]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    // Record 2 is selected; the DST1 distance at its position is NOT zero, so
    // only the seed clamp can produce a 1 there.
    const nodes = makeColumnarNodes(4, [2]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    expect(nodes[2].DoI).toBe(1);
  });

  it("hover accessor: doiOf(canonicalIndexOf(p)) matches p.DoI for every point", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeColumnarNodes(4, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    for (const node of nodes) {
      const i = canonicalIndexOf(node)!;
      expect(doiOf(i)).toBe(node.DoI);
      expect(doiGroupOf(i)).toBe(doiGroupOfPoint(node));
    }
  });

  it("a dataset/deselect reset drops the baked state", async () => {
    setFalloffShape("exp");
    const provider = makeFieldProvider([0, 1, 2, 3]);
    scaling.resolveCutProvider.mockReturnValue(provider);
    const nodes = makeColumnarNodes(4, [0]);
    await propagateSelectionOnServer(nodes, SETTINGS);
    expect(isDoiBaked()).toBe(true);
    resetServerDoiState();
    expect(isDoiBaked()).toBe(false);
    expect(doiGroupOfPoint(nodes[0])).toBeNull(); // caller falls back to p.doiGroup
  });
});
