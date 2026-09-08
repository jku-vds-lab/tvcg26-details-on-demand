// src/components/Visualization/AnimatedAnnotationClusterItems.tsx
import type * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { useLayout } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import { parseClusterUid } from "src/models/VisualElement";
import { beginInlineLabeling } from "src/slices/labelingSlice";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { spotlightOpacity } from "src/utils/spotlightDim";

export interface AnnotationClusterItemsProps {
  annotationItems: ClusterItem[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  /** must be the annotationClusterVersion from Redux */
  version: number;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Labels whose uid is not in this set fade to SPOTLIGHT_DIM. Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TRANSFORM_TEMPLATE = ({ x, y, scale }: any) =>
  `translate(${x},${y}) translate(-50%,-50%) scale(calc(var(--invk,1)*${scale}))`;

interface AnnotationItemProps {
  element: VisualElement;
  /** Passed explicitly (not read off `element`) so React.memo detects the new
   *  array identity reconcileClusterItems assigns on membership change. */
  samples: VisualElement["samples"];
  x: number;
  y: number;
  uid: string;
  opacity: number;
  transition: { default: { duration: number; ease: ReturnType<typeof resolveEase> } };
  isLabeling: boolean;
  /** Renderer inputs read live from the store — memo-bust the JSX when they change. */
  clusterSettings: RootState["clusterSettings"];
  annotationLabelFeature: RootState["visualizationSettings"]["annotationLabelFeature"];
  clusterLabelStrategy: RootState["visualizationSettings"]["clusterLabelStrategy"];
  tfidfLabels: RootState["visualizationSettings"]["tfidfLabels"];
  activeInlineDraft: RootState["labeling"]["activeInlineDraft"];
  /** Label assignments are written onto the rows in place (`__assignedLabel`),
   * on sample arrays reconcile keeps stable — re-resolve on change (#352). */
  assignments: RootState["labeling"]["assignments"];
  /** Bumped when a deferred column attaches (issue #315 R3c) — overlay
   * labels that voted before the fetch re-resolve with real values. */
  deferredColumnsRevision: RootState["datasetFeatures"]["deferredColumnsRevision"];
}

/**
 * One annotation per component so React.memo can skip unmoved items while the
 * parent re-renders per layout patch / settled zoom tick, and useMemo reuses
 * the renderer JSX (which also recomputes + writes the renderer bbox the
 * annealer reads — its inputs are exactly the memo deps below).
 */
const AnnotationItem = React.memo(function AnnotationItem({
  element,
  samples,
  x,
  y,
  uid,
  opacity,
  transition,
  isLabeling,
  clusterSettings,
  annotationLabelFeature,
  clusterLabelStrategy,
  tfidfLabels,
  activeInlineDraft,
  assignments,
  deferredColumnsRevision,
}: AnnotationItemProps) {
  const dispatch = useDispatch();
  const content = React.useMemo(
    () =>
      samples.length === 1
        ? element.renderer.renderSingleNodeAnnotation(samples)
        : element.renderer.renderGroupNodeAnnotation(samples),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, samples, clusterSettings, annotationLabelFeature, clusterLabelStrategy, tfidfLabels, activeInlineDraft, assignments, deferredColumnsRevision]
  );

  return (
    <motion.div
      initial={{ opacity: 0, x, y, scale: 0.8 }}
      animate={{ opacity, x, y, scale: 1 }}
      exit={{ opacity: 0, x, y, scale: 0.8 }}
      transition={transition}
      transformTemplate={TRANSFORM_TEMPLATE}
      data-interaction-ignore={isLabeling ? "true" : undefined}
      style={{
        position: "absolute",
        pointerEvents: isLabeling ? "auto" : "none",
        cursor: isLabeling ? "pointer" : undefined,
      }}
      onClick={isLabeling ? (e) => {
        e.stopPropagation();
        dispatch(beginInlineLabeling({ clusterUid: uid, elementId: element.id }));
      } : undefined}
    >
      {content}
    </motion.div>
  );
});

function AnnotationClusterItems({ annotationItems, scales, spotlightUids }: AnnotationClusterItemsProps) {
  const { positions } = useLayout();
  const clusterSettings = useSelector((s: RootState) => s.clusterSettings);
  const { duration, ease } = clusterSettings;
  // Renderer inputs read live from the store — passed down as memo-bust deps.
  const annotationLabelFeature = useSelector((s: RootState) => s.visualizationSettings.annotationLabelFeature);
  const clusterLabelStrategy = useSelector((s: RootState) => s.visualizationSettings.clusterLabelStrategy);
  const tfidfLabels = useSelector((s: RootState) => s.visualizationSettings.tfidfLabels);
  const isLabeling = useSelector((s: RootState) => s.labeling.isEnabled);
  const activeInlineDraft = useSelector((s: RootState) => s.labeling.activeInlineDraft);
  const assignments = useSelector((s: RootState) => s.labeling.assignments);
  const deferredColumnsRevision = useSelector(
    (s: RootState) => s.datasetFeatures.deferredColumnsRevision
  );
  const transition = React.useMemo(() => ({ default: { duration, ease: resolveEase(ease) } }), [duration, ease]);

  return (
    <AnimatePresence>
      {annotationItems.map(({ element }) => {
        const pos = positions.get(element.id) ?? element.center;
        const uid = parseClusterUid(element.id);
        return (
          <AnnotationItem
            key={element.id}
            element={element}
            samples={element.samples}
            x={scales.xScale(pos.x)}
            y={scales.yScale(pos.y)}
            uid={uid}
            opacity={spotlightOpacity(uid, spotlightUids ?? null)}
            transition={transition}
            isLabeling={isLabeling}
            clusterSettings={clusterSettings}
            annotationLabelFeature={annotationLabelFeature}
            clusterLabelStrategy={clusterLabelStrategy}
            tfidfLabels={tfidfLabels}
            activeInlineDraft={activeInlineDraft}
            assignments={assignments}
            deferredColumnsRevision={deferredColumnsRevision}
          />
        );
      })}
    </AnimatePresence>
  );
}

// Important: use default React.memo (no custom comparator).
export const AnimatedAnnotationClusterItems = React.memo(AnnotationClusterItems);

export default AnimatedAnnotationClusterItems;
