import type * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useSelector } from "react-redux";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { useLayout } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { SPOTLIGHT_DIM } from "src/utils/spotlightDim";

export interface EdgeAnnotationClusterItemsProps {
  annotationItems: ClusterItem[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  /** must be the edgeAnnotationClusterVersion from Redux */
  version: number;
  /** When a D2 diff-inset spotlight is active, edge-annotation labels have no node
   *  uid match, so they dim wholesale whenever any spotlight is active.
   *  Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TRANSFORM_TEMPLATE = ({ x, y, scale }: any) =>
  `translate(${x},${y}) translate(-50%,-50%) scale(calc(var(--invk,1)*${scale}))`;

interface EdgeAnnotationItemProps {
  element: VisualElement;
  /** Passed explicitly (not read off `element`) so React.memo detects the new
   *  array identity reconcileClusterItems assigns on membership change. */
  samples: VisualElement["samples"];
  x: number;
  y: number;
  opacity: number;
  transition: { default: { duration: number; ease: ReturnType<typeof resolveEase> } };
  /** Renderer inputs read live from the store — memo-bust the JSX when they change. */
  clusterSettings: RootState["clusterSettings"];
}

/**
 * One edge annotation per component so React.memo can skip unmoved items while
 * the parent re-renders per layout patch / settled zoom tick, and useMemo
 * reuses the renderer JSX (which also recomputes + writes the renderer bbox
 * the annealer reads — its inputs are exactly the memo deps below).
 */
const EdgeAnnotationItem = React.memo(function EdgeAnnotationItem({
  element,
  samples,
  x,
  y,
  opacity,
  transition,
  clusterSettings,
}: EdgeAnnotationItemProps) {
  const content = React.useMemo(
    () =>
      samples.length === 1
        ? element.renderer.renderSingleEdgeAnnotation(samples)
        : element.renderer.renderGroupEdgeAnnotation(samples),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, samples, clusterSettings]
  );

  return (
    <motion.div
      initial={{ opacity: 0, x, y, scale: 0.8 }}
      animate={{ opacity, x, y, scale: 1 }}
      exit={{ opacity: 0, x, y, scale: 0.8 }}
      transition={transition}
      transformTemplate={TRANSFORM_TEMPLATE}
      style={{ position: "absolute", pointerEvents: "none" }}
    >
      {content}
    </motion.div>
  );
});

function EdgeAnnotationClusterItems({ annotationItems, scales, spotlightUids }: EdgeAnnotationClusterItemsProps) {
  const { positions } = useLayout();
  const clusterSettings = useSelector((s: RootState) => s.clusterSettings);
  const { duration, ease } = clusterSettings;
  const transition = React.useMemo(() => ({ default: { duration, ease: resolveEase(ease) } }), [duration, ease]);

  return (
    <AnimatePresence>
      {annotationItems.map(({ element }) => {
        const pos = positions.get(element.id) ?? element.center;
        return (
          <EdgeAnnotationItem
            key={element.id}
            element={element}
            samples={element.samples}
            x={scales.xScale(pos.x)}
            y={scales.yScale(pos.y)}
            opacity={spotlightUids ? SPOTLIGHT_DIM : 1}
            transition={transition}
            clusterSettings={clusterSettings}
          />
        );
      })}
    </AnimatePresence>
  );
}

export const AnimatedEdgeAnnotationClusterItems = React.memo(EdgeAnnotationClusterItems);

export default AnimatedEdgeAnnotationClusterItems;
