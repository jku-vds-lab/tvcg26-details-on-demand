/**
 * Convergence predicate and constants for the layout engine's sleep/wake
 * gating (useLayoutEngine.ts).
 *
 * The engine's rAF loop historically ran forever: every frame paid the clamp
 * pass, the O(elements²) selective-reheat scans, and at least two full
 * annealer cost evaluations even with every element cold and nothing moving.
 * Sleeping is safe because all reheat predicates are pure functions of
 * geometry (positions, scales, viewbox, contours, element set): with every
 * input unchanged and every element cold, no predicate outcome can change.
 * Every input-mutation channel therefore wakes the engine (layoutStore
 * subscription, prop/ref syncs in ClusterVisualizations, reheatRef), with a
 * signature-compare watchdog as the safety net for any missed wiring.
 *
 * Pure module: no React, no DOM.
 */

/** Consecutive converged frames required before the rAF loop stops. */
export const SLEEP_AFTER_CONVERGED_FRAMES = 3;

/** Watchdog cadence while sleeping — caps a missed wake at this latency. */
export const SLEEP_WATCHDOG_INTERVAL_MS = 500;

/**
 * Per-frame wall-clock budget for the simulated-annealing run. Warm frames
 * previously ran up to `insetOptimizationIterations` (1200) full cost
 * evaluations inside one rAF callback — the "freeze while insets pop in".
 * Spreading iterations across frames is semantics-preserving: the engine
 * re-runs every frame with fresh state and cooling is per-accepted-move.
 */
export const ANNEAL_FRAME_BUDGET_MS = 6;

export interface FrameOutcome {
  /** A zoom/pan gesture is active (engine already skips reheat + annealer). */
  isZooming: boolean;
  /** layoutStore version changed during this frame (clamp, annealer, or cartographic patch landed). */
  storeChanged: boolean;
  /** A selective reheat warmed at least one element this frame. */
  reheatApplied: boolean;
  /** A reheat predicate fired but was blocked by the per-element cooldown. */
  reheatSuppressed: boolean;
  /** Any element still has temperature > 0 after the annealer ran. */
  anyWarm: boolean;
  /** Cartographic mode pins positions directly and never cools temperatures. */
  positioningMode: "annealing" | "cartographic";
}

/**
 * True when the frame did no work and cannot do work next frame either,
 * given unchanged inputs. A suppressed reheat keeps the loop running so the
 * pending reheat fires when its cooldown expires (within 500 ms).
 */
export function isConvergedFrame(o: FrameOutcome): boolean {
  if (o.isZooming) return false;
  if (o.storeChanged) return false;
  if (o.reheatApplied) return false;
  if (o.reheatSuppressed) return false;
  if (o.positioningMode !== "cartographic" && o.anyWarm) return false;
  return true;
}
