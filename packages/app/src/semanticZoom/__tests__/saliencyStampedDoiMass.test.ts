/**
 * Server-stamped candidate doiMass preference (issue #315 A3 / P-d, plan §6e).
 *
 * scoreCandidates now prefers `node.doiMass` (stamped off the cut candidate)
 * over both the O(1) `doiMassOf` prefix callback and the member-loop fallback.
 * An UNSTAMPED candidate must score byte-identically to before — this protects
 * client-complete datasets, where no candidate ever carries a stamped mass.
 */

import { describe, expect, it, jest } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { computeDoiMass, scoreCandidates } from "../saliencyScorer";

let _uid = 0;

function mkNode(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  size: number,
  children: number[],
  doiMass?: number
): ClusterTreeNode {
  return {
    id: _uid,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 1,
    size,
    stability: 5,
    children,
    bbox,
    doiMass,
  };
}

function mkPoint(idx: number, doi: number): DataPoint {
  return {
    x: idx, y: idx, line: 0, algo: "a", id: idx, action: "",
    DoI: doi, doiGroup: "annotation", nextEdgeCenter: { x: idx, y: idx },
  } as unknown as DataPoint;
}

const xScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 1000]);
const viewportArea = 1_000_000;
const CFG = {
  stabilityWeight: 0.3, doiMassWeight: 0.5, footprintWeight: 0.2,
  labelMinFraction: 0, splitThresholdPx: 1_000, doiDensityWeight: 0,
  chainDoiThreshold: 0.9,
};
const BIG = { minX: 0, minY: 0, maxX: 50, maxY: 50 };

describe("scoreCandidates — server-stamped doiMass (§6e)", () => {
  it("prefers the stamped doiMass over the member-loop sum", () => {
    // Member DoIs sum to 0.2, but the server stamped 5.0 — the stamp wins.
    const node = mkNode(BIG, 2, [0, 1], 5.0);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1)];
    const [scored] = scoreCandidates(
      [node], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, CFG
    );
    expect(scored.doiMass).toBe(5.0);
    // Sanity: the member-loop would have produced 0.2, so this is not that.
    expect(computeDoiMass([0, 1], pts)).toBeCloseTo(0.2);
  });

  it("prefers the stamped doiMass over the doiMassOf prefix callback (never consulted)", () => {
    const node = mkNode(BIG, 3, [0, 1], 7.0);
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1)];
    const doiMassOf = jest.fn<(n: ClusterTreeNode) => number | null>(() => 99);
    const [scored] = scoreCandidates(
      [node], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, CFG,
      undefined, undefined, undefined, doiMassOf
    );
    expect(scored.doiMass).toBe(7.0);
    expect(doiMassOf).not.toHaveBeenCalled();
  });

  it("unstamped candidate falls back to the member loop, byte-identically", () => {
    const node = mkNode(BIG, 2, [0, 1]); // no doiMass
    const pts = [mkPoint(0, 0.3), mkPoint(1, 0.4)];
    const [scored] = scoreCandidates(
      [node], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, CFG
    );
    // Equals the exact member-loop result — the fallback is unchanged.
    expect(scored.doiMass).toBeCloseTo(computeDoiMass([0, 1], pts), 10);
  });

  it("unstamped candidate uses the doiMassOf prefix callback when provided", () => {
    const node = mkNode(BIG, 4, [0, 1]); // no doiMass
    const pts = [mkPoint(0, 0.1), mkPoint(1, 0.1)];
    const doiMassOf = jest.fn<(n: ClusterTreeNode) => number | null>(() => 3.3);
    const [scored] = scoreCandidates(
      [node], (n) => n.children ?? [], pts, xScale, yScale, viewportArea, undefined, CFG,
      undefined, undefined, undefined, doiMassOf
    );
    expect(scored.doiMass).toBe(3.3);
    expect(doiMassOf).toHaveBeenCalledTimes(1);
  });
});
