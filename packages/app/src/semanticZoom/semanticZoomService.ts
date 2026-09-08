/**
 * semanticZoom/semanticZoomService.ts
 *
 * Main entry point for the semantic-zoom cluster activation pipeline.
 *
 * This service is owned by `ClusteringService` (one instance per group:
 * "annotation" / "inset").  It is stateful:
 * - The `HysteresisManager` remembers which clusters were active last frame.
 * - A signature cache avoids redundant recomputation when nothing has changed.
 *
 * ## Calling convention
 * Call `computeActiveClusterIds(...)` on every zoom/pan frame.  The method
 * is idempotent for identical inputs (same sig → same output from cache).
 *
 * Call `reset()` after a full recluster so stale hysteresis state is cleared.
 */

import type * as d3 from "d3";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { bboxFullyInsideViewbox, computeScreenFootprint, viewportAreaPx } from "./footprint";
import { HysteresisManager } from "./hysteresis";
import { computeDoiNonUniform, scoreCandidates } from "./saliencyScorer";
import type {
  ScoredCandidate,
  SemanticZoomConfig,
  SemanticZoomResult,
  Viewbox,
} from "./types";
import { buildHybridCutFromRoot } from "./zoomCutBuilder";

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

function quantize(v: number, precision = 1e2): number {
  return Math.round(v * precision) / precision;
}

function makeSignature(
  viewbox: Viewbox | undefined,
  canvasW: number,
  canvasH: number,
  budget: number,
  config: SemanticZoomConfig,
  hierarchyRev: number | string,
  selectionActive: boolean
): string {
  const vb = viewbox
    ? `${quantize(viewbox.minX)},${quantize(viewbox.minY)},${quantize(viewbox.maxX)},${quantize(viewbox.maxY)}`
    : "∅";

  return [
    `vb=${vb}`,
    `cw=${canvasW}`,
    `ch=${canvasH}`,
    `budget=${budget}`,
    `split=${config.splitThresholdPx}`,
    `lmin=${config.labelMinFraction}`,
    `sw=${config.stabilityWeight}`,
    `dw=${config.doiMassWeight}`,
    `fw=${config.footprintWeight}`,
    `ddw=${config.doiDensityWeight}`,
    `cdt=${config.chainDoiThreshold}`,
    `gap=${config.gapDisclosurePx}`,
    `crb=${config.chainRescueBudget}`,
    `sel=${selectionActive ? 1 : 0}`,
    `haf=${config.hysteresisActivateFactor}`,
    `hdf=${config.hysteresisDeactivateFactor}`,
    `hrev=${hierarchyRev}`,
  ].join("|");
}

// ---------------------------------------------------------------------------
// SemanticZoomService
// ---------------------------------------------------------------------------

export class SemanticZoomService {
  private hysteresis = new HysteresisManager();
  /**
   * Separate hysteresis state for the reserved chain-rescue slot pool
   * (`chainRescueBudget`): rescued fragments compete only among themselves,
   * with the same flicker suppression as the main pool.
   */
  private rescueHysteresis = new HysteresisManager();
  private lastSig: string | undefined;
  private lastResult: SemanticZoomResult | undefined;
  /** Dev-only: identifies this instance ("points"/"midpoints") in the
   *  `__semanticZoomLast` debug dump so headless harnesses can tell the two
   *  clustering services' scoring passes apart. No runtime behavior. */
  public debugTag: string | undefined;

  // ---------------------------------------------------------------------------
  // Main API
  // ---------------------------------------------------------------------------

  /**
   * Compute the set of active (annotated) cluster nodes for the current frame.
   *
   * @param root            HDBSCAN hierarchy root.
   * @param viewbox         Data-space viewport.
   * @param xScale          Current D3 x-scale (data → pixels).
   * @param yScale          Current D3 y-scale (data → pixels).
   * @param canvasWidthPx   Canvas width in pixels (for area normalisation).
   * @param canvasHeightPx  Canvas height in pixels (for area normalisation).
   * @param membersOf       Function returning member indices for a cluster node.
   * @param nodes           DataPoint array for the current group.
   * @param budget          Maximum active cluster count (maxActiveClusters) —
   *                        a true total cap; chain-rescue slots are reserved
   *                        from within it (see step 3 below).
   * @param config          Full semantic zoom configuration.
   * @param hierarchyRev    Monotonically increasing counter; bump on recluster
   *                        to invalidate the cache.
   * @param localWhitespace Optional local-whitespace probe for chain rescue
   *                        (forwarded to scoreCandidates).
   * @param selectionActive True when the hierarchy was built from a
   *                        DoI-filtered subset (a selection / focus is
   *                        active).  Enables gap disclosure in the cut and
   *                        rescue eligibility even under uniform DoI.
   * @param singletonThroughFlow Optional trajectory through-flow test for
   *                        singleton rescue (forwarded to scoreCandidates).
   * @returns SemanticZoomResult with active UIDs and ordered candidates.
   */
  computeActiveClusterIds(
    root: ClusterTreeNode,
    viewbox: Viewbox | undefined,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    canvasWidthPx: number,
    canvasHeightPx: number,
    membersOf: (node: ClusterTreeNode) => number[],
    nodes: DataPoint[],
    budget: number,
    config: SemanticZoomConfig,
    hierarchyRev: number,
    localWhitespace?: (node: ClusterTreeNode) => number,
    selectionActive = false,
    singletonThroughFlow?: (node: ClusterTreeNode) => boolean,
    /**
     * Server-cut mode (issue #315 S2b): the walk already happened
     * server-side; use these frontier nodes instead of walking `root`.
     * `rev` identifies the stashed cut (its request key) so the result
     * cache invalidates when a new cut lands under an identical viewbox.
     */
    precomputedCut?: { cut: ClusterTreeNode[]; rev: string },
    /**
     * O(1) DoI mass for contiguous-leaf-range candidates (issue #315): the
     * scoring pass runs per settled tick in server-cut mode, so the member
     * loop fallback would be O(points-in-viewport) per tick. Return null to
     * fall back per node.
     */
    doiMassOf?: (node: ClusterTreeNode) => number | null
  ): SemanticZoomResult {
    // Cache: skip work when nothing has changed.
    const sig = makeSignature(
      viewbox,
      canvasWidthPx,
      canvasHeightPx,
      budget,
      config,
      precomputedCut ? `${hierarchyRev}:${precomputedCut.rev}` : hierarchyRev,
      selectionActive
    );
    if (this.lastResult && this.lastSig === sig) {
      return this.lastResult;
    }

    // Rescue eligibility spans both regimes (see saliencyScorer header):
    // a DoI-filtered hierarchy (uniform-DoI full-bundle lasso) or a
    // non-uniform DoI distribution (decayed propagation).  Note the
    // DoI-derived half is not part of the cache signature — DoI changes
    // always rebuild the ClusteringService (fresh service, no stale cache),
    // matching the existing exposure for doiMass.
    const focusActive = selectionActive || computeDoiNonUniform(nodes);

    // 1. Build the hybrid cut.
    //
    //    A node is split when EITHER:
    //      (a) its screen-space footprint >= splitThresholdPx  [proactive]
    //      (b) its bbox overflows the current viewport          [reactive]
    //
    //    Trigger (a) restores the old behaviour of disclosing sub-structure
    //    before the parent escapes the screen, preventing the "stuck on root"
    //    regression.  Trigger (b) ensures both siblings of an overflowing
    //    parent simultaneously enter the cut so they can compete fairly.
    //
    //    Overflowing leaf nodes (partially visible single points) are kept in
    //    the cut so the labels buffer has complete coverage (no "-1" gaps).
    //
    //    While a selection focus is active, a third trigger (c) additionally
    //    splits nodes whose children are separated by ≥ gapDisclosurePx of
    //    screen whitespace, so small chain clusters enter the cut at coarse
    //    zoom (issue #258).
    const zoomCut = precomputedCut
      ? precomputedCut.cut
      : buildHybridCutFromRoot(root, viewbox, xScale, yScale, config.splitThresholdPx, {
          gapDisclosurePx: config.gapDisclosurePx,
          active: focusActive,
        });

    // 2. Score candidates with the full stability + DoI + footprint formula.
    //
    //    scoreCandidates filters to nodes that are fully inside the viewport
    //    (they are annotation-eligible) and ranks them by the weighted sum.
    //    Stability rewards long-lived HDBSCAN clusters; DoI rewards user-
    //    selected regions; footprint rewards screen-prominent ones.
    //    The full zoomCut (including partially-visible edge leaves) is still
    //    written to the labels buffer in ClusteringService for point coverage.
    const vpArea = viewportAreaPx(canvasWidthPx, canvasHeightPx);
    let scored: ScoredCandidate[] = scoreCandidates(
      zoomCut,
      membersOf,
      nodes,
      xScale,
      yScale,
      vpArea,
      viewbox,
      config,
      localWhitespace,
      focusActive,
      singletonThroughFlow,
      doiMassOf
    );

    // 2b. Fallback when scoreCandidates returns nothing.
    //
    //     This happens when every node in the zoom cut fails the minimum-area
    //     gate — typically at extreme zoom-in where the only remaining nodes
    //     are HDBSCAN leaves whose data-space bbox is a single point (areaPx≈0).
    //     Without a fallback the hysteresis manager receives an empty array,
    //     clears all active IDs, and the annotations vanish.
    //
    //     We build a replacement scored list from the zoom-cut nodes that are
    //     fully inside the viewport, ranked by HDBSCAN stability alone (no area
    //     term).  This keeps the closest available cluster outline visible and
    //     lets hysteresis smooth the transition rather than hard-cutting to zero.
    if (scored.length === 0 && zoomCut.length > 0) {
      const inView = viewbox
        ? zoomCut.filter((n) => bboxFullyInsideViewbox(n, viewbox))
        : zoomCut.slice();
      if (inView.length > 0) {
        const maxStab = Math.max(...inView.map((n) => n.stability), Number.EPSILON);
        scored = inView
          .map((n) => ({
            node: n,
            screenFootprint: computeScreenFootprint(n, xScale, yScale),
            doiMass: 0,
            doiDensity: 0,
            rescued: false,
            saliency: n.stability / maxStab,
          }))
          .sort((a, b) => {
            const d = b.saliency - a.saliency;
            return d !== 0 ? d : a.node.uid < b.node.uid ? -1 : 1;
          });
      }
    }

    // 3. Reserved chain-rescue slots, drawn from WITHIN the total budget
    //    (issue #261 part 3: `budget` = maxActiveClusters is a true total cap).
    //
    //    Rescued fragments score near 0 on every classic term, so in a
    //    saturated view they lose every main-budget slot and the fill step
    //    never reaches them.  Reserve-first: up to
    //    min(chainRescueBudget, #rescued, budget) slots go to rescued
    //    candidates competing only among themselves; the main pass gets the
    //    remainder.  The pools are disjoint (reserve winners are filtered out
    //    of the main pool), so |active| ≤ budget by construction, and unused
    //    reserve slots flow back to the main pool automatically.  With
    //    chainRescueBudget = 0 (or no rescued candidates) this is byte-identical
    //    to the classic single-pass budget.  Limit case: budget ≤ reserve
    //    demand ⇒ rescued fragments can displace every base cluster during a
    //    selection — intended "reserve displaces lowest base" semantics.
    const rescuedCandidates =
      config.chainRescueBudget > 0 ? scored.filter((c) => c.rescued) : [];
    const reserveN = Math.min(
      config.chainRescueBudget,
      rescuedCandidates.length,
      budget
    );
    let reserveActive: ScoredCandidate[] = [];
    if (reserveN > 0) {
      reserveActive = this.rescueHysteresis.update(
        rescuedCandidates,
        reserveN,
        config.hysteresisActivateFactor,
        config.hysteresisDeactivateFactor
      );
    } else {
      // Stale reserve state must not re-materialize later and yank main slots.
      this.rescueHysteresis.reset();
    }

    const reserveUids = new Set(reserveActive.map((c) => c.node.uid));
    const mainPool =
      reserveActive.length > 0
        ? scored.filter((c) => !reserveUids.has(c.node.uid))
        : scored;
    const mainActive = this.hysteresis.update(
      mainPool,
      budget - reserveActive.length,
      config.hysteresisActivateFactor,
      config.hysteresisDeactivateFactor
    );

    const active =
      reserveActive.length > 0
        ? [...mainActive, ...reserveActive].sort((a, b) => {
            const d = b.saliency - a.saliency;
            return d !== 0 ? d : a.node.uid < b.node.uid ? -1 : 1;
          })
        : mainActive;

    // Dev-only observability (issue #315): `window.__semanticZoomDebug = true`
    // records the last scoring pass so headless harnesses can inspect WHY a
    // candidate did or didn't activate. No cost when the flag is unset.
    if (typeof window !== "undefined" && (window as unknown as { __semanticZoomDebug?: boolean }).__semanticZoomDebug) {
      (window as unknown as Record<string, unknown>).__semanticZoomLast = {
        tag: this.debugTag,
        viewbox,
        cutSize: zoomCut.length,
        scored: scored.slice(0, 40).map((c) => ({
          uid: c.node.uid,
          size: c.node.size,
          stability: c.node.stability,
          saliency: c.saliency,
          doiMass: c.doiMass,
          areaPx: c.screenFootprint.areaPx,
          bbox: c.node.bbox,
        })),
        scoredTotal: scored.length,
        cutTopBySize: [...zoomCut]
          .sort((a, b) => b.size - a.size)
          .slice(0, 60)
          .map((n) => ({ uid: n.uid, size: n.size, bbox: n.bbox })),
        active: active.map((c) => c.node.uid),
      };
    }

    // 4. Build result.
    const result: SemanticZoomResult = {
      activeClusterIds: new Set(active.map((c) => c.node.uid)),
      activeCandidates: active,
      zoomCut,
    };

    this.lastSig = sig;
    this.lastResult = result;

    return result;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Reset hysteresis and cache after a full recluster.
   */
  reset(): void {
    this.hysteresis.reset();
    this.rescueHysteresis.reset();
    this.lastSig = undefined;
    this.lastResult = undefined;
  }
}
