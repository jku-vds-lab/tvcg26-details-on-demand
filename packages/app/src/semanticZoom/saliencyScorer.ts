/**
 * semanticZoom/saliencyScorer.ts
 *
 * Saliency scoring for cluster annotation candidates.
 *
 * ## Score formula
 * For each eligible candidate c, the saliency is:
 *
 *   saliency(c) = w_stability × stability_norm(c)
 *               + w_doiMass  × doiMass_norm(c)
 *               + w_footprint × footprint_norm(c)
 *
 * where each term is normalised to [0, 1] relative to the maximum value among
 * all eligible candidates in the current frame.
 *
 * ## Notes on stability
 * - HDBSCAN stability is not guaranteed to lie in [0, 1] in raw form;
 *   values can be arbitrarily large for long-lived clusters.
 * - We normalise per-frame against the max stability in the candidate set,
 *   making the score relative and dataset-agnostic.
 * - Stability is used only as a *ranking weight*, never as a hard exclusion
 *   filter, so leaf clusters remain eligible at extreme zoom-in levels.
 *
 * ## DoI mass
 * - Sum of all member DataPoint.DoI values.  If no DoI propagation has run
 *   (e.g., no selection), DoI defaults to a non-zero base value, so this
 *   term still participates in ranking.
 *
 * ## Chain rescue (two regimes)
 * Candidates that fail the min-area gate stay eligible iff rescue is active,
 * their density ≥ chainDoiThreshold, and their local neighborhood is mostly
 * whitespace (see RESCUE_WHITESPACE_MIN).  This lets small clusters that a
 * selected trajectory flows through (A→B→C→D with small B, C) activate —
 * and thereby produce the chain's diff insets.
 *
 * Singletons (1 member) additionally require trajectory through-flow
 * (`singletonThroughFlow` callback): the point's predecessor AND successor
 * on its trajectory both exist in the clustered subset.  A stark-transition
 * point between two clusters qualifies; lasso stragglers and trajectory
 * endpoints do not.  Without the callback, singletons are never rescued.
 *
 * Rescue is active in either regime:
 *  - **Uniform selection** (`rescueEligible` passed by the caller): a lasso
 *    covering the whole bundle gives every clustered point DoI = 1 — the
 *    clustering input is already DoI-filtered, so uniformity carries no
 *    signal here.  The caller derives the flag from "the hierarchy was built
 *    from a filtered subset" (see ClusteringService).  The density threshold
 *    passes trivially at DoI = 1; gap disclosure in the cut and the
 *    whitespace gate do the discriminating.
 *  - **Decayed propagation** (`computeDoiNonUniform` fallback): a partial
 *    selection whose propagation leaves a non-uniform DoI distribution.
 *
 * The saliency *score term*
 *
 *   + w_doiDensity × doiDensity(c)        with doiDensity = doiMass / size
 *
 * stays gated on non-uniformity alone: under uniform DoI it must contribute
 * exactly 0 (a rank-preserving constant would distort the hysteresis
 * manager's multiplicative border thresholds).  With no selection at all,
 * both regimes are off and scoring is byte-identical to the classic formula.
 */

import type * as d3 from "d3";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { bboxFullyInsideViewbox, computeScreenFootprint } from "./footprint";
import type { ScoredCandidate, SemanticZoomConfig, Viewbox } from "./types";

// ---------------------------------------------------------------------------
// DoI mass
// ---------------------------------------------------------------------------

/**
 * Compute the sum of `DataPoint.DoI` for all member points of a cluster.
 *
 * @param memberIndices Indices into the `nodes` array for this cluster.
 * @param nodes         Full array of DataPoint objects (filtered to the group).
 */
export function computeDoiMass(
  memberIndices: number[],
  nodes: DataPoint[]
): number {
  let sum = 0;
  for (const idx of memberIndices) {
    const doi = nodes[idx]?.DoI;
    if (doi !== undefined && isFinite(doi)) sum += doi;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Minimum local whitespace for a sub-min-area candidate to be chain-rescued.
 * Whitespace = memberCount / (memberCount + foreignCount) over the candidate's
 * inflated neighborhood: a tiny high-DoI cluster isolated in empty space
 * qualifies (≈1), the same cluster embedded in a dense point region does not
 * (≈0) — annotating it there would add clutter without telling a chain story.
 * Deliberately a constant, not a setting, until tuning demands otherwise.
 */
export const RESCUE_WHITESPACE_MIN = 0.5;

/** DoI spread below which the distribution counts as uniform (no selection). */
const DOI_UNIFORMITY_EPS = 1e-6;

/**
 * Returns true when member DoI values are non-uniform across `nodes`, i.e.
 * some selection/propagation has focused interest. Guards the chain-rescue
 * gate and the density score term: with uniform DoI (no selection, or the
 * select-all feature-search path) scoring must stay identical to the classic
 * three-term formula.
 */
export function computeDoiNonUniform(nodes: DataPoint[]): boolean {
  let min = Infinity;
  let max = -Infinity;
  // Columnar fast path (issue #315 D2): this full scan runs per cut-request
  // build in server-cut mode; the typed pass avoids per-element accessor
  // calls.
  const cols = columnsOf(nodes);
  if (cols) {
    const doi = cols.doi;
    for (let i = 0; i < cols.count; i++) {
      const v = doi[i];
      if (!isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min > DOI_UNIFORMITY_EPS;
  }
  for (const n of nodes) {
    const doi = n?.DoI;
    if (doi === undefined || !isFinite(doi)) continue;
    if (doi < min) min = doi;
    if (doi > max) max = doi;
  }
  return max - min > DOI_UNIFORMITY_EPS;
}

/**
 * Score and filter a zoom-cut candidate set.
 *
 * @param zoomCut         Flat array of representative cluster nodes (from buildZoomCut).
 * @param membersOf       Function returning member indices for a node.
 * @param nodes           DataPoint array for the current group.
 * @param xScale          Current D3 x-scale.
 * @param yScale          Current D3 y-scale.
 * @param viewportAreaPx  Total canvas area in pixels² (for footprint normalisation).
 * @param viewbox         Data-space viewport (to additionally filter out-of-view nodes).
 * @param config          Semantic zoom config (weights + labelMinFraction).
 * @param localWhitespace Optional callback returning the local whitespace
 *                        fraction [0, 1] around a node (see RESCUE_WHITESPACE_MIN).
 *                        Only consulted for chain-rescue candidates; when
 *                        omitted, sub-min-area candidates are never rescued.
 * @param rescueEligible  Optional caller-supplied rescue-eligibility flag
 *                        (selection focus OR non-uniform DoI — see the module
 *                        header).  When omitted, falls back to DoI
 *                        non-uniformity alone (the pre-gap-disclosure
 *                        behavior).
 * @param singletonThroughFlow Optional trajectory through-flow test for
 *                        1-member candidates (see module header).  When
 *                        omitted, singletons are never rescued.
 * @returns Array of ScoredCandidates sorted by saliency descending.
 *          Candidates pass the size gate via areaPx ≥ labelMinFraction × splitThresholdPx
 *          or via chain rescue (eligibility + density ≥ chainDoiThreshold + whitespace).
 */
export function scoreCandidates(
  zoomCut: ClusterTreeNode[],
  membersOf: (node: ClusterTreeNode) => number[],
  nodes: DataPoint[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  viewportAreaPx: number,
  viewbox: Viewbox | undefined,
  config: Pick<
    SemanticZoomConfig,
    | "stabilityWeight"
    | "doiMassWeight"
    | "footprintWeight"
    | "labelMinFraction"
    | "splitThresholdPx"
    | "doiDensityWeight"
    | "chainDoiThreshold"
  >,
  localWhitespace?: (node: ClusterTreeNode) => number,
  rescueEligible?: boolean,
  singletonThroughFlow?: (node: ClusterTreeNode) => boolean,
  /** O(1) doiMass for range candidates (issue #315) — null falls back to the
   * member loop per node. See SemanticZoomService.computeActiveClusterIds. */
  doiMassOf?: (node: ClusterTreeNode) => number | null
): ScoredCandidate[] {
  if (zoomCut.length === 0) return [];

  const doiNonUniform = computeDoiNonUniform(nodes);
  const gateActive = rescueEligible ?? doiNonUniform;

  // --- Step 1: compute raw metrics for all candidates ---------------------
  const raw = zoomCut.map((node) => {
    const fp = computeScreenFootprint(node, xScale, yScale);
    // Server-stamped candidate mass wins (issue #315 A3 / P-d, §6e), then the
    // O(1) leaf-order prefix, then the member loop — each an exact fallback of
    // the last, so an unstamped candidate scores byte-identically to before.
    const fastMass = node.doiMass ?? doiMassOf?.(node);
    let doiMass: number;
    let memberCount: number;
    if (fastMass != null) {
      doiMass = fastMass;
      memberCount = node.size;
    } else {
      const memberIdxs = membersOf(node);
      doiMass = computeDoiMass(memberIdxs, nodes);
      memberCount = memberIdxs.length;
    }
    const doiDensity = memberCount > 0 ? doiMass / memberCount : 0;
    return { node, fp, doiMass, memberCount, doiDensity };
  });

  // --- Step 2: filter by viewport intersection and minimum size ------------
  // A cluster is only eligible for annotation when it is *entirely* within
  // the viewport (the full cluster is visible).  Partially-visible clusters
  // are kept in the zoom-cut frontier for continued splitting but are not
  // labelled until the viewport zooms out enough to contain them fully.
  //
  // The minimum-area gate uses splitThresholdPx as the reference so the
  // threshold is always below the zoom-cut floor: every node in the cut has
  // fp < splitThresholdPx, and labelMinFraction × splitThresholdPx < splitThresholdPx
  // by construction.  Using viewportAreaPx as the reference fails on large
  // (4K+) displays where viewportAreaPx ≥ 1/labelMinFraction × splitThresholdPx,
  // causing every zoom-cut node to fail and producing 0 active clusters.
  // Chain rescue: a candidate below the min-area gate stays eligible when a
  // selection focus is active (see module header for the two regimes),
  // (nearly) all of its ≥ 2 members are interesting, and it sits in
  // mostly-empty space.  Union with the area gate is monotone: a rescued
  // cluster growing past the gate stays eligible.
  const minAreaPx = config.labelMinFraction * config.splitThresholdPx;
  const rescued = (d: (typeof raw)[number]): boolean => {
    if (!gateActive || localWhitespace === undefined) return false;
    if (d.memberCount < 1) return false;
    // Singletons need the extra through-flow evidence (stark transition on a
    // selected trajectory); without the callback they are never rescued.
    if (d.memberCount === 1 && !(singletonThroughFlow?.(d.node) ?? false)) return false;
    if (d.doiDensity < config.chainDoiThreshold) return false;
    return localWhitespace(d.node) >= RESCUE_WHITESPACE_MIN;
  };
  // Record HOW each survivor qualified: rescued candidates feed the reserved
  // slot pool (chainRescueBudget) downstream. Viewbox check first so the
  // whitespace probe never runs for out-of-view candidates.
  const eligible: Array<(typeof raw)[number] & { wasRescued: boolean }> = [];
  for (const d of raw) {
    if (viewbox && !bboxFullyInsideViewbox(d.node, viewbox)) continue;
    const passesArea = d.fp.areaPx >= minAreaPx;
    if (!passesArea && !rescued(d)) continue;
    eligible.push({ ...d, wasRescued: !passesArea });
  }

  if (eligible.length === 0) return [];

  // --- Step 3: compute normalisation denominators -------------------------
  const maxStability = Math.max(
    ...eligible.map((d) => d.node.stability),
    Number.EPSILON
  );
  const maxDoiMass = Math.max(
    ...eligible.map((d) => d.doiMass),
    Number.EPSILON
  );
  const refArea = Math.max(viewportAreaPx, Number.EPSILON);

  // --- Step 4: compute saliency scores ------------------------------------
  const scored: ScoredCandidate[] = eligible.map(
    ({ node, fp, doiMass, doiDensity, wasRescued }) => {
      const normStability = node.stability / maxStability;
      const normDoi = doiMass / maxDoiMass;
      const normFp = Math.min(1, fp.areaPx / refArea);

      // Density term is absolute (DoI ∈ [0,1] by construction) and gated on a
      // non-uniform DoI distribution — deliberately NOT on the wider rescue
      // eligibility: with uniform DoI it must contribute exactly 0 (not a
      // rank-preserving constant, which would distort the hysteresis
      // manager's multiplicative border thresholds).
      const saliency =
        config.stabilityWeight * normStability +
        config.doiMassWeight * normDoi +
        config.footprintWeight * normFp +
        config.doiDensityWeight * (doiNonUniform ? doiDensity : 0);

      return { node, screenFootprint: fp, doiMass, doiDensity, rescued: wasRescued, saliency };
    }
  );

  // --- Step 5: sort by saliency descending (deterministic tie-break by uid)
  scored.sort((a, b) => {
    const diff = b.saliency - a.saliency;
    if (diff !== 0) return diff;
    // Tie-break by uid string for determinism.
    return a.node.uid < b.node.uid ? -1 : a.node.uid > b.node.uid ? 1 : 0;
  });

  return scored;
}
