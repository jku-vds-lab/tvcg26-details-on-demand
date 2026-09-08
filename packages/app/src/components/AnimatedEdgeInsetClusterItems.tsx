import type * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useSelector } from "react-redux";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { useLayout } from "src/layout/layoutStore";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { relationSpotlightOpacity } from "src/utils/spotlightDim";

interface Props {
  insetItems: ClusterItem[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  /** must be the edgeInsetClusterVersion from Redux */
  version: number;
  /** Called with the ClusterItem on hover enter, null on leave. */
  onHoverRelation?: (item: ClusterItem | null) => void;
  /** Enable pointer events for hover (set to true when diff-inset spotlight is active). */
  hoverEnabled?: boolean;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Relation insets whose {uidA,uidB} pair is not the spotlighted pair dim to SPOTLIGHT_DIM.
   *  Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TRANSFORM_TEMPLATE = ({ x, y, scale }: any) =>
  `translate(${x},${y}) translate(-50%,-50%) scale(calc(var(--invk,1)*${scale}))`;

interface EdgeInsetItemProps {
  item: ClusterItem;
  /** Passed explicitly (not read off the element) so React.memo detects the
   *  new array identity reconcileClusterItems assigns on membership change. */
  samples: ClusterItem["element"]["samples"];
  x: number;
  y: number;
  opacity: number;
  transition: { default: { duration: number; ease: ReturnType<typeof resolveEase> } };
  hoverEnabled: boolean;
  insetHoverScale: number;
  onHoverRelation?: (item: ClusterItem | null) => void;
  /** Renderer inputs read live from the store — memo-bust the JSX when they change. */
  clusterSettings: RootState["clusterSettings"];
}

/**
 * One relation inset per component so React.memo can skip unmoved items while
 * the parent re-renders per layout patch / settled zoom tick, and useMemo
 * reuses the renderer JSX (which also recomputes + writes the renderer bbox
 * the annealer reads — its inputs are exactly the memo deps below).
 */
const EdgeInsetItem = React.memo(function EdgeInsetItem({
  item,
  samples,
  x,
  y,
  opacity,
  transition,
  hoverEnabled,
  insetHoverScale,
  onHoverRelation,
  clusterSettings,
}: EdgeInsetItemProps) {
  const { element } = item;
  const onSpline = element.relationAnchors?.onSpline === true;
  const content = React.useMemo(
    () =>
      onSpline
        ? element.renderer.renderSingleEdgeInset(samples)
        : element.renderer.renderGroupEdgeInset(samples),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, samples, onSpline, clusterSettings]
  );

  return (
    <motion.div
      initial={{ opacity: 0, x, y, scale: 0.8 }}
      animate={{ opacity, x, y, scale: 1 }}
      exit={{ opacity: 0, x, y, scale: 0.8 }}
      transition={transition}
      whileHover={hoverEnabled ? { scale: insetHoverScale } : undefined}
      transformTemplate={TRANSFORM_TEMPLATE}
      data-interaction-ignore={hoverEnabled ? "true" : undefined}
      style={{
        position: "absolute",
        pointerEvents: hoverEnabled ? "auto" : "none",
      }}
      onMouseEnter={hoverEnabled ? () => onHoverRelation?.(item) : undefined}
      onMouseLeave={hoverEnabled ? () => onHoverRelation?.(null) : undefined}
    >
      {content}
    </motion.div>
  );
});

function EdgeInsetClusterItems({ insetItems, scales, onHoverRelation, hoverEnabled, spotlightUids }: Props) {
  getComputedStyle(document.documentElement).getPropertyValue("--invk");
  const { positions } = useLayout();
  const clusterSettings = useSelector((s: RootState) => s.clusterSettings);
  const { duration, ease, insetHoverScale } = clusterSettings;
  const transition = React.useMemo(() => ({ default: { duration, ease: resolveEase(ease) } }), [duration, ease]);

  return (
    <AnimatePresence>
      {insetItems.map((item) => {
        const { element } = item;
        const pos = positions.get(element.id) ?? element.center;
        const anchors = element.relationAnchors;
        const opacity = anchors
          ? relationSpotlightOpacity(anchors.uidA, anchors.uidB, spotlightUids ?? null)
          : spotlightUids ? 0.15 : 1;
        return (
          <EdgeInsetItem
            key={element.id}
            item={item}
            samples={element.samples}
            x={scales.xScale(pos.x)}
            y={scales.yScale(pos.y)}
            opacity={opacity}
            transition={transition}
            hoverEnabled={!!hoverEnabled}
            insetHoverScale={insetHoverScale}
            onHoverRelation={onHoverRelation}
            clusterSettings={clusterSettings}
          />
        );
      })}
    </AnimatePresence>
  );
}

export const AnimatedEdgeInsetClusterItems = React.memo(EdgeInsetClusterItems);

export default AnimatedEdgeInsetClusterItems;
