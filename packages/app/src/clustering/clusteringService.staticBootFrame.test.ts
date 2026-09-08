/**
 * Static boot-frame adoption, CLIENT lane (issue #315 insets-at-boot I3,
 * plan-315-insets-at-boot.md §I3).
 *
 * Client-complete datasets ship a prep-time `bootFrame.json`; the boot
 * clustering's FIRST zoom pass applies it instead of the first local scoring
 * result, and the next genuine pass supersedes it unconditionally. This
 * suite pins the gate semantics:
 *
 *  1. adopt-once: the armed first pass applies the frame (winners + server
 *     groups) and schedules the superseding pass via onCutReady;
 *  2. supersede-by-local: the second pass runs the normal local pipeline —
 *     the stash is never re-applied;
 *  3. missing-artifact fallback: an armed pass without a registered frame
 *     runs the local pipeline immediately (degrade, never block) AND
 *     tombstones the slot, so a late fetch can never apply mid-session;
 *  4. dataset-switch invalidation: the registry keys on rows identity;
 *  5. the provider lane never adopts the static artifact (I1 owns it).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

// Mock rbush (ESM) to avoid transform issues in Jest.
jest.mock("rbush", () => {
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

import * as d3 from "d3";
import { ClusteringService } from "./clusteringService";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "./ExtendedHDBSCAN";
import {
  indexLeafRanges,
  reuid,
} from "../hooks/useFullSelectionHdbscanInstance";
import type {
  ClusterCutProvider,
  CutRequest,
  SelectedActive,
} from "../scaling.types";
import {
  registerStaticBootFrame,
  STATIC_BOOT_FRAME_FORMAT,
  takeStaticBootFrame,
  type StaticBootFrameArtifact,
} from "../semanticZoom/staticBootFrame";
import store, {
  initialClusterSettings,
  initialVisualizationSettings,
  updateClusterSettings,
  updateSettings,
} from "../store";

const W = 800;
const H = 600;
const xScale = d3.scaleLinear().domain([0, 1]).range([0, W]);
const yScale = d3.scaleLinear().domain([0, 1]).range([H, 0]);
const VIEW = { minX: 0, minY: 0, maxX: 1, maxY: 1 };

/** Two tight pairs far apart — the local hybrid cut splits the root and
 * activates both pair clusters. */
const COORDS: Array<[number, number]> = [
  [0.1, 0.1], [0.15, 0.12],
  [0.8, 0.8], [0.85, 0.82],
];

function makeNodes(): DataPoint[] {
  return COORDS.map(([x, y], i) => ({
    ...createEmptyDataPoint(),
    x,
    y,
    id: i + 1,
    line: 0,
    DoI: 1,
    doiGroup: "inset" as const,
  }));
}

function leaf(leafIndex: number): ClusterTreeNode {
  const [x, y] = COORDS[leafIndex];
  return {
    id: leafIndex,
    leafIndex,
    size: 1,
    stability: 1,
    distance: 0,
    bbox: { minX: x, minY: y, maxX: x, maxY: y },
  } as unknown as ClusterTreeNode;
}

function internal(
  id: number,
  leftChild: ClusterTreeNode,
  rightChild: ClusterTreeNode,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  stability: number,
  size: number
): ClusterTreeNode {
  return {
    id, leftChild, rightChild, bbox, stability, size, distance: 1,
  } as unknown as ClusterTreeNode;
}

/** The shipped-tree twin: reuid + leaf-range index + _leafOrder, exactly the
 * shape useFullSelectionHdbscanInstance hands the fast boot path. */
function makeShippedTree(): ClusterTreeNode {
  const left = internal(10, leaf(0), leaf(1), { minX: 0.1, minY: 0.1, maxX: 0.15, maxY: 0.12 }, 5, 2);
  const right = internal(11, leaf(2), leaf(3), { minX: 0.8, minY: 0.8, maxX: 0.85, maxY: 0.82 }, 5, 2);
  const raw = internal(12, left, right, { minX: 0.1, minY: 0.1, maxX: 0.85, maxY: 0.82 }, 10, 4);
  const tree = reuid(raw);
  tree._leafOrder = indexLeafRanges(tree);
  return tree;
}

function makeClientService(nodes: DataPoint[]): ClusteringService {
  const svc = new ClusteringService({
    minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation",
  });
  svc.rehydrateHierarchy(makeShippedTree(), COORDS, nodes, nodes);
  return svc;
}

function active(uid: string, overrides: Partial<SelectedActive> = {}): SelectedActive {
  return {
    uid,
    size: 2,
    stability: 5,
    saliency: 0.5,
    doiMass: 2,
    visibleMeanDoi: 1,
    group: 2,
    rescued: false,
    reserved: false,
    bbox: { minX: 0.1, minY: 0.1, maxX: 0.2, maxY: 0.2 },
    centroid: [0.15, 0.15],
    insetPos: [0.2, 0.2],
    leafRanges: [[0, 2]],
    hull: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]],
    ...overrides,
  };
}

function artifactOf(actives: SelectedActive[]): StaticBootFrameArtifact {
  return {
    format: STATIC_BOOT_FRAME_FORMAT,
    tree: "points",
    canvasWidth: 1216,
    canvasHeight: 1000,
    viewbox: VIEW,
    frame: {
      actives,
      borderScore: 0.2,
      examined: 7,
      clipped: false,
      fallbackRanking: false,
      focusActive: false,
      doiRevision: null,
    },
  };
}

/** The frame winners use SHIPPED-vocabulary-shaped uids that do NOT collide
 * with this tree's real reuid range, so frame-vs-local passes are
 * distinguishable by uid alone. */
const FRAME = artifactOf([
  active("0xAA", { leafRanges: [[0, 2]] }),
  active("0xBB", { leafRanges: [[2, 4]], group: 1, bbox: { minX: 0.8, minY: 0.8, maxX: 0.9, maxY: 0.9 } }),
]);

function run(svc: ClusteringService) {
  return svc.updateClusteringSemanticZoom(VIEW, xScale, yScale, W, H, true);
}

beforeEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
});

afterEach(() => {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(updateSettings({ ...initialVisualizationSettings }));
});

describe("static boot-frame adoption (client lane)", () => {
  it("applies the frame on the armed first pass and schedules the supersede", () => {
    const nodes = makeNodes();
    registerStaticBootFrame(nodes, FRAME);
    const svc = makeClientService(nodes);
    svc.enableStaticBootFrame();
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    const result = run(svc);

    expect(result.activeClusters.map((c) => c.uid)).toEqual(["0xAA", "0xBB"]);
    // The frame's classification rides serverGroups — no client masked-mean.
    expect(result.serverGroups?.get("0xAA")).toBe(2);
    expect(result.serverGroups?.get("0xBB")).toBe(1);
    // Winner members resolve through the shipped leaf order.
    expect(svc.membersOfCluster(result.activeClusters[0])).toEqual([0, 1]);
    expect(svc.membersOfCluster(result.activeClusters[1])).toEqual([2, 3]);
    // The genuine local pass is scheduled, not skipped.
    expect(onCutReady).toHaveBeenCalledTimes(1);
  });

  it("the second pass supersedes with the local pipeline and never re-applies", () => {
    const nodes = makeNodes();
    registerStaticBootFrame(nodes, FRAME);
    const svc = makeClientService(nodes);
    svc.enableStaticBootFrame();

    run(svc);
    const local = run(svc);

    // Local scoring result: real tree winners (the two pair clusters), no
    // server groups, labels materialized.
    expect(local.serverGroups).toBeUndefined();
    expect(local.activeClusters.map((c) => c.uid)).not.toContain("0xAA");
    expect(local.activeClusters.length).toBeGreaterThan(0);
    expect(local.labels).toHaveLength(nodes.length);

    // And a third pass stays local — the stash is gone.
    const third = run(svc);
    expect(third.serverGroups).toBeUndefined();
  });

  it("falls back to the local pipeline when no artifact arrived — and tombstones", () => {
    const nodes = makeNodes();
    const svc = makeClientService(nodes);
    svc.enableStaticBootFrame();
    const onCutReady = jest.fn();
    svc.setOnCutReady(onCutReady);

    const result = run(svc);
    expect(result.serverGroups).toBeUndefined();
    expect(result.activeClusters.length).toBeGreaterThan(0);
    expect(onCutReady).not.toHaveBeenCalled();

    // The slow fetch lands AFTER the boot pass: refused by the tombstone, so
    // a later select-all recluster (re-armed fast path) stays local.
    registerStaticBootFrame(nodes, FRAME);
    svc.enableStaticBootFrame();
    const later = run(svc);
    expect(later.serverGroups).toBeUndefined();
    expect(later.activeClusters.map((c) => c.uid)).not.toContain("0xAA");
  });

  it("ignores an empty-actives artifact (never blanks the boot)", () => {
    const nodes = makeNodes();
    registerStaticBootFrame(nodes, artifactOf([]));
    const svc = makeClientService(nodes);
    svc.enableStaticBootFrame();

    const result = run(svc);
    expect(result.serverGroups).toBeUndefined();
    expect(result.activeClusters.length).toBeGreaterThan(0);
  });

  it("is keyed by rows identity — a dataset switch never adopts the old frame", () => {
    const oldRows = makeNodes();
    registerStaticBootFrame(oldRows, FRAME);

    const nodes = makeNodes(); // the NEW dataset's rows array
    const svc = makeClientService(nodes);
    svc.enableStaticBootFrame();

    const result = run(svc);
    expect(result.serverGroups).toBeUndefined();
    expect(result.activeClusters.map((c) => c.uid)).not.toContain("0xAA");
  });

  it("an unarmed pass leaves the registered artifact untouched", () => {
    const nodes = makeNodes();
    registerStaticBootFrame(nodes, FRAME);
    const svc = makeClientService(nodes); // no enableStaticBootFrame()

    const result = run(svc);
    expect(result.serverGroups).toBeUndefined();
    // Not consumed: the worker-fit lane must never burn the slot the fast
    // path may still claim (e.g. progressive refine ordering).
    expect(takeStaticBootFrame(nodes)).toBe(FRAME);
  });

  it("the provider lane refuses to arm (the live warm frame owns it — I1)", () => {
    const nodes = makeNodes();
    registerStaticBootFrame(nodes, FRAME);
    const svc = new ClusteringService({
      minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation",
    });
    const provider = {
      manifest: { kind: "test", baseUrl: "http://localhost:0", capabilities: ["cut", "select-cut"] },
      cutKey: (request: CutRequest) => JSON.stringify(request.viewbox),
      getCut: () => new Promise(() => undefined),
      selectCut: () => new Promise(() => undefined),
      getLeafOrder: async () => new Uint32Array(0),
      cancel: () => undefined,
    } as unknown as ClusterCutProvider;
    svc.initServerCut(provider, "points", [0, 1, 2, 3], nodes, nodes);
    svc.enableStaticBootFrame(); // refused: provider lane

    const result = run(svc);
    // Frozen degradation while the real ask is in flight — never the artifact.
    expect(result.activeClusters).toHaveLength(0);
    // And the artifact slot was not consumed.
    expect(takeStaticBootFrame(nodes)).toBe(FRAME);
  });
});
