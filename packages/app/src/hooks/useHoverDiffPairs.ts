import { useMemo } from "react";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import type { VisualElement } from "src/models/VisualElement";

export interface HoverDiffPair {
  bUid: string;
  /** VisualElement for cluster A (hovered). Used by presentational components for position lookup. */
  aEl: VisualElement;
  /** VisualElement for cluster B. */
  bEl: VisualElement;
}

/**
 * Returns the set of synthetic diff pairs for the hovered cluster:
 * every OTHER active cluster that has NO existing trajectory relation to the hovered uid.
 *
 * Deliberately lightweight — does NOT render content here. Each pair becomes one
 * HoverDiffInsetItem child component whose useMemo([aEl, bEl]) runs renderGroupEdgeInset
 * once at mount time.
 *
 * Memoized on [hoveredUid, nodeElementMap, coveredKey] — NOT on layout positions —
 * so the pair list only changes when hover or the visible relation set changes.
 */
export function useHoverDiffPairs(
  hoveredUid: string | null,
  nodeElementMap: Map<string, VisualElement>,
  existingFloating: ClusterItem[],
): HoverDiffPair[] {
  // Stable string representing which cluster pairs are already covered by the main pipeline.
  const coveredKey = useMemo(() => {
    const keys: string[] = [];
    for (const { element } of existingFloating) {
      const a = element.relationAnchors;
      if (a) keys.push(`${a.uidA}:${a.uidB}`);
    }
    return keys.sort().join("|");
  }, [existingFloating]);

  return useMemo((): HoverDiffPair[] => {
    if (!hoveredUid) return [];
    const aEl = nodeElementMap.get(hoveredUid);
    if (!aEl) return [];

    const coveredSet = new Set(coveredKey.split("|").filter(Boolean));

    const pairs: HoverDiffPair[] = [];
    for (const [bUid, bEl] of nodeElementMap) {
      if (bUid === hoveredUid) continue;
      const key1 = `${hoveredUid}:${bUid}`;
      const key2 = `${bUid}:${hoveredUid}`;
      if (coveredSet.has(key1) || coveredSet.has(key2)) continue;
      pairs.push({ bUid, aEl, bEl });
    }
    return pairs;
  }, [hoveredUid, nodeElementMap, coveredKey]);
}
