/**
 * semanticZoom/__tests__/resolveSplitThreshold.test.ts
 *
 * Guards for the viewport-relative split threshold (`splitThresholdFraction`
 * replacing the absolute `splitThresholdPx` default of 34 500 px²).
 *
 * Key properties verified:
 * 1. The default fraction (3%, empirically calibrated) resolves to EXACTLY
 *    34 500 px² on a canvas with the reference area
 *    (SPLIT_THRESHOLD_REFERENCE_AREA_PX = 34 500 / 0.03 = 1 150 000 px²) —
 *    behavior-identical to the old absolute default where it was tuned.
 * 2. The resolved threshold scales linearly with view area (resize-aware).
 * 3. The label-eligibility gate (labelMinFraction × split threshold) is
 *    unchanged at the reference area and scales with view area exactly ONCE —
 *    no double-relativity, since labelMinFraction stays relative to the split
 *    threshold rather than to the viewport.
 */

import { describe, expect, it } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { initialClusterSettings, SPLIT_THRESHOLD_REFERENCE_AREA_PX } from "../../store";
import { resolveSplitThresholdPx } from "../footprint";
import { scoreCandidates } from "../saliencyScorer";

const LEGACY_SPLIT_THRESHOLD_PX = 34_500;

// A canvas whose area equals the calibration reference area exactly.
const REF_W = 2000;
const REF_H = 575; // 2000 × 575 = 1 150 000 px²

// ---------------------------------------------------------------------------
// Helpers (same shapes as saliencyScorer.test.ts)
// ---------------------------------------------------------------------------

let _uid = 0;

function mkNode(
  id: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  stability: number,
  size: number = 1,
  children: number[] = []
): ClusterTreeNode {
  return {
    id,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 1,
    size,
    stability,
    children,
    bbox,
  };
}

function mkPoint(idx: number, doi: number): DataPoint {
  return {
    x: idx,
    y: idx,
    line: 0,
    algo: "a",
    id: idx,
    action: "",
    DoI: doi,
    doiGroup: "annotation",
    nextEdgeCenter: { x: idx, y: idx },
  };
}

// Reference canvas: data [0,100] → screen [0,2000] × [0,575]
// (20 px/unit horizontally, 5.75 px/unit vertically → 115 px² per data unit²).
const xScale = d3.scaleLinear().domain([0, 100]).range([0, REF_W]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, REF_H]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe("resolveSplitThresholdPx", () => {
  it("resolves the default fraction to exactly the legacy 34 500 px² at the reference area", () => {
    expect(SPLIT_THRESHOLD_REFERENCE_AREA_PX).toBe(34_500 / 0.03);
    expect(initialClusterSettings.splitThresholdFraction).toBe(0.03);
    expect(
      resolveSplitThresholdPx(initialClusterSettings.splitThresholdFraction, REF_W, REF_H)
    ).toBe(LEGACY_SPLIT_THRESHOLD_PX);
  });

  it("scales linearly with view area", () => {
    const atRef = resolveSplitThresholdPx(
      initialClusterSettings.splitThresholdFraction,
      REF_W,
      REF_H
    );
    // Double both canvas dimensions → 4× the area → 4× the threshold.
    expect(
      resolveSplitThresholdPx(
        initialClusterSettings.splitThresholdFraction,
        2 * REF_W,
        2 * REF_H
      )
    ).toBe(4 * atRef);
  });
});

// ---------------------------------------------------------------------------
// Label-eligibility gate
// ---------------------------------------------------------------------------

describe("label-eligibility gate under the viewport-relative threshold", () => {
  const resolvedAtRef = resolveSplitThresholdPx(
    initialClusterSettings.splitThresholdFraction,
    REF_W,
    REF_H
  );

  it("keeps the gate value byte-identical at the reference area (no double-relativity)", () => {
    // The gate is labelMinFraction × splitThresholdPx (saliencyScorer.ts).
    // With the resolved threshold equal to the legacy constant, the product —
    // including its floating-point rounding — is the exact same expression
    // as before the change.
    expect(initialClusterSettings.labelMinFraction * resolvedAtRef).toBe(
      initialClusterSettings.labelMinFraction * LEGACY_SPLIT_THRESHOLD_PX
    );
    // And it scales with view area exactly once: 4× area → 4× gate.
    const resolvedAt4x = resolveSplitThresholdPx(
      initialClusterSettings.splitThresholdFraction,
      2 * REF_W,
      2 * REF_H
    );
    expect(initialClusterSettings.labelMinFraction * resolvedAt4x).toBe(
      4 * (initialClusterSettings.labelMinFraction * LEGACY_SPLIT_THRESHOLD_PX)
    );
  });

  it("filters candidates around the same px² boundary as the legacy default at the reference area", () => {
    // Gate at defaults: 0.01 × 34 500 = 345 px² (= 3 data-unit² × 115 px²/unit²).
    // below: 2×1 data units → 40×5.75 px = 230 px²  (< 345 → filtered)
    // above: 4×1 data units → 80×5.75 px = 460 px²  (≥ 345 → passes)
    const below = mkNode(0, { minX: 0, minY: 0, maxX: 2, maxY: 1 }, 5, 2, [0, 1]);
    const above = mkNode(1, { minX: 10, minY: 10, maxX: 14, maxY: 11 }, 5, 2, [2, 3]);
    const pts = [mkPoint(0, 0.5), mkPoint(1, 0.5), mkPoint(2, 0.5), mkPoint(3, 0.5)];
    const membersOf = (n: ClusterTreeNode) => n.children ?? [];

    const result = scoreCandidates(
      [below, above],
      membersOf,
      pts,
      xScale,
      yScale,
      REF_W * REF_H,
      undefined,
      {
        stabilityWeight: initialClusterSettings.stabilityWeight,
        doiMassWeight: initialClusterSettings.doiMassWeight,
        footprintWeight: initialClusterSettings.footprintWeight,
        labelMinFraction: initialClusterSettings.labelMinFraction,
        splitThresholdPx: resolvedAtRef,
        doiDensityWeight: initialClusterSettings.doiDensityWeight,
        chainDoiThreshold: initialClusterSettings.chainDoiThreshold,
      }
    );

    expect(result.map((c) => c.node.uid)).toEqual([above.uid]);
  });
});
