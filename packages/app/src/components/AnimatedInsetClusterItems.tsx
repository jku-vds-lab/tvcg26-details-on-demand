// src/components/Visualization/AnimatedInsetClusterItems.tsx
import { IconButton } from "@mui/material";
import type * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import { PinOff } from "lucide-react";
import React from "react";
import { useDispatch, useSelector } from "react-redux";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { applyPartial as layoutApplyPartial, getSnapshot as layoutGet, useLayout } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import { parseClusterUid } from "src/models/VisualElement";
import { beginInlineLabeling } from "src/slices/labelingSlice";
import type { RootState } from "src/store";
import { ledgerMark } from "src/utils/insetLedger";
import { resolveEase } from "src/utils/resolveEase";
import { spotlightOpacity } from "src/utils/spotlightDim";

interface Props {
  insetItems: ClusterItem[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  /** must be the insetClusterVersion from Redux */
  version: number;
  /** Called with the hovered cluster uid on enter, null on leave. */
  onHoverCluster?: (uid: string | null) => void;
  /** Enable pointer events for hover (set to true when edge annotations are on). */
  hoverEnabled?: boolean;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Insets whose uid is not in this set fade to SPOTLIGHT_DIM. Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TRANSFORM_TEMPLATE = ({ x, y, scale }: any) =>
  `translate(${x},${y}) translate(-50%,-50%) scale(calc(var(--invk,1)*${scale}))`;

/** Screen-px movement before a pointer-down is treated as a drag instead of a
 *  labeling click (#182 clicks must keep working). */
const DRAG_THRESHOLD_PX = 4;

interface InsetItemProps {
  element: VisualElement;
  /** Passed explicitly (not read off `element`) so React.memo detects the new
   *  array identity reconcileClusterItems assigns on membership change. */
  samples: VisualElement["samples"];
  /** Base (unzoomed) scales — identity-stable except on init/resize. Used to
   *  convert drag pointer deltas from screen px to data space. */
  scales: Props["scales"];
  x: number;
  y: number;
  uid: string;
  opacity: number;
  transition: { default: { duration: number; ease: ReturnType<typeof resolveEase> } };
  isLabeling: boolean;
  hoverEnabled: boolean;
  insetHoverScale: number;
  interactive: boolean;
  onHoverCluster?: (uid: string | null) => void;
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
 * One inset per component so React.memo can skip unmoved items entirely while
 * the parent re-renders per layout patch / settled zoom tick, and useMemo
 * reuses the renderer JSX (which also recomputes + writes the renderer bbox
 * the annealer reads — its inputs are exactly the memo deps below).
 */
const InsetItem = React.memo(function InsetItem({
  element,
  samples,
  scales,
  x,
  y,
  uid,
  opacity,
  transition,
  isLabeling,
  hoverEnabled,
  insetHoverScale,
  interactive,
  onHoverCluster,
  clusterSettings,
  annotationLabelFeature,
  clusterLabelStrategy,
  tfidfLabels,
  activeInlineDraft,
  assignments,
  deferredColumnsRevision,
}: InsetItemProps) {
  const dispatch = useDispatch();
  // Task 2 attribution (#315): the shell's DOM mount, after any staggered
  // admission — repeats on the same uid reveal remount/reset loops.
  React.useEffect(() => {
    ledgerMark(uid, "shellMount");
  }, [uid]);
  const content = React.useMemo(
    () =>
      samples.length === 1
        ? element.renderer.renderSingleNodeInset(samples)
        : element.renderer.renderGroupNodeInset(samples),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element, samples, clusterSettings, annotationLabelFeature, clusterLabelStrategy, tfidfLabels, activeInlineDraft, assignments, deferredColumnsRevision]
  );

  // --- Drag-to-reposition (issue #290). The write path is the intended
  // manual-placement mechanism: layoutApplyPartial on a cold element persists
  // indefinitely; `pinned` keeps every reheat path off it (see VisualElement).
  const dragRef = React.useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    base: { x: number; y: number };
    dragging: boolean;
  } | null>(null);
  const didDragRef = React.useRef(false);
  const [isDragging, setIsDragging] = React.useState(false);
  // `element.pinned` is a plain mutable field — bump after writing it so the
  // unpin badge shows/hides without threading pinned through props.
  const [, bumpPinned] = React.useReducer((c: number) => c + 1, 0);
  // Tracks hover locally so the unpin badge only renders while hovered. The
  // badge is a CHILD of this (hover-scaled) div and overhangs its corner with
  // no gap, so moving the cursor onto it never leaves the inset — the
  // hover-enlarge cannot shrink away from under the click (#290 unpin UX).
  const [hovered, setHovered] = React.useState(false);
  // Position writes must track the cursor 1:1 — no eased layout transition.
  const dragTransition = React.useMemo(
    () => ({ default: { ...transition.default, duration: 0 } }),
    [transition]
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    didDragRef.current = false;
    const cur = layoutGet().positions.get(element.id) ?? element.center;
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      base: { x: cur.x, y: cur.y },
      dragging: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dxPx = e.clientX - d.startClientX;
    const dyPx = e.clientY - d.startClientY;
    if (!d.dragging) {
      if (Math.hypot(dxPx, dyPx) < DRAG_THRESHOLD_PX) return;
      d.dragging = true;
      setIsDragging(true);
      // Pin before the first write so the engine never fights the gesture.
      element.pinned = true;
      element.temperature = 0;
      bumpPinned();
      try {
        e.currentTarget.setPointerCapture(d.pointerId);
      } catch {
        // Pointer no longer active (or jsdom) — deltas still track via bubbling.
      }
    }
    // Screen px → data: the annotation layer is scaled by the zoom k (insets
    // counter-scale via --invk = 1/k), so divide by k before the base scales.
    const invk =
      parseFloat(getComputedStyle(e.currentTarget).getPropertyValue("--invk")) || 1;
    const pxPerDataX = scales.xScale(1) - scales.xScale(0);
    const pxPerDataY = scales.yScale(1) - scales.yScale(0);
    if (Math.abs(pxPerDataX) < 1e-12 || Math.abs(pxPerDataY) < 1e-12) return;
    layoutApplyPartial(
      new Map([
        [
          element.id,
          {
            x: d.base.x + (dxPx * invk) / pxPerDataX,
            y: d.base.y + (dyPx * invk) / pxPerDataY,
          },
        ],
      ])
    );
  };

  const onPointerUpOrCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.dragging) {
      // Swallow the click that follows this pointer-up (labeling, #182).
      didDragRef.current = true;
      setIsDragging(false);
    }
    dragRef.current = null;
  };

  return (
    <motion.div
      initial={{ opacity: 0, x, y, scale: 0.8 }}
      animate={{ opacity, x, y, scale: 1 }}
      exit={{ opacity: 0, x, y, scale: 0.8 }}
      transition={isDragging ? dragTransition : transition}
      whileHover={hoverEnabled ? { scale: insetHoverScale } : undefined}
      transformTemplate={TRANSFORM_TEMPLATE}
      data-interaction-ignore={interactive ? "true" : undefined}
      data-inset-uid={uid}
      style={{
        position: "absolute",
        pointerEvents: interactive ? "auto" : "none",
        cursor: isDragging ? "grabbing" : isLabeling ? "pointer" : undefined,
        // Each inset div is a transform stacking context painted in DOM order,
        // so the overhanging unpin badge would sit below later siblings. Lift
        // the hovered/dragged inset above its peers (#290).
        zIndex: hovered || isDragging ? 10 : undefined,
      }}
      onMouseEnter={hoverEnabled ? () => { setHovered(true); onHoverCluster?.(uid); } : undefined}
      onMouseLeave={hoverEnabled ? () => { setHovered(false); onHoverCluster?.(null); } : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUpOrCancel : undefined}
      onPointerCancel={interactive ? onPointerUpOrCancel : undefined}
      onClick={isLabeling ? (e) => {
        e.stopPropagation();
        if (didDragRef.current) {
          // Drag end, not a labeling click.
          didDragRef.current = false;
          return;
        }
        dispatch(beginInlineLabeling({ clusterUid: uid, elementId: element.id }));
      } : undefined}
    >
      {content}
      {element.pinned && hovered && (
        <IconButton
          size="small"
          aria-label="Unpin inset"
          title="Unpin inset (return it to automatic layout)"
          onPointerDown={(e) => e.stopPropagation() /* never starts a drag */}
          onClick={(e) => {
            e.stopPropagation(); // not a labeling click
            element.pinned = false;
            bumpPinned();
          }}
          sx={{
            // Badge on the top-right corner: overhangs outward but keeps
            // touching the content, so the cursor path stays inside the
            // hover-scaled div and covers only a sliver of the inset.
            position: "absolute",
            top: 0,
            right: 0,
            transform: "translate(45%, -45%)",
            zIndex: 5,
            padding: "3px",
            backgroundColor: "rgba(255,255,255,0.85)",
            border: "1px solid #ccc",
            "&:hover": { backgroundColor: "#fff" },
          }}
        >
          <PinOff size={14} />
        </IconButton>
      )}
    </motion.div>
  );
});

/**
 * Staggered mount admission (issue #315): a batch of newly-activated insets
 * mounts over consecutive frames (`perFrame` each) instead of one React
 * commit — CS's trace showed 60–400 ms commit tasks when a settle activated
 * several clusters at once. Already-admitted items re-render normally;
 * removed items leave immediately (AnimatePresence handles the exit).
 */
function useStaggeredMount(items: Props["insetItems"], perFrame = 2): Props["insetItems"] {
  // Whatever is present at FIRST render mounts synchronously (initial
  // dataset load renders everything at once, exactly as before); only
  // items appearing later — per-gesture activations — stagger.
  const [admitted, setAdmitted] = React.useState<ReadonlySet<string>>(
    () => new Set(items.map((it) => it.element.id))
  );
  React.useEffect(() => {
    let pending = 0;
    for (const it of items) if (!admitted.has(it.element.id)) pending++;
    if (pending === 0) return;
    const raf = requestAnimationFrame(() => {
      setAdmitted((prev) => {
        const next = new Set(prev);
        let n = 0;
        for (const it of items) {
          if (!next.has(it.element.id)) {
            next.add(it.element.id);
            if (++n >= perFrame) break;
          }
        }
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [items, admitted, perFrame]);
  return React.useMemo(
    () => items.filter((it) => admitted.has(it.element.id)),
    [items, admitted]
  );
}

function InsetClusterItems({ insetItems, scales, onHoverCluster, hoverEnabled, spotlightUids }: Props) {
  // triggers CSS var read once to ensure stylesheet is applied
  getComputedStyle(document.documentElement).getPropertyValue("--invk");
  const { positions } = useLayout();
  const admittedItems = useStaggeredMount(insetItems);

  const clusterSettings = useSelector((s: RootState) => s.clusterSettings);
  const { duration, ease, insetHoverScale } = clusterSettings;
  // Renderer inputs read live from the store — passed down as memo-bust deps.
  const annotationLabelFeature = useSelector((s: RootState) => s.visualizationSettings.annotationLabelFeature);
  const clusterLabelStrategy = useSelector((s: RootState) => s.visualizationSettings.clusterLabelStrategy);
  const tfidfLabels = useSelector((s: RootState) => s.visualizationSettings.tfidfLabels);
  const isLabeling = useSelector((s: RootState) => s.labeling.isEnabled);
  const interactive = isLabeling || !!hoverEnabled;
  const activeInlineDraft = useSelector((s: RootState) => s.labeling.activeInlineDraft);
  const assignments = useSelector((s: RootState) => s.labeling.assignments);
  const deferredColumnsRevision = useSelector(
    (s: RootState) => s.datasetFeatures.deferredColumnsRevision
  );
  const transition = React.useMemo(() => ({ default: { duration, ease: resolveEase(ease) } }), [duration, ease]);

  return (
    <AnimatePresence>
      {admittedItems.map(({ element }) => {
        const pos = positions.get(element.id) ?? element.center;
        const uid = parseClusterUid(element.id);
        return (
          <InsetItem
            key={element.id}
            element={element}
            samples={element.samples}
            scales={scales}
            x={scales.xScale(pos.x)}
            y={scales.yScale(pos.y)}
            uid={uid}
            opacity={spotlightOpacity(uid, spotlightUids ?? null)}
            transition={transition}
            isLabeling={isLabeling}
            hoverEnabled={!!hoverEnabled}
            insetHoverScale={insetHoverScale}
            interactive={interactive}
            onHoverCluster={onHoverCluster}
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
export const AnimatedInsetClusterItems = React.memo(InsetClusterItems);

export default AnimatedInsetClusterItems;
