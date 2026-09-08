/**
 * semanticZoom/zoomCutBuilder.ts
 *
 * Hierarchical, footprint-driven zoom-cut builder.
 *
 * ## Algorithm
 * A node is split when either:
 *   (a) its screen-space footprint ≥ splitThresholdPx, i.e. there is enough
 *       screen real-estate to reveal sub-structure; OR
 *   (b) it overflows the viewport boundary — it is no longer fully contained,
 *       so the scorer would exclude it as a label candidate anyway, and we
 *       recurse into its children to find sub-clusters that are fully visible.
 * Both triggers cascade recursively, so there is no "dead zone" between a
 * parent going off-screen and its children becoming label candidates.
 *
 * ## Key properties
 * - Monotonic: zooming in (larger canvas pixel extent per data unit) strictly
 *   increases footprints, so previously split nodes stay split and more nodes
 *   may split.  This guarantees progressive-disclosure behaviour without tiers.
 * - Dataset-adaptive: deep hierarchies only split further when screen space
 *   supports it; shallow hierarchies converge quickly.
 * - No hard zoom-level thresholds or tier constants.
 */

import type * as d3 from "d3";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { bboxFullyInsideViewbox, bboxIntersectsViewbox, childGapPx, computeScreenFootprint } from "./footprint";
import type { SemanticZoomConfig, Viewbox } from "./types";

// Safety cap: limit total cluster-nodes examined (not loop iterations) so the
// guard scales naturally with dataset size while remaining O(n) in the worst
// case (degenerate chain trees).  50 000 examined nodes comfortably handles
// any real-world HDBSCAN hierarchy while preventing runaway loops.
const MAX_NODES_EXAMINED = 50_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a flat set of "representative" clusters for the current zoom.
 *
 * @param roots   Top-level clusters to start from (usually the HDBSCAN root,
 *                or its direct children if the root has no meaningful split).
 * @param viewbox Current data-space viewport (used to discard off-screen
 *                branches).  Pass `undefined` to consider all clusters.
 * @param xScale  Current D3 x-scale (data → pixels).
 * @param yScale  Current D3 y-scale (data → pixels).
 * @param config  Semantic zoom configuration (only `splitThresholdPx` used).
 * @returns Flat array of representative cluster nodes (mutually non-nested).
 */
export function buildZoomCut(
  roots: ClusterTreeNode[],
  viewbox: Viewbox | undefined,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  config: Pick<SemanticZoomConfig, "splitThresholdPx">
): ClusterTreeNode[] {
  // Filter roots to those that intersect the viewport.
  let frontier: ClusterTreeNode[] = viewbox
    ? roots.filter((n) => bboxIntersectsViewbox(n, viewbox))
    : roots.slice();

  if (frontier.length === 0) return [];

  let didSplit = true;
  let nodesExamined = 0;

  while (didSplit && nodesExamined < MAX_NODES_EXAMINED) {
    didSplit = false;
    nodesExamined += frontier.length;
    const next: ClusterTreeNode[] = [];

    for (const node of frontier) {
      const hasChildren = node.leftChild != null || node.rightChild != null;

      if (hasChildren) {
        const fp = computeScreenFootprint(node, xScale, yScale);

        // Two independent split triggers (OR):
        //  (a) footprint large enough to warrant revealing sub-structure
        //  (b) cluster overflows the viewport → scorer would discard it anyway;
        //      force recursion into children so fully-visible sub-clusters can
        //      become label candidates without waiting for the footprint gate.
        const overflowsViewport = viewbox !== undefined && !bboxFullyInsideViewbox(node, viewbox);
        if (fp.areaPx >= config.splitThresholdPx || overflowsViewport) {
          // Split: replace with viewport-intersecting children.
          let splitProduced = false;

          if (node.leftChild) {
            const visible = !viewbox || bboxIntersectsViewbox(node.leftChild, viewbox);
            if (visible) {
              next.push(node.leftChild);
              splitProduced = true;
            }
          }
          if (node.rightChild) {
            const visible = !viewbox || bboxIntersectsViewbox(node.rightChild, viewbox);
            if (visible) {
              next.push(node.rightChild);
              splitProduced = true;
            }
          }

          if (splitProduced) {
            didSplit = true;
            continue; // parent is replaced
          }
        }
      }

      next.push(node);
    }

    frontier = next;
  }

  return frontier;
}

// ---------------------------------------------------------------------------
// Convenience: single-root variant
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper when there is a single HDBSCAN root node.
 */
export function buildZoomCutFromRoot(
  root: ClusterTreeNode,
  viewbox: Viewbox | undefined,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  config: Pick<SemanticZoomConfig, "splitThresholdPx">
): ClusterTreeNode[] {
  return buildZoomCut([root], viewbox, xScale, yScale, config);
}

// ---------------------------------------------------------------------------
// Containment-cut strategy
// ---------------------------------------------------------------------------

/**
 * Build the **containment cut**: the set of largest cluster nodes that are
 * entirely contained within the current viewport.
 *
 * ## Algorithm (top-down, per node)
 *   1. If the node has no bbox, include it unconditionally (treated as a leaf).
 *   2. Skip the node if its bbox does not intersect the viewport at all.
 *   3. If the node's bbox is **fully inside** the viewport → activate it (done;
 *      do not recurse further into children).
 *   4. If the node **overflows** the viewport and has children → recurse into
 *      each child that intersects the viewport.
 *   5. If the node overflows and is a leaf (no children) → activate it anyway
 *      (single point partially in view is still assigned).
 *
 * ## Guarantee
 * Every visible data point belongs to exactly one returned node, so the buffer
 * of point-to-cluster assignments is always complete with no "-1" gaps.
 *
 * @param roots   Top-level nodes to start from (usually the HDBSCAN root, or
 *                its direct children in a multi-root setup).
 * @param viewbox Current data-space viewport.  Pass `undefined` to include the
 *                entire hierarchy (returns `[root]`).
 * @returns Flat, non-nested array of active cluster nodes.
 */
export function buildContainmentCut(
  roots: ClusterTreeNode[],
  viewbox: Viewbox | undefined
): ClusterTreeNode[] {
  const result: ClusterTreeNode[] = [];
  // Safety cap: prevents runaway on pathologically deep/wide trees.
  const MAX_EXAMINED = 100_000;
  let examined = 0;

  function traverse(node: ClusterTreeNode): void {
    if (examined++ >= MAX_EXAMINED) return;

    // No bbox → treat as a leaf-like node; include it unconditionally.
    if (!node.bbox) {
      result.push(node);
      return;
    }

    // Prune: entirely outside the viewport → nothing to do.
    if (viewbox && !bboxIntersectsViewbox(node, viewbox)) return;

    // Fully contained (or no viewport restriction) → this is the largest
    // cluster we can activate for this region; stop recursing.
    if (!viewbox || bboxFullyInsideViewbox(node, viewbox)) {
      result.push(node);
      return;
    }

    // Node overflows the viewport. Recurse into children if they exist.
    const hasChildren = node.leftChild != null || node.rightChild != null;
    if (!hasChildren) {
      // Leaf that is partially in view — include it so the point is assigned.
      result.push(node);
      return;
    }

    if (node.leftChild) traverse(node.leftChild);
    if (node.rightChild) traverse(node.rightChild);
  }

  for (const root of roots) traverse(root);
  return result;
}

/**
 * Convenience single-root wrapper for {@link buildContainmentCut}.
 */
export function buildContainmentCutFromRoot(
  root: ClusterTreeNode,
  viewbox: Viewbox | undefined
): ClusterTreeNode[] {
  return buildContainmentCut([root], viewbox);
}

// ---------------------------------------------------------------------------
// Hybrid cut strategy
// ---------------------------------------------------------------------------

/**
 * Options for the gap-disclosure split trigger (chain rescue, issue #258).
 * The trigger discloses a node's children when they are separated by visible
 * whitespace, even if the parent's footprint is below `splitThresholdPx` —
 * this is what lets small chain clusters enter the cut at coarse zoom.
 */
export interface GapDisclosureOptions {
  /**
   * Screen-px separation between a node's projected child bboxes at/above
   * which the node splits.  `0` disables the trigger entirely (a plain
   * `gap >= 0` comparison would always fire).
   */
  gapDisclosurePx: number;
  /**
   * Only `true` while a selection / DoI focus is active.  With no focus the
   * trigger must be inert so the classic footprint-only disclosure (and its
   * google-maps coarsening) is byte-identical to today.
   */
  active: boolean;
}

/**
 * Build the **hybrid cut**: the set of cluster nodes that are both small
 * enough to be worth annotating individually and not overflowing the viewport.
 *
 * ## Split triggers (any is sufficient to recurse into children)
 *   (a) **Viewport overflow** — the node's bbox is not fully inside the
 *       current viewbox.  Recursing ensures that both siblings of an
 *       overflowing parent simultaneously enter the cut and compete fairly,
 *       rather than the parent being silently excluded or silently kept.
 *   (b) **Footprint threshold** — the node's projected screen area ≥
 *       `splitThresholdPx`.  This fires *proactively*, before the node ever
 *       overflows the viewport, so sub-structure is disclosed as soon as
 *       there is enough screen real-estate to render it meaningfully.
 *       This is what prevents the "stuck on root forever" behaviour of the
 *       pure containment cut.
 *   (c) **Gap disclosure** (optional, selection-gated) — the node's children
 *       are separated by ≥ `gapDisclosurePx` of screen whitespace and the node
 *       has ≥ 3 members.  Splits small chain clusters out of a sub-threshold
 *       parent so they can be rescued by the saliency scorer; compact clusters
 *       (children overlap, gap = 0) never shred.  Monotone in zoom like (b):
 *       the screen gap shrinks when zooming out, re-merging the children.
 *       The size guard skips pairs of singletons (a singleton can never be
 *       rescued) without hiding a real cluster behind an attached noise point.
 *
 * ## Stopping conditions (node is included as-is)
 *   - Node is a leaf (no children).
 *   - Node has no bbox (treated as leaf).
 *   - Node's footprint < `splitThresholdPx` AND it is fully inside the viewport.
 *
 * ## Relation to the other builders
 * - `buildZoomCut`: iterative frontier loop, same two triggers, but filters
 *   out overflowing nodes entirely before handing to `scoreCandidates`.
 *   The hybrid builder keeps overflowing leaves so every point is covered.
 * - `buildContainmentCut`: overflow trigger only, no proactive footprint split.
 *   The hybrid builder adds (b) to prevent the "stuck on root" failure.
 *
 * ## Full-coverage guarantee
 * Like `buildContainmentCut`, every point that intersects the viewport belongs
 * to exactly one node in the result — the labels buffer has no "-1" gaps.
 * Overflowing leaf nodes (partially visible points) are included explicitly.
 *
 * @param roots            Top-level nodes to start from.
 * @param viewbox          Current data-space viewport.
 * @param xScale           D3 x-scale (data → canvas pixels).
 * @param yScale           D3 y-scale (data → canvas pixels).
 * @param splitThresholdPx Pixel² area above which a node is split proactively.
 * @param gapDisclosure    Optional gap-disclosure trigger (c); omitted = off.
 * @returns Flat, non-nested array of cluster nodes covering all visible points.
 */
export function buildHybridCut(
  roots: ClusterTreeNode[],
  viewbox: Viewbox | undefined,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  splitThresholdPx: number,
  gapDisclosure?: GapDisclosureOptions
): ClusterTreeNode[] {
  const result: ClusterTreeNode[] = [];
  const MAX_EXAMINED = 100_000;
  let examined = 0;

  const gapActive =
    gapDisclosure !== undefined &&
    gapDisclosure.active &&
    gapDisclosure.gapDisclosurePx > 0;

  function traverse(node: ClusterTreeNode): void {
    if (examined++ >= MAX_EXAMINED) return;

    // No bbox → treat as a leaf; include unconditionally.
    if (!node.bbox) {
      result.push(node);
      return;
    }

    // Prune branch entirely off-screen.
    if (viewbox && !bboxIntersectsViewbox(node, viewbox)) return;

    const hasChildren = node.leftChild != null || node.rightChild != null;

    if (hasChildren) {
      const overflows = viewbox !== undefined && !bboxFullyInsideViewbox(node, viewbox);
      const fp = computeScreenFootprint(node, xScale, yScale);
      const tooLarge = fp.areaPx >= splitThresholdPx;
      const gapSplit =
        gapActive &&
        node.size >= 3 &&
        childGapPx(node, xScale, yScale) >= gapDisclosure!.gapDisclosurePx;

      if (overflows || tooLarge || gapSplit) {
        // Split: recurse into viewport-intersecting children.
        let anySplit = false;
        if (node.leftChild && (!viewbox || bboxIntersectsViewbox(node.leftChild, viewbox))) {
          traverse(node.leftChild);
          anySplit = true;
        }
        if (node.rightChild && (!viewbox || bboxIntersectsViewbox(node.rightChild, viewbox))) {
          traverse(node.rightChild);
          anySplit = true;
        }
        if (anySplit) return; // parent replaced by children
      }
    }

    // Keep this node: it is a leaf, has no children that intersect the
    // viewport, is below the footprint threshold, and is either fully inside
    // or partially overlapping (edge leaf — still assigned for coverage).
    result.push(node);
  }

  for (const root of roots) traverse(root);
  return result;
}

/**
 * Convenience single-root wrapper for {@link buildHybridCut}.
 */
export function buildHybridCutFromRoot(
  root: ClusterTreeNode,
  viewbox: Viewbox | undefined,
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  splitThresholdPx: number,
  gapDisclosure?: GapDisclosureOptions
): ClusterTreeNode[] {
  return buildHybridCut([root], viewbox, xScale, yScale, splitThresholdPx, gapDisclosure);
}
