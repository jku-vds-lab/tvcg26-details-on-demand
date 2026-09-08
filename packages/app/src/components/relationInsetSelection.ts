import type { ClusterItem } from "src/hooks/reconcileClusterItems";

/** Result of the relation-inset budget selection, split by anchoring style. */
export interface RelationInsetSelectionResult {
  /** Kept floating (set↔set) insets, in their original relative order. */
  floating: ClusterItem[];
  /** Kept on-spline (singleton↔singleton) insets, in their original relative order. */
  onSpline: ClusterItem[];
}

/** Combined relation score — equals ConsolidatedRelation.score by construction. */
function relationScore(item: ClusterItem): number {
  const a = item.element.relationAnchors;
  return a ? a.forwardScore + a.backwardScore : 0;
}

/**
 * Selects the relation (diff) insets to display under the shared diff budget
 * (issue #261 part 3: on-spline insets count against the budget too — the
 * budget is a cap on ALL diff insets, not just floating ones).
 *
 * - When `hoveredUid` is non-null: shows all resolvable floating insets that
 *   involve the hovered cluster uid (uncapped — hover is an explicit "show me
 *   everything here" gesture); on-spline insets are returned unfiltered, as
 *   before.
 * - When `hoveredUid` is null: merges both lists, keeps the top `budget`
 *   items by combined relation score (element-id tie-break), and re-splits
 *   them preserving each input list's relative order.
 *
 * `floating` should already be filtered to resolvable, non-onSpline items;
 * both inputs arrive score-sorted from consolidateRelations.
 */
export function selectVisibleRelationInsets(
  floating: ClusterItem[],
  onSpline: ClusterItem[],
  hoveredUid: string | null,
  budget: number,
): RelationInsetSelectionResult {
  if (hoveredUid !== null) {
    return {
      floating: floating.filter(({ element }) => {
        const a = element.relationAnchors;
        return a?.uidA === hoveredUid || a?.uidB === hoveredUid;
      }),
      onSpline,
    };
  }

  const merged = [
    ...floating.map((item) => ({ item, onSpline: false })),
    ...onSpline.map((item) => ({ item, onSpline: true })),
  ].sort((a, b) => {
    const d = relationScore(b.item) - relationScore(a.item);
    return d !== 0 ? d : a.item.element.id < b.item.element.id ? -1 : 1;
  });

  const kept = new Set(
    merged.slice(0, Math.max(0, budget)).map(({ item }) => item)
  );
  return {
    floating: floating.filter((item) => kept.has(item)),
    onSpline: onSpline.filter((item) => kept.has(item)),
  };
}
