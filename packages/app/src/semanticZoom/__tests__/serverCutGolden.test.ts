// Golden-parity contract for the server-side hierarchy cut (issue #315 S1).
//
// This test runs the REAL client pipeline (reuid → indexLeafRanges → leaf-bbox
// padding → buildHybridCutFromRoot) over the committed 18-point fixture
// dataset for a matrix of (viewbox, threshold, gap, focus) scenarios and
// compares the resulting uid lists against tests/fixtures/cluster_cut_golden.json
// at the repo root. The Python twin (tests/test_cluster_cut.py) asserts that
// rl_trajectories/cluster_cut.py produces the same fixture from the same
// inputs — if either side drifts, one of the two suites goes red.
//
// If the fixture file does not exist yet, this test WRITES it (and passes);
// commit the generated file. Delete it to intentionally regenerate after a
// semantic change on the client side.
//
// Leaf padding note: computeLeafPad/patchLeafBBoxes are private methods on
// ClusteringService; the formulas are replicated here (and in Python) —
// pad = max(dataAxisRange * 1e-3, Number.EPSILON), leaf bbox = point ± pad.

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { indexLeafRanges, reuid } from "../../hooks/useFullSelectionHdbscanInstance";
import { buildHybridCutFromRoot } from "../zoomCutBuilder";

const DATASET = path.resolve(
  __dirname,
  "../../../public/data/combination-example-2_knng_splines_stability.json.gz"
);
// Repo-root tests/fixtures — packages/ restructure moved this file one level
// deeper (packages/app/src/semanticZoom/__tests__/).
const FIXTURE = path.resolve(__dirname, "../../../../../tests/fixtures/cluster_cut_golden.json");

interface Scenario {
  name: string;
  tree: "points" | "midpoints";
  viewbox: { minX: number; minY: number; maxX: number; maxY: number };
  canvasWidth: number;
  canvasHeight: number;
  splitThresholdFraction: number;
  gapDisclosurePx: number;
  focusActive: boolean;
}

function loadDataset(): Record<string, unknown> {
  const raw = zlib.gunzipSync(fs.readFileSync(DATASET)).toString("utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function dataExtent(data: Array<{ x: number; y: number }>) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of data) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Replicates ClusteringService.computeLeafPad + patchLeafBBoxes (private). */
function patchLeafBBoxes(
  root: ClusterTreeNode,
  data: Array<{ x: number; y: number }>
): void {
  const ext = dataExtent(data);
  const leafPadX = Math.max((ext.maxX - ext.minX) * 1e-3, Number.EPSILON);
  const leafPadY = Math.max((ext.maxY - ext.minY) * 1e-3, Number.EPSILON);
  const stack: ClusterTreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.leftChild && !node.rightChild) {
      const idx = (node.leafIndex ?? node.id) as number;
      const p = data[idx];
      if (p) {
        node.bbox = {
          minX: p.x - leafPadX,
          maxX: p.x + leafPadX,
          minY: p.y - leafPadY,
          maxY: p.y + leafPadY,
        };
      }
      continue;
    }
    if (node.leftChild) stack.push(node.leftChild);
    if (node.rightChild) stack.push(node.rightChild);
  }
}

function prepareTree(
  json: Record<string, unknown>,
  key: "hdbscan" | "midpointHdbscan",
  data: Array<{ x: number; y: number }>
): { root: ClusterTreeNode; leafOrder: number[] } {
  const entry = json[key] as { hierarchyTree?: ClusterTreeNode } | undefined;
  const raw = entry?.hierarchyTree;
  if (!raw) throw new Error(`Fixture dataset has no ${key}.hierarchyTree`);
  const root = reuid(raw);
  const leafOrder = indexLeafRanges(root);
  patchLeafBBoxes(root, data);
  return { root, leafOrder };
}

function runScenario(
  root: ClusterTreeNode,
  s: Scenario
): Array<{ uid: string; leafRanges: number[][] }> {
  const xScale = d3.scaleLinear().domain([s.viewbox.minX, s.viewbox.maxX]).range([0, s.canvasWidth]);
  const yScale = d3.scaleLinear().domain([s.viewbox.minY, s.viewbox.maxY]).range([s.canvasHeight, 0]);
  const splitThresholdPx =
    s.splitThresholdFraction * Math.max(s.canvasWidth * s.canvasHeight, 1);
  const cut = buildHybridCutFromRoot(root, s.viewbox, xScale, yScale, splitThresholdPx, {
    gapDisclosurePx: s.gapDisclosurePx,
    active: s.focusActive,
  });
  return cut.map((n) => {
    const withRanges = n as ClusterTreeNode & { firstLeaf?: number; lastLeaf?: number };
    return {
      uid: String(n.uid),
      leafRanges: [[withRanges.firstLeaf ?? -1, withRanges.lastLeaf ?? -1]],
    };
  });
}

describe("server-cut golden parity (issue #315 S1)", () => {
  it("client walk matches the committed golden fixture (shared with Python)", () => {
    const json = loadDataset();
    const data = json.data as Array<{ x: number; y: number }>;
    const ext = dataExtent(data);
    const spanX = ext.maxX - ext.minX;
    const spanY = ext.maxY - ext.minY;

    // Viewboxes derived from the data extent so the fixture is
    // dataset-portable; margins chosen to exercise inside/overflow/prune.
    const full = {
      minX: ext.minX - 0.1 * spanX,
      maxX: ext.maxX + 0.1 * spanX,
      minY: ext.minY - 0.1 * spanY,
      maxY: ext.maxY + 0.1 * spanY,
    };
    const zoomed = {
      minX: ext.minX + 0.25 * spanX,
      maxX: ext.minX + 0.65 * spanX,
      minY: ext.minY + 0.25 * spanY,
      maxY: ext.minY + 0.65 * spanY,
    };

    const scenarios: Scenario[] = [];
    for (const tree of ["points", "midpoints"] as const) {
      scenarios.push(
        { name: `${tree}-overview-default`, tree, viewbox: full, canvasWidth: 1600, canvasHeight: 1000, splitThresholdFraction: 0.03, gapDisclosurePx: 48, focusActive: false },
        { name: `${tree}-overview-focus-gap`, tree, viewbox: full, canvasWidth: 1600, canvasHeight: 1000, splitThresholdFraction: 0.03, gapDisclosurePx: 48, focusActive: true },
        { name: `${tree}-overview-huge-threshold`, tree, viewbox: full, canvasWidth: 1600, canvasHeight: 1000, splitThresholdFraction: 10, gapDisclosurePx: 0, focusActive: false },
        { name: `${tree}-overview-tiny-threshold`, tree, viewbox: full, canvasWidth: 1600, canvasHeight: 1000, splitThresholdFraction: 1e-7, gapDisclosurePx: 0, focusActive: false },
        { name: `${tree}-zoomed-default`, tree, viewbox: zoomed, canvasWidth: 1600, canvasHeight: 1000, splitThresholdFraction: 0.03, gapDisclosurePx: 48, focusActive: true },
        { name: `${tree}-zoomed-small-canvas`, tree, viewbox: zoomed, canvasWidth: 400, canvasHeight: 300, splitThresholdFraction: 0.03, gapDisclosurePx: 24, focusActive: true },
      );
    }

    const prepared = {
      points: prepareTree(json, "hdbscan", data),
      midpoints: prepareTree(json, "midpointHdbscan", data),
    };

    const golden = {
      dataset: "packages/app/public/data/combination-example-2_knng_splines_stability.json.gz",
      leafOrder: {
        points: prepared.points.leafOrder,
        midpoints: prepared.midpoints.leafOrder,
      },
      cases: scenarios.map((s) => ({
        scenario: s,
        candidates: runScenario(prepared[s.tree].root, s),
      })),
    };

    if (!fs.existsSync(FIXTURE)) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, JSON.stringify(golden, null, 2) + "\n");
      console.warn(`serverCutGolden: wrote new fixture ${FIXTURE} — commit it.`);
      return;
    }

    const committed = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
    expect(golden.leafOrder).toEqual(committed.leafOrder);
    expect(golden.cases).toEqual(committed.cases);
  });
});
