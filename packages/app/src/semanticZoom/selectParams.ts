// src/semanticZoom/selectParams.ts
//
// The one place the wire `select` block is built (issue #315 P7 §1.1).
//
// Two callers need it and MUST agree: the steady-state ClusteringService (whose
// requests carry the hysteresis echo) and the boot warmer (whose push happens
// before any service exists, with an empty echo). If they built different blocks
// the boot walk would answer a different question than the first real request —
// different cut key, different winners, and the pre-rendered inset content would
// miss the mount set.
//
// Open-core: pure Redux → wire mapping, no transport, no endpoint strings.

import type { SelectParams } from "../scaling.types";
import store from "../store";

/**
 * The `select` block for the CURRENT Redux settings plus `echo` (contract b).
 *
 * WIRE names, not the Redux ones (`rl_trajectories/cluster_select.normalize_select`
 * owns the vocabulary): the classification thresholds come from
 * `visualizationSettings` because that is where the hidden/annotation/inset
 * slider row lives, everything else from `clusterSettings`.
 *
 * `settled` distinguishes a mid-gesture frame (inset relaxation skipped
 * server-side) from a resting one. NOTE: the wheel-destination prefetch
 * deliberately keeps `settled: true` — it asks for the view the gesture is going
 * to REST in, and `settled` is part of the cut key, so flipping it would make the
 * settle-time request a different question and throw the prefetched frame away.
 */
export function buildSelectParams(
  echo: { main: string[]; rescue: string[] },
  settled = true
): SelectParams {
  const state = store.getState();
  const settings = state.clusterSettings;
  const visual = state.visualizationSettings;
  return {
    weights: {
      stability: settings.stabilityWeight,
      doiMass: settings.doiMassWeight,
      footprint: settings.footprintWeight,
      doiDensity: settings.doiDensityWeight,
    },
    labelMinFraction: settings.labelMinFraction,
    chainDoiThreshold: settings.chainDoiThreshold,
    budget: settings.maxActiveClusters,
    chainRescueBudget: settings.chainRescueBudget,
    hysteresis: {
      activate: settings.hysteresisActivateFactor,
      deactivate: settings.hysteresisDeactivateFactor,
    },
    thresholds: {
      grayOut: visual.grayOutDoiThreshold,
      annotation: visual.annotationDoiThreshold,
      inset: visual.insetDoiThreshold,
    },
    actives: { main: [...echo.main], rescue: [...echo.rescue] },
    fmt: "json",
    settled,
  };
}
