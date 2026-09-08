/**
 * semanticZoom/tauCutBuilder.ts
 *
 * ============================================================================
 * DESIGN NOTE
 * ============================================================================
 *
 * ## Artifact used
 * We use the HDBSCAN condensed/linkage binary tree directly — no separate MST
 * storage is needed.  Each internal node stores `node.distance`, the
 * connectivity scale at which its two sub-trees merged (analogous to a
 * mutual-reachability MST edge weight).  Smaller `distance` ↔ tighter /
 * more-connected; larger `distance` ↔ looser / needs more scale to connect.
 * Leaf nodes represent individual data points (distance = 0).
 *
 * ## Active clusters at threshold τ (formal definition)
 * For a chosen τ, the τ-cut partition is:
 *
 *   A node n is in the τ-cut iff:
 *     (a) n is a leaf (single point), OR
 *     (b) n.distance ≤ τ  (entire sub-tree is connected at scale ≤ τ)
 *   AND its parent (if any) has distance > τ (the parent merge at scale
 *   > τ has not been "taken", so n is the finest-resolution component).
 *
 * Equivalently — traverse top-down from the root:
 *   - If node.distance ≤ τ (or leaf), emit this node as one component.
 *   - Otherwise recurse into both children.
 *
 * This is a pure horizontal cut, independent of tree balance.  Chain-like
 * refinements [N, N-1, N-2, …] produce correct singleton components at
 * small τ without any special-casing.
 *
 * ## Viewport restriction — Option A (local-in-view connectivity)
 * Only nodes (components) whose data-space bounding box intersects the
 * current viewport V_view are returned.  Components entirely outside V_view
 * are skipped.
 *
 * This is equivalent to Option A: "consider only edges whose endpoints are
 * both in V_view".  If the only path connecting two points goes through a
 * region outside the viewport, those points appear as separate components in
 * the returned set — which is the intended behaviour for viewport-local labels.
 *
 * Implementation note: bbox pruning is applied only when we reach a cut node
 * (emit point), not during downward traversal.  This guarantees that a
 * viewport-intersecting leaf deep inside a chain is never accidentally
 * discarded because an ancestor's bbox was evaluated before the chain was
 * fully descended.
 *
 * ## Coverage completeness
 * Every point in V_view belongs to exactly one returned component:
 *   • The binary tree partitions all points; the τ-cut traversal visits every
 *     leaf exactly once.
 *   • Viewport filtering discards only components fully outside V_view; their
 *     member points are geometrically invisible.
 *   • A point inside V_view whose entire cluster is inside V_view will always
 *     be included because the cluster's bbox (tight union of member coords)
 *     must intersect the viewport.
 *
 * ## Fixing the chain/imbalance problem
 * The previous footprint-driven `buildZoomCut` traversed the tree top-down
 * using pixel area to decide splits.  On imbalanced HDBSCAN trees (common for
 * fine zoom: [N, N-1] chains) the footprint of the "big" side barely changes
 * per split step, so the algorithm terminates too early — individual points
 * never become active.
 *
 * The τ-cut has no such failure mode: it cuts at a fixed scale regardless of
 * tree shape.  At sufficiently small τ every connected component naturally
 * becomes a singleton.
 *
 * ## Two-stage pipeline (partition first, label later)
 * This module provides Stage 1 of the semantic-zoom pipeline:
 *
 *   Stage 1 — PARTITION (this file)
 *     buildTauCut     → partitionUnits[]  (full flat partition, no filtering)
 *     buildAssignment → Map<pointIdx, uid> (per-point membership lookup)
 *
 *   Stage 2 — LABEL SELECTION (saliencyScorer + hysteresis)
 *     scoreCandidates + HysteresisManager → labeledUnits[] (annotation subset)
 *
 * Invariant: labeledUnits ⊆ partitionUnits.  Every partition unit exists
 * regardless of whether it is selected for annotation.  Point-to-unit
 * assignment is always derived from `partitionUnits`, never from `labeledUnits`.
 * SemanticZoomService orchestrates both stages; ClusteringService writes
 * per-point labels from `partitionUnits` and returns `activeCandidates` for
 * annotation rendering.
 * ============================================================================
 */

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { bboxIntersectsViewbox } from "./footprint";
import type { Viewbox } from "./types";

// ---------------------------------------------------------------------------
// Public API: τ-cut
// ---------------------------------------------------------------------------

/**
 * Build the flat set of active clusters defined by a horizontal cut at τ
 * through the HDBSCAN condensed tree, restricted to the current viewport.
 *
 * @param root    Root of the HDBSCAN hierarchy tree.
 * @param tau     Connectivity threshold in the same units as `node.distance`.
 *                τ = 0           → singletons (every point is its own cluster).
 *                τ ≥ root.distance → single component (entire dataset merged).
 * @param viewbox Data-space viewport for Option-A local-in-view restriction.
 *                Pass `undefined` to include all components (global cut).
 * @returns Flat array of ClusterTreeNode, each representing one active
 *          component.  The array never contains nested/ancestor duplicates.
 */
export function buildTauCut(
  root: ClusterTreeNode,
  tau: number,
  viewbox: Viewbox | undefined
): ClusterTreeNode[] {
  const result: ClusterTreeNode[] = [];

  function traverse(node: ClusterTreeNode): void {
    const isLeaf = node.leftChild == null && node.rightChild == null;

    if (isLeaf || node.distance <= tau) {
      // This node (and its entire sub-tree) is one component at scale τ.
      // Include it only if it intersects the viewport.
      const inView = !viewbox || !node.bbox || bboxIntersectsViewbox(node, viewbox);
      if (inView) {
        result.push(node);
      }
      return;
    }

    // node.distance > τ: this merge has not been "taken" yet — recurse.
    if (node.leftChild) traverse(node.leftChild);
    if (node.rightChild) traverse(node.rightChild);
  }

  traverse(root);
  return result;
}

// ---------------------------------------------------------------------------
// Public API: point → partition-unit assignment (two-stage pipeline helper)
// ---------------------------------------------------------------------------

/**
 * Build a point-index → partition-unit UID mapping from a τ-cut result.
 *
 * ## Two-stage pipeline context
 * `buildAssignment` is the bridge between Stage 1 (partition) and downstream
 * consumers that need per-point unit membership (e.g., ClusteringService's
 * label-writing buffer):
 *
 *   Stage 1: `buildTauCut`     → `partitionUnits` (every visible point covered)
 *   Helper:  `buildAssignment` → `assignment`      (point → unit lookup)
 *   Stage 2: `scoreCandidates` → `labeledUnits`    (annotation subset)
 *
 * The point-to-unit assignment must always be built from `partitionUnits`,
 * never from `labeledUnits`.  Using `labeledUnits` would leave points in
 * unlabeled units with no unit membership, causing "unassigned point" artefacts.
 *
 * ## Invariants
 * - Every point index returned by `membersOf(unit)` for any unit in
 *   `partitionUnits` appears exactly once (the partition is non-overlapping).
 * - If the HDBSCAN tree is a correct binary partition of all data points,
 *   every data-point index is covered.
 *
 * @param partitionUnits  Stage-1 result from `buildTauCut`.
 * @param membersOf       Maps a cluster node → array of point indices in that subtree.
 * @returns `Map<pointIndex, unitUid>` covering every point in the partition.
 */
export function buildAssignment(
  partitionUnits: ClusterTreeNode[],
  membersOf: (node: ClusterTreeNode) => number[]
): Map<number, string> {
  const assignment = new Map<number, string>();
  for (const unit of partitionUnits) {
    for (const idx of membersOf(unit)) {
      assignment.set(idx, unit.uid);
    }
  }
  return assignment;
}


/**
 * Returns the data-derived [minTau, maxTau] range for the given hierarchy.
 *
 * - minTau: smallest non-zero merge distance (leaf-adjacent merges).
 * - maxTau: root.distance (scale at which the entire dataset is one cluster).
 *
 * These values are in the same units as the HDBSCAN merge scale (dataset-
 * specific, not normalised to [0, 1]).  Use them to set UI slider bounds and
 * to interpret τ semantically.
 *
 * Called once per hierarchy (after computeClustering / rehydrateHierarchy)
 * and cached by the caller.
 */
export function tauRange(root: ClusterTreeNode): { minTau: number; maxTau: number } {
  let min = Infinity;

  function traverse(node: ClusterTreeNode): void {
    if (node.distance > 0) min = Math.min(min, node.distance);
    if (node.leftChild) traverse(node.leftChild);
    if (node.rightChild) traverse(node.rightChild);
  }

  traverse(root);

  return {
    minTau: Number.isFinite(min) ? min : 0,
    maxTau: root.distance,
  };
}
