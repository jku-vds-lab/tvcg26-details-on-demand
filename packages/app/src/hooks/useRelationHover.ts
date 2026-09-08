import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";

/**
 * D2 diff-inset hover state: tracks the hovered relation item and the two
 * endpoint cluster uids (spotlightUids) that JSX layers use to dim unrelated
 * clusters in sync with the WebGL scatterplot opacity field.
 *
 * The hover clears through two paths:
 * - onHoverRelation(null) from the inset's onMouseLeave, and
 * - automatically when the hovered inset leaves `renderedRelationIds`
 *   (budget re-selection, cut change, anchor deactivation): an inset that
 *   unmounts mid-hover never fires a mouse-out (issue #264), mirroring the
 *   `effectiveHover` unmount fallback on the cluster-hover path.
 */
export function useRelationHover(
  spotlight: (item: ClusterItem | null) => void,
  renderedRelationIds: ReadonlySet<string>
): {
  spotlightUids: ReadonlySet<string> | null;
  hoveredRelationItem: ClusterItem | null;
  onHoverRelation: (item: ClusterItem | null) => void;
} {
  // spotlightUids tracks the two endpoint cluster uids so JSX layers can dim
  // unrelated clusters in sync with the WebGL scatterplot opacity field.
  const [spotlightUids, setSpotlightUids] = useState<ReadonlySet<string> | null>(null);
  // hoveredRelationItem drives the overlap-gated nudge effect in ClusterVisualizations.
  const [hoveredRelationItem, setHoveredRelationItem] = useState<ClusterItem | null>(null);

  const onHoverRelation = useCallback((item: ClusterItem | null) => {
    const a = item?.element.relationAnchors;
    setSpotlightUids(a ? new Set([a.uidA, a.uidB]) : null);
    setHoveredRelationItem(item);
  }, []);

  // Fire the WebGL spotlight tween in the same layout-effect phase framer-motion
  // uses to kick off the JSX motion.div tweens (driven by spotlightUids above),
  // so both sides start on the same commit instead of the WebGL tween starting
  // synchronously in the event handler and running ahead of the JSX tweens.
  const didHoverRef = useRef(false);
  useLayoutEffect(() => {
    if (!didHoverRef.current && hoveredRelationItem === null) return; // skip initial mount
    didHoverRef.current = true;
    spotlight(hoveredRelationItem);
  }, [hoveredRelationItem, spotlight]);

  // Unmount fallback (issue #264): reset both channels together when the
  // hovered inset is no longer rendered — the layout effect above then
  // restores the WebGL field via spotlight(null) in the same commit that
  // un-dims the JSX layers.
  useEffect(() => {
    if (hoveredRelationItem && !renderedRelationIds.has(hoveredRelationItem.element.id)) {
      setHoveredRelationItem(null);
      setSpotlightUids(null);
    }
  }, [hoveredRelationItem, renderedRelationIds]);

  return { spotlightUids, hoveredRelationItem, onHoverRelation };
}
