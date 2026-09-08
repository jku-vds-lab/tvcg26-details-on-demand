/**
 * semanticZoom/hysteresis.ts
 *
 * Hysteresis-based activation / deactivation manager.
 *
 * ## Purpose
 * Small continuous changes in zoom or pan can cause cluster saliency scores
 * to fluctuate across the K-th-rank boundary, producing visible label flicker.
 * Hysteresis introduces asymmetric thresholds:
 *
 *   - A cluster *activates*   only when its saliency ≥ activationThreshold
 *   - A cluster *deactivates* only when its saliency  < deactivationThreshold
 *
 * where activationThreshold > deactivationThreshold, creating an inert band.
 *
 * ## Threshold derivation
 * Both thresholds are defined relative to the saliency of the K-th ranked
 * candidate (the "border" score at the annotation budget boundary):
 *
 *   activationThreshold   = borderScore × activateFactor   (factor ≥ 1)
 *   deactivationThreshold = borderScore × deactivateFactor (factor < activateFactor)
 *
 * This means thresholds adapt to the actual data distribution each frame
 * rather than being fixed constants.
 *
 * ## Interaction with split/merge (monotonic refinement)
 * When a cluster splits (parent replaced by children), the parent's UID is
 * no longer in `scoredCandidates`; the manager will naturally drop it and
 * potentially activate children if they pass the activation threshold.
 * Children whose footprints are still too small will be held back until the
 * user zooms in further—this is the intended progressively-disclosed behaviour.
 *
 * ## Budget enforcement
 * After hysteresis filtering, the result is capped at `budget` (maxActiveClusters)
 * by keeping the highest-saliency survivors.
 */

import type { ScoredCandidate } from "./types";

export class HysteresisManager {
  /** UIDs of clusters that are currently annotated. */
  private activeIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Update active cluster set for the current frame.
   *
   * @param scoredCandidates Scored + sorted (desc saliency) eligible candidates
   *                         for this frame.
   * @param budget           Maximum number of simultaneously active clusters
   *                         (= maxActiveClusters setting).
   * @param activateFactor   Multiplier on border saliency for new activations
   *                         (must be ≥ 1; typical 1.05–1.20).
   * @param deactivateFactor Multiplier on border saliency for deactivation
   *                         (must be < activateFactor; typical 0.75–0.95).
   * @returns Active ScoredCandidates in saliency-descending order.
   */
  update(
    scoredCandidates: ScoredCandidate[],
    budget: number,
    activateFactor: number,
    deactivateFactor: number
  ): ScoredCandidate[] {
    if (scoredCandidates.length === 0 || budget <= 0) {
      this.activeIds.clear();
      return [];
    }

    // Clamp factors to sensible ranges to prevent degenerate configs.
    const af = Math.max(1.0, activateFactor);
    const df = Math.min(af - Number.EPSILON, Math.max(0, deactivateFactor));

    // The "border" score is the saliency of the K-th candidate.
    const borderIdx = Math.min(budget - 1, scoredCandidates.length - 1);
    const borderScore = scoredCandidates[borderIdx].saliency;

    const activationThreshold = borderScore * af;
    const deactivationThreshold = borderScore * df;

    // Build candidate lookup for O(1) access.
    const candidateMap = new Map<string, ScoredCandidate>(
      scoredCandidates.map((c) => [c.node.uid, c])
    );

    // --- Retain currently active clusters that pass the deactivation check --
    const retained = new Set<string>();
    for (const uid of this.activeIds) {
      const c = candidateMap.get(uid);
      if (c && c.saliency >= deactivationThreshold) {
        retained.add(uid);
      }
      // otherwise the cluster either left the cut (split/merge) or dropped
      // below the deactivation threshold → remove it implicitly.
    }

    // --- Activate new candidates above the activation threshold -------------
    for (const c of scoredCandidates) {
      if (retained.size >= budget) break;
      if (!retained.has(c.node.uid) && c.saliency >= activationThreshold) {
        retained.add(c.node.uid);
      }
    }

    // --- Fill remaining budget from top-sorted candidates (no threshold) ----
    // This ensures that when few/no candidates pass the activation threshold
    // (e.g., first frame or very sparse view) we still show up to `budget`
    // labels rather than showing nothing.
    for (const c of scoredCandidates) {
      if (retained.size >= budget) break;
      retained.add(c.node.uid);
    }

    // --- Hard cap ------------------------------------------------------------
    // The retention loop above has no size check, so when the budget SHRINKS
    // between frames (the reserve-within-cap pass hands this manager a
    // fluctuating remainder) every previously-active candidate above the
    // deactivation threshold survives and the result can exceed `budget`.
    // Trim to the highest-saliency survivors and prune `activeIds` so trimmed
    // items must re-clear the *activation* threshold to return — the hysteresis
    // band itself prevents re-entry flicker. With a constant budget this branch
    // never fires (activeIds ≤ budget from the previous frame ⇒ retained ≤ budget).
    let result = scoredCandidates.filter((c) => retained.has(c.node.uid));
    if (result.length > budget) {
      result = result.slice(0, budget);
      this.activeIds = new Set(result.map((c) => c.node.uid));
    } else {
      this.activeIds = retained;
    }

    // Return in saliency-descending order.
    return result;
  }

  /**
   * Clear all active state (call when a full recluster happens so stale UIDs
   * do not carry over).
   */
  reset(): void {
    this.activeIds.clear();
  }

  /**
   * Read-only snapshot of currently active UIDs (for debugging / testing).
   */
  get activeUids(): ReadonlySet<string> {
    return this.activeIds;
  }
}
