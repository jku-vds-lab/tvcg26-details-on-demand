// packages/app/src/dataPreprocessing/lazyTrajectoryMidpoints.ts
//
// Lazy trajectory-midpoints registry (issue #315 B2).
//
// The midpoints array (~one JS object per edge, 1M at synth1m scale) used to
// be built eagerly during dataset preparation, but with the default
// `relationInsetBudget` of 0 every consumer is short-circuited — the build
// was the dominant post-settle CPU tail. The dataset load now registers a
// BUILDER here instead; the first genuine consumer (the midpoint clustering
// fit, which every consumer path funnels through) awaits
// `ensureTrajectoryMidpoints()` to materialize them on demand.
//
// The builder is responsible for installing the built array into the
// midpoint refs/R-tree and bumping the context version — this module only
// owns the once-per-load memoization. Must stay rbush/DOM-free.

import type { TrajectoryMidpoint } from "./dataPreprocessing";

export type TrajectoryMidpointsBuilder = () => Promise<TrajectoryMidpoint[]>;

let builder: TrajectoryMidpointsBuilder | null = null;
let pending: Promise<TrajectoryMidpoint[]> | null = null;

/**
 * Register the builder for the current dataset (null to clear on unload).
 * Replaces any previous registration and drops its memoized result.
 */
export function registerTrajectoryMidpointsBuilder(
  next: TrajectoryMidpointsBuilder | null
): void {
  builder = next;
  pending = null;
}

/**
 * Materialize the trajectory midpoints for the current dataset, building at
 * most once per registration. Returns [] when no builder is registered
 * (no dataset / dataset without segment columns) or when the build fails
 * (aborted by a dataset switch) — a later call may retry after a failure.
 */
export function ensureTrajectoryMidpoints(): Promise<TrajectoryMidpoint[]> {
  const active = builder;
  if (!active) return Promise.resolve([]);
  if (!pending) {
    pending = active().catch(() => {
      if (builder === active) pending = null;
      return [];
    });
  }
  return pending;
}
