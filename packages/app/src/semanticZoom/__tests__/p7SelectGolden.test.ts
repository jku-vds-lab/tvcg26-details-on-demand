// Golden-parity contract for the SERVER-SIDE select (issue #315 P7 S1, gap G4).
//
// The Python twin (tests/test_cluster_select.py) produces
// fixtures/p7select/golden.json by running rl_trajectories/cluster_select.py
// over a synthetic dataset; this test replays the SAME fixtures through the real
// CLIENT pipeline — reuid → indexLeafRanges → leaf padding →
// SemanticZoomService.computeActiveClusterIds (hybrid cut → scoreCandidates →
// two-pool hysteresis) — and asserts the client picks the same actives, in the
// same order, with the same saliencies, groups, and pool split.
//
// If either side drifts, one of the two suites goes red. Regenerate the fixture
// with `python -m tests.p7select_fixtures` ONLY after a deliberate semantic
// change, and re-run both suites.
//
// Replicated private helpers (the same concession serverCutGolden.test.ts makes):
//   * ClusteringService.computeLeafPad / patchLeafBBoxes — pad = max(range*1e-3,
//     Number.EPSILON), leaf bbox = point ± pad
//   * ClusteringService.localWhitespaceOf — 3×-inflated bbox floored at 2.5% of
//     the viewbox extent, foreign = windowCount − memberCount (an EXACT rect
//     count here; the server estimates it from a 256² summed-area grid, see the
//     rescue tolerance note below)
//   * ClusteringService.trajectoryThroughFlowOf — pred/succ = the previous/next
//     record carrying the same `line`; "in subset" = DoI ≥ annotation threshold
//   * hdbscanClustering's annotation/inset split — masked VISIBLE-member mean
//     DoI (DoI ≥ grayOut), ≥ inset → 2, ≥ annotation → 1, else 0
//
// ## Rescue tolerance (risk R1)
// The server's whitespace probe is a grid ESTIMATE, the client's is an exact
// RBush rect count, so a candidate whose whitespace sits near
// RESCUE_WHITESPACE_MIN (0.5) may be rescued on one side only. This test
// therefore treats a rescue-eligible candidate as AMBIGUOUS when the client's
// whitespace lands inside 0.5 ± WHITESPACE_BAND and excludes it from the strict
// comparison — and separately asserts that the committed fixture contains NO
// ambiguous candidate, so the strict path is the one that actually runs. Every
// non-rescue winner is compared exactly, always.

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import * as fs from "fs";
import * as path from "path";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import { indexLeafRanges, reuid } from "../../hooks/useFullSelectionHdbscanInstance";
import { RESCUE_WHITESPACE_MIN } from "../saliencyScorer";
import { SemanticZoomService } from "../semanticZoomService";
import type { SemanticZoomConfig, Viewbox } from "../types";

const FIXTURE = path.resolve(__dirname, "fixtures/p7select/golden.json");

/** Half-width of the whitespace band in which grid-estimate vs exact-count
 *  probes may legitimately disagree (see the header). */
const WHITESPACE_BAND = 0.1;

interface FixtureRecord { id: number; line: number; x: number; y: number }

interface ExpectedActive {
  uid: string;
  size: number;
  stability: number;
  saliency: number;
  doiMass: number;
  visibleMeanDoi: number;
  group: number;
  rescued: boolean;
  reserved: boolean;
  leafRanges: number[][];
}

interface FixtureFrame {
  budget: number;
  viewbox: Viewbox;
  echo: { main: string[]; rescue: string[] };
  expected: {
    actives: ExpectedActive[];
    borderScore: number;
    fallbackRanking: boolean;
    examined: number;
    clipped: boolean;
  };
}

interface FixtureCase {
  name: string;
  viewbox: Viewbox;
  canvasWidth: number;
  canvasHeight: number;
  splitThresholdPx: number;
  gapDisclosurePx: number;
  focusActive: boolean;
  hasDoi: boolean;
  select: {
    weights: { stability: number; doiMass: number; footprint: number; doiDensity: number };
    labelMinFraction: number;
    chainDoiThreshold: number;
    budget: number;
    chainRescueBudget: number;
    hysteresis: { activate: number; deactivate: number };
    thresholds: { grayOut: number; annotation: number; inset: number };
  };
  frames: FixtureFrame[];
}

interface Fixture {
  records: FixtureRecord[];
  leafOrder: number[];
  tree: ClusterTreeNode;
  doi: { revision: number; focusActive: boolean; record: number[] };
  cases: FixtureCase[];
}

/** Replicates ClusteringService.computeLeafPad + patchLeafBBoxes (private). */
function patchLeafBBoxes(root: ClusterTreeNode, data: FixtureRecord[]): void {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of data) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const padX = Math.max((maxX - minX) * 1e-3, Number.EPSILON);
  const padY = Math.max((maxY - minY) * 1e-3, Number.EPSILON);
  const stack: ClusterTreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!node.leftChild && !node.rightChild) {
      const idx = (node.leafIndex ?? node.id) as number;
      const p = data[idx];
      if (p) {
        node.bbox = { minX: p.x - padX, maxX: p.x + padX, minY: p.y - padY, maxY: p.y + padY };
      }
      continue;
    }
    if (node.leftChild) stack.push(node.leftChild);
    if (node.rightChild) stack.push(node.rightChild);
  }
}

type RangeNode = ClusterTreeNode & { firstLeaf?: number; lastLeaf?: number };

describe("server select golden parity (issue #315 P7 S1)", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Fixture;
  const { records, doi } = fixture;

  // The client's own identity + leaf-order pass over the SHIPPED tree.
  const root = reuid(fixture.tree);
  const leafOrder = indexLeafRanges(root);
  patchLeafBBoxes(root, records);

  it("derives the same leaf order the server did", () => {
    expect(leafOrder).toEqual(fixture.leafOrder);
  });

  /** Exact twin of ClusteringService.localWhitespaceOf. */
  function localWhitespaceOf(node: RangeNode, viewbox: Viewbox, points: FixtureRecord[]): number {
    if (!node.bbox) return 0;
    const memberCount = membersOf(node).length;
    if (memberCount === 0) return 0;
    const b = node.bbox;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const floorX = (viewbox.maxX - viewbox.minX) * 0.025;
    const floorY = Math.abs(viewbox.maxY - viewbox.minY) * 0.025;
    const halfW = Math.max(((b.maxX - b.minX) / 2) * 3, floorX);
    const halfH = Math.max(((b.maxY - b.minY) / 2) * 3, floorY);
    let windowCount = 0;
    for (const p of points) {
      if (p.x >= cx - halfW && p.x <= cx + halfW && p.y >= cy - halfH && p.y <= cy + halfH) {
        windowCount += 1;
      }
    }
    const foreign = Math.max(0, windowCount - memberCount);
    return memberCount / (memberCount + foreign);
  }

  function membersOf(node: RangeNode): number[] {
    if (node.firstLeaf == null || node.lastLeaf == null) return [];
    return leafOrder.slice(node.firstLeaf, node.lastLeaf);
  }

  // Trajectory pred/succ: previous/next record with the same `line`
  // (doi_propagate._build_pred_succ / propagateDoiCore's record-order scan).
  const predIndex = new Int32Array(records.length).fill(-1);
  const succIndex = new Int32Array(records.length).fill(-1);
  {
    const lastOfLine = new Map<number, number>();
    records.forEach((r, i) => {
      const prev = lastOfLine.get(r.line);
      if (prev !== undefined) {
        predIndex[i] = prev;
        succIndex[prev] = i;
      }
      lastOfLine.set(r.line, i);
    });
  }

  for (const testCase of fixture.cases) {
    it(`matches the server frame-by-frame: ${testCase.name}`, () => {
      // Production defaults absent DoI to FULL interest (`DoI ?? 1`,
      // dataPreprocessing.ts:109) — no-DoI cases must classify as insets.
      const doiOf = (i: number) => (testCase.hasDoi ? doi.record[i] : 1);
      const nodes = records.map((r, i) => ({
        id: String(r.id), x: r.x, y: r.y, line: r.line, DoI: doiOf(i),
      })) as unknown as DataPoint[];
      const { grayOut, annotation, inset } = testCase.select.thresholds;

      const singletonThroughFlow = (node: RangeNode): boolean => {
        const members = membersOf(node);
        if (members.length !== 1) return false;
        const idx = members[0];
        const inSubset = (i: number) => i >= 0 && doiOf(i) >= annotation;
        return inSubset(predIndex[idx]) && inSubset(succIndex[idx]);
      };

      /** Masked visible-member mean DoI → the annotation/inset group. */
      const groupOf = (node: RangeNode): { mean: number; group: number } => {
        let sum = 0;
        let visible = 0;
        for (const i of membersOf(node)) {
          const v = doiOf(i);
          if (v >= grayOut) { sum += v; visible += 1; }
        }
        const mean = visible > 0 ? sum / visible : 0;
        return { mean, group: mean >= inset ? 2 : mean >= annotation ? 1 : 0 };
      };

      const service = new SemanticZoomService();
      const ambiguous = new Set<string>();

      testCase.frames.forEach((frame, frameIndex) => {
        const viewbox = frame.viewbox;
        const xScale = d3.scaleLinear()
          .domain([viewbox.minX, viewbox.maxX]).range([0, testCase.canvasWidth]);
        const yScale = d3.scaleLinear()
          .domain([viewbox.minY, viewbox.maxY]).range([testCase.canvasHeight, 0]);

        const config: SemanticZoomConfig = {
          splitThresholdPx: testCase.splitThresholdPx,
          labelMinFraction: testCase.select.labelMinFraction,
          stabilityWeight: testCase.select.weights.stability,
          doiMassWeight: testCase.select.weights.doiMass,
          footprintWeight: testCase.select.weights.footprint,
          doiDensityWeight: testCase.select.weights.doiDensity,
          chainDoiThreshold: testCase.select.chainDoiThreshold,
          gapDisclosurePx: testCase.gapDisclosurePx,
          chainRescueBudget: testCase.select.chainRescueBudget,
          hysteresisActivateFactor: testCase.select.hysteresis.activate,
          hysteresisDeactivateFactor: testCase.select.hysteresis.deactivate,
        };

        // The echo the server was given must be the pools the client holds
        // going INTO this frame — the whole point of contract (b).
        const svc = service as unknown as {
          hysteresis: { activeUids: ReadonlySet<string> };
          rescueHysteresis: { activeUids: ReadonlySet<string> };
        };
        expect(Array.from(svc.hysteresis.activeUids).sort())
          .toEqual(frame.echo.main.slice().sort());
        expect(Array.from(svc.rescueHysteresis.activeUids).sort())
          .toEqual(frame.echo.rescue.slice().sort());

        const result = service.computeActiveClusterIds(
          root, viewbox, xScale, yScale,
          testCase.canvasWidth, testCase.canvasHeight,
          membersOf, nodes, frame.budget, config,
          // A fresh rev per frame: in server-select mode every arriving frame
          // carries a new cut rev, so the signature cache never short-circuits
          // an echo iteration.
          frameIndex + 1,
          (node) => localWhitespaceOf(node as RangeNode, viewbox, records),
          testCase.focusActive,
          (node) => singletonThroughFlow(node as RangeNode),
        );

        // Any rescue-eligible candidate sitting ON the probe's decision
        // boundary is excluded from the strict comparison (see the header).
        for (const candidate of result.zoomCut) {
          const ws = localWhitespaceOf(candidate as RangeNode, viewbox, records);
          if (Math.abs(ws - RESCUE_WHITESPACE_MIN) < WHITESPACE_BAND) {
            ambiguous.add(String(candidate.uid));
          }
        }

        const strict = (uid: string) => !ambiguous.has(uid);
        const clientUids = result.activeCandidates.map((c) => String(c.node.uid));
        const expectedUids = frame.expected.actives.map((a) => a.uid);
        expect(clientUids.filter(strict)).toEqual(expectedUids.filter(strict));

        // Per-active parity: saliency, the rescue flag, the DoI mass, and the
        // classification group.
        const byUid = new Map(result.activeCandidates.map((c) => [String(c.node.uid), c]));
        for (const expectedActive of frame.expected.actives) {
          if (!strict(expectedActive.uid)) continue;
          const candidate = byUid.get(expectedActive.uid)!;
          expect(candidate).toBeDefined();
          expect(candidate.node.size).toBe(expectedActive.size);
          expect(candidate.node.stability).toBeCloseTo(expectedActive.stability, 12);
          expect(candidate.saliency).toBeCloseTo(expectedActive.saliency, 9);
          expect(candidate.doiMass).toBeCloseTo(expectedActive.doiMass, 9);
          expect(candidate.rescued).toBe(expectedActive.rescued);
          const { mean, group } = groupOf(candidate.node as RangeNode);
          expect(mean).toBeCloseTo(expectedActive.visibleMeanDoi, 9);
          expect(group).toBe(expectedActive.group);
          const range = expectedActive.leafRanges[0];
          expect([(candidate.node as RangeNode).firstLeaf,
                  (candidate.node as RangeNode).lastLeaf]).toEqual(range);
        }

        // The pool split (`reserved`) is the echo key, so it must match the
        // client's two managers after the pass.
        expect(Array.from(svc.rescueHysteresis.activeUids).filter(strict).sort()).toEqual(
          frame.expected.actives.filter((a) => a.reserved && strict(a.uid))
            .map((a) => a.uid).sort()
        );
      });

      // The committed fixture is built to stay clear of the probe's ambiguity
      // band; if this ever fails, the strict comparison above silently stopped
      // covering those uids — re-check the fixture geometry, do not relax it.
      expect(Array.from(ambiguous)).toEqual([]);
    });
  }
});
