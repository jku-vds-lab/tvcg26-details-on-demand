/**
 * semanticZoom/types.ts
 *
 * Shared data types for the semantic-zoom cluster activation pipeline.
 *
 * Pipeline overview (per zoom/pan frame):
 *  1. buildZoomCut      → representative ClusterTreeNode set for this zoom
 *  2. scoreCandidates   → ScoredCandidate[] (filtered + ranked)
 *  3. HysteresisManager → final active ScoredCandidate[] (with flicker suppression)
 */

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * All tunable parameters for the semantic-zoom pipeline.
 * Stored as part of the Redux `clusterSettings` slice so sliders can
 * trigger recomputation automatically.
 */
export interface SemanticZoomConfig {
  /**
   * Pixel² area above which a cluster's bounding box is large enough
   * to justify splitting into its children in the hierarchy cut.
   * Higher values → coarser zoom cut (fewer, bigger clusters shown).
   * @default 34500
   */
  splitThresholdPx: number;

  /**
   * Minimum size a cluster must have, expressed as a fraction of
   * `splitThresholdPx`, to be eligible for annotation.  Using
   * `splitThresholdPx` as the reference (rather than viewport area) makes
   * the threshold display-size–agnostic: on both small and very large (4K+)
   * displays the eligible range is always a consistent slice of the zoom-cut
   * floor, so the filter never accidentally excludes every candidate.
   *
   * e.g. 0.1 means a cluster must cover at least 10% of `splitThresholdPx`
   * in screen pixels to be labelled.
   * @default 0.1
   */
  labelMinFraction: number;

  /**
   * Weight for the HDBSCAN stability/persistence term in the saliency score.
   * Stability is normalized to [0, 1] relative to the max in the candidate set.
   * @default 0.3
   */
  stabilityWeight: number;

  /**
   * Weight for the DoI mass term (sum of point interests in the cluster).
   * Normalized to [0, 1] relative to the max among candidates.
   * @default 0.5
   */
  doiMassWeight: number;

  /**
   * Weight for the screen-space footprint term.
   * Footprint is clamped to [0, 1] relative to the current viewport area.
   * @default 0.2
   */
  footprintWeight: number;

  /**
   * Weight for the DoI *density* term (mean member DoI, i.e. doiMass / size).
   * Unlike the other terms this one is absolute (DoI is bounded in [0, 1] by
   * construction), NOT normalized against the per-frame max — normalization
   * would let a single tiny density-1.0 cluster squash the term for everyone.
   * Drives "chain rescue": small clusters whose members are (nearly) all on a
   * selected trajectory can outrank larger background clusters.
   * The term (and the rescue eligibility bypass, see `chainDoiThreshold`) is
   * only applied when the DoI distribution is non-uniform; with no selection
   * every point has DoI = 1 and scoring is identical to the classic formula.
   * @default 0.4
   */
  doiDensityWeight: number;

  /**
   * Minimum DoI density (mean member DoI) for a cluster that fails the
   * min-area gate to remain eligible for annotation anyway ("chain rescue").
   * Mirrors the default of `insetDoiThreshold` so rescued clusters also
   * classify as inset-active in the downstream DoI split.
   * @default 0.9
   */
  chainDoiThreshold: number;

  /**
   * Screen-px separation between a node's projected child bboxes at/above
   * which the node splits in the zoom cut even when its footprint is below
   * `splitThresholdPx` ("gap disclosure").  This is what lets small chain
   * clusters (A→B→C→D with tiny B, C) enter the cut at coarse zoom so the
   * chain-rescue gate can activate them.  Only applied while a selection /
   * DoI focus is active (hierarchy built from a DoI-filtered subset, or
   * non-uniform DoI): with no selection the cut is byte-identical to the
   * classic footprint-only disclosure.  `0` disables the trigger.
   * Zoom-adaptive like the footprint trigger: zooming out shrinks the screen
   * gap below the threshold and the children re-merge into their parent.
   * @default 48
   */
  gapDisclosurePx: number;

  /**
   * Extra active-cluster slots reserved for chain-rescued fragments, ON TOP
   * of `maxActiveClusters`.  Rescued fragments score near 0 on all classic
   * saliency terms (and the density boost is exactly 0 under uniform DoI),
   * so in saturated views they lose every main-budget slot to bigger
   * clusters; the reserve pool guarantees the chain story stays visible.
   * The main budget pass is untouched — `0` disables the reserve and is
   * byte-identical to the previous behavior (fragments then activate only
   * via main-pool budget-fill when there is headroom).
   * @default 4
   */
  chainRescueBudget: number;

  /**
   * Hysteresis: a new cluster activates only when its saliency exceeds
   *   activationThreshold = borderSaliency × hysteresisActivateFactor
   * where `borderSaliency` is the score of the K-th ranked candidate.
   * Must be ≥ 1.0 (typically 1.05–1.20).
   * @default 1.1
   */
  hysteresisActivateFactor: number;

  /**
   * Hysteresis: an active cluster deactivates when its saliency drops below
   *   deactivationThreshold = borderSaliency × hysteresisDeactivateFactor
   * Must be < hysteresisActivateFactor (typically 0.75–0.95).
   * @default 0.85
   */
  hysteresisDeactivateFactor: number;
}

// ---------------------------------------------------------------------------
// Intermediate results
// ---------------------------------------------------------------------------

/**
 * Screen-space bounding box and area for a cluster node.
 * Computed by projecting the data-space bbox through the current D3 scales.
 */
export interface ScreenFootprint {
  /** Area in pixels² (width × height of projected bbox). */
  areaPx: number;
  /** Left edge in canvas pixels. */
  x0: number;
  /** Top edge in canvas pixels. */
  y0: number;
  /** Right edge in canvas pixels. */
  x1: number;
  /** Bottom edge in canvas pixels. */
  y1: number;
}

/**
 * A cluster node together with its computed metrics for a particular frame.
 */
export interface ScoredCandidate {
  /** The HDBSCAN cluster tree node. */
  node: ClusterTreeNode;
  /** Screen-space footprint for this frame. */
  screenFootprint: ScreenFootprint;
  /** Sum of `DoI` for all member data points (unnormalized). */
  doiMass: number;
  /** Mean member DoI (doiMass / member count), in [0, 1]. */
  doiDensity: number;
  /**
   * True when the candidate passed eligibility via the chain-rescue bypass
   * (it failed the min-area gate).  Drives the reserved-slot pool
   * (`chainRescueBudget`); area-gate candidates are always false.
   */
  rescued: boolean;
  /**
   * Final saliency score in [0, 1] (or slightly above due to weighting rounding).
   * Higher is more salient / should be annotated first.
   */
  saliency: number;
}

/**
 * Final output of the semantic-zoom pipeline for one group.
 */
export interface SemanticZoomResult {
  /** UIDs of currently active (annotated) clusters. */
  activeClusterIds: Set<string>;
  /** Ordered list of active candidates (highest saliency first). */
  activeCandidates: ScoredCandidate[];
  /** All clusters in the zoom cut (before label-eligibility filtering). */
  zoomCut: ClusterTreeNode[];
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export interface Viewbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
