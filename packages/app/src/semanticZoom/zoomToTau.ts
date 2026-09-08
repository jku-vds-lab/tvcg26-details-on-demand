/**
 * semanticZoom/zoomToTau.ts
 *
 * Deterministic mapping from the current viewport (zoom + pan state) to the
 * τ connectivity threshold consumed by `buildTauCut`.
 *
 * ## Formula
 *
 *   viewportFraction = clamp((viewW × viewH) / (rootW × rootH), 0, 1)
 *   τ = τ_max × tauScale × viewportFraction ^ tauExponent
 *
 * ## Intuition
 *   - `viewportFraction` encodes zoom depth: 1.0 = full dataset visible,
 *     ≈ 0 = single point fills the screen.
 *   - Multiplied by τ_max, this yields a τ proportional to the fraction of
 *     the dataset in view, ensuring the cluster granularity tracks the zoom.
 *   - `tauScale`    (slider ∈ [0, 2], default 1.0): coarsens (> 1) or
 *     refines (< 1) the cut globally — adjusts how "dense" the labeling is.
 *   - `tauExponent` (slider ∈ [0.1, 3], default 1.0): controls curve shape.
 *     < 1 → slow start (stays coarse even at moderate zoom-in).
 *     > 1 → fast start (splits quickly as soon as you zoom in).
 *
 * ## Extreme-zoom guarantee
 * At extreme zoom-in, viewportFraction → 0, so τ → 0.  The τ-cut builder
 * then produces singletons for visible isolated points — no special casing.
 *
 * ## Determinism
 * Pure function of (viewbox, rootBbox, tauMax, tauScale, tauExponent).
 * Given the same inputs it always returns the same τ, making the system
 * predictable and easy to test.
 */

import type { Viewbox } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute τ for the current viewport.
 *
 * @param viewbox      Data-space viewport bounding box (from the R-tree /
 *                     D3 inverse-scale of canvas corners).
 * @param rootBbox     Bounding box of the entire dataset (`root.bbox`).
 * @param tauMax       Maximum τ = `root.distance` (HDBSCAN merge scale).
 *                     In the same units as `node.distance` — dataset-specific.
 * @param tauScale     User slider [0, 2], default 1.0.
 * @param tauExponent  User slider [0.1, 3], default 1.0.
 * @returns τ ≥ 0 in data-derived merge-scale units.
 */
export function zoomToTau(
  viewbox: Viewbox | undefined,
  rootBbox: { minX: number; minY: number; maxX: number; maxY: number } | undefined,
  tauMax: number,
  tauScale: number,
  tauExponent: number
): number {
  if (tauMax <= 0) return 0;

  // Fallback when layout info is unavailable — return full-scale τ so the
  // view starts with a single large cluster and progressively refines.
  if (!viewbox || !rootBbox) return tauMax * tauScale;

  const rootW = rootBbox.maxX - rootBbox.minX;
  const rootH = rootBbox.maxY - rootBbox.minY;
  if (rootW <= 0 || rootH <= 0) return tauMax * tauScale;

  const viewW = viewbox.maxX - viewbox.minX;
  const viewH = viewbox.maxY - viewbox.minY;

  // Viewport fraction: 1 = seeing entire dataset, 0 = extreme zoom-in.
  const viewportFraction = Math.max(0, Math.min(1, (viewW * viewH) / (rootW * rootH)));

  // Prevent degenerate exponent.
  const exp = Math.max(0.01, tauExponent);

  return Math.max(0, tauMax * tauScale * Math.pow(viewportFraction, exp));
}
