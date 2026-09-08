/**
 * HoverDiffGlyphs — synthetic diff view components for node-inset hover (D1).
 *
 * When a node inset is hovered, every OTHER active cluster gets a synthetic diff shown:
 * - AnimatedEdgeInsetClusterItems handles clusters that DO have a trajectory relation.
 * - These two components handle clusters that do NOT (synthetic pairs).
 *
 * Split into two separately-mounted components so they sit at the correct z-depths:
 * - HoverDiffLeaders: SVG leader lines, mounted below inset divs (same depth as real relation leaders).
 * - HoverDiffInsets: animated glyph divs, mounted above relation leaders (same depth as edge insets).
 *
 * Content (the expensive per-dataset canvas/SVG diff) is computed inside each HoverDiffInsetItem
 * child via useMemo([aEl, bEl]). For CCTV/MNIST the renderer returns a spinner immediately and
 * kicks off async computation via setTimeout(0). For Chess/Rubiks the synchronous diff is fast.
 * ClusterVisualizations does NOT re-render on every annealing step (useLayout() removed from
 * that component), so hover commits are scheduled against a quiet React scheduler.
 */
import type * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useSelector } from "react-redux";
import { groupMemberRowAt } from "src/clustering/groupMembers";
import type { HoverDiffPair } from "src/hooks/useHoverDiffPairs";
import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";
import { useLayout } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { instantiateRenderer } from "src/utils/clusterDataUtils";
import { attachEdgeSides } from "./Visualization/Details/edgeSides";
import { segmentRectBorderPoint } from "src/utils/geometryUtils";
import { computeLeaderShadowFilter } from "./Visualization/leaderShadow";
import {
  computeRelationLeaderStyle,
  type RelationLeaderStyleOpts,
} from "./Visualization/relationLeaderStyle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TRANSFORM_TEMPLATE = ({ x, y, scale }: any) =>
  `translate(${x},${y}) translate(-50%,-50%) scale(calc(var(--invk,1)*${scale}))`;

interface LeadersProps {
  pairs: HoverDiffPair[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  cssScale: number;
}

/**
 * SVG synthetic leader lines for hover diff pairs.
 * Styled to match AnimatedRelationLeaderLines: same dash/halo/shadow, no arrowheads
 * (synthetic pairs are undirected — no trajectory data).
 */
export const HoverDiffLeaders = React.memo(function HoverDiffLeaders({
  pairs,
  scales,
  cssScale,
}: LeadersProps) {
  const { positions } = useLayout();

  const {
    relationLeaderThickness,
    relationLeaderGray,
    relationLeaderOutlineThickness,
    relationLeaderDashLength,
    relationLeaderDashGap,
    relationLeaderWidthEncodesStrength,
    relationArrowMinSize,
    relationArrowMaxSize,
    relationLeaderMinWidth,
    relationLeaderShadow,
    relationLeaderShadowIntensity,
    insetHoverScale,
    duration,
    ease,
  } = useSelector((s: RootState) => s.clusterSettings);
  const canvasBgColor = useSelector((s: RootState) => s.visualizationSettings.canvasBgColor);

  const gray = Math.round(relationLeaderGray * 255);
  const strokeColor = `rgb(${gray},${gray},${gray})`;

  const styleOpts: RelationLeaderStyleOpts = React.useMemo(
    () => ({
      minArrow: relationArrowMinSize,
      maxArrow: relationArrowMaxSize,
      minWidth: relationLeaderMinWidth,
      baseWidth: relationLeaderThickness,
      outlineThickness: relationLeaderOutlineThickness,
      widthEncodesStrength: relationLeaderWidthEncodesStrength,
    }),
    [
      relationArrowMinSize,
      relationArrowMaxSize,
      relationLeaderMinWidth,
      relationLeaderThickness,
      relationLeaderOutlineThickness,
      relationLeaderWidthEncodesStrength,
    ]
  );

  const transitionProps = React.useMemo(
    () => ({
      x1: { duration, ease },
      y1: { duration, ease },
      x2: { duration, ease },
      y2: { duration, ease },
    }),
    [duration, ease]
  );

  if (pairs.length === 0) return null;

  // Use neutral strength (0.5) for synthetic pairs — no directional score available.
  const style = computeRelationLeaderStyle(0.5, styleOpts);
  const thicknessStyle = `calc(var(--invk,1) * ${style.lineWidth}px)`;
  const outlineStyle = `calc(var(--invk,1) * ${style.outlineWidth}px)`;
  const dash =
    relationLeaderDashLength > 0 || relationLeaderDashGap > 0
      ? `calc(var(--invk,1) * ${relationLeaderDashLength}px) calc(var(--invk,1) * ${relationLeaderDashGap}px)`
      : undefined;
  const shadowFilter = computeLeaderShadowFilter(
    relationLeaderShadow,
    relationLeaderShadowIntensity,
    cssScale
  );

  return (
    <svg
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
        overflow: "visible",
      }}
      width={1}
      height={1}
    >
      <AnimatePresence>
        {pairs.flatMap(({ aEl, bEl, bUid }) => {
          const aPos = positions.get(aEl.id) ?? aEl.position;
          const bPos = positions.get(bEl.id) ?? bEl.position;
          const ax = scales.xScale(aPos.x);
          const ay = scales.yScale(aPos.y);
          const bx = scales.xScale(bPos.x);
          const by = scales.yScale(bPos.y);
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;

          // Clip node-side endpoints to the rendered inset borders (aEl is the
          // hovered node — its div renders at insetHoverScale). The midpoint end
          // stays at the centre; the diff glyph mounted above covers it.
          // cssScale (the live 1/k) passed explicitly — same staleness family as the
          // relation leaders: the stored currentCssScale lags the settled zoom by one
          // commit (#345).
          const bboxA = aEl.getScreenVisualBoundingBoxFor(aPos, scales.xScale, scales.yScale, insetHoverScale, cssScale);
          const bboxB = bEl.getScreenVisualBoundingBoxFor(bPos, scales.xScale, scales.yScale, 1, cssScale);
          const [aBx, aBy] = segmentRectBorderPoint([ax, ay], bboxA, [mx, my]);
          const [bBx, bBy] = segmentRectBorderPoint([bx, by], bboxB, [mx, my]);

          // Lines collapse to the respective node border on enter/exit.
          const initialA = { x1: aBx, y1: aBy, x2: aBx, y2: aBy, opacity: 0 };
          const animateA = { x1: aBx, y1: aBy, x2: mx, y2: my, opacity: 1 };
          const initialB = { x1: bBx, y1: bBy, x2: bBx, y2: bBy, opacity: 0 };
          const animateB = { x1: bBx, y1: bBy, x2: mx, y2: my, opacity: 1 };

          return (
            <React.Fragment key={`hover-leader-${aEl.id}-${bUid}`}>
              {/* A-side leader: A node → midpoint */}
              <g style={{ filter: shadowFilter }}>
                <motion.line
                  key={`hover-leader-${aEl.id}-${bUid}-a-out`}
                  initial={initialA}
                  animate={animateA}
                  exit={initialA}
                  transition={transitionProps}
                  stroke={canvasBgColor}
                  style={{ strokeWidth: outlineStyle }}
                />
                <motion.line
                  key={`hover-leader-${aEl.id}-${bUid}-a`}
                  initial={initialA}
                  animate={animateA}
                  exit={initialA}
                  transition={transitionProps}
                  stroke={strokeColor}
                  style={{ strokeWidth: thicknessStyle, strokeDasharray: dash }}
                />
              </g>
              {/* B-side leader: B node → midpoint */}
              <g style={{ filter: shadowFilter }}>
                <motion.line
                  key={`hover-leader-${aEl.id}-${bUid}-b-out`}
                  initial={initialB}
                  animate={animateB}
                  exit={initialB}
                  transition={transitionProps}
                  stroke={canvasBgColor}
                  style={{ strokeWidth: outlineStyle }}
                />
                <motion.line
                  key={`hover-leader-${aEl.id}-${bUid}-b`}
                  initial={initialB}
                  animate={animateB}
                  exit={initialB}
                  transition={transitionProps}
                  stroke={strokeColor}
                  style={{ strokeWidth: thicknessStyle, strokeDasharray: dash }}
                />
              </g>
            </React.Fragment>
          );
        })}
      </AnimatePresence>
    </svg>
  );
});

interface InsetsProps {
  pairs: HoverDiffPair[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
}

interface InsetItemProps {
  aEl: VisualElement;
  bEl: VisualElement;
  bUid: string;
  x: number;
  y: number;
  transition: { default: { duration: number; ease: string } };
}

/**
 * One animated diff glyph for a single hover pair.
 * Computes renderGroupEdgeInset content once via useMemo([aEl, bEl]).
 * For CCTV/MNIST returns a spinner immediately (async diff). For Chess/Rubiks synchronous but fast.
 */
const HoverDiffInsetItem = React.memo(function HoverDiffInsetItem({
  aEl,
  bEl,
  bUid,
  x,
  y,
  transition,
}: InsetItemProps) {
  const content = React.useMemo(() => {
    const bSamples = bEl.samples;
    const n = Math.max(bSamples.length, 1);
    // Use Object.create instead of spread: DataPoints can carry thousands of pixel
    // properties ("1x1"…"128x72" for CCTV). Spreading copies all of them per sample
    // per pair — millions of property copies inside the React commit → first-hover
    // freeze. Object.create inherits every field via prototype (zero copying) while
    // only setting the two own properties the renderer actually needs.
    //
    // The A/B CONTENT resolution goes through the __edgeSides marker (the
    // ORIGINAL cluster arrays — identity-stable and leaf-range-marked, so
    // backend diffs go by range), so this pairing array only feeds cosmetic
    // per-sample paths (the action-label overlay). Cap its materialization:
    // at 840k members the Object.create loop alone froze the first hover for
    // ~1.6 s. Above the cap the overlay derives from a stride subset —
    // display-only; server-aggregated diff content is unaffected.
    const total = aEl.samples.length;
    const stride = Math.max(1, Math.ceil(total / 4096));
    const samples: EdgeAugmentedPoint[] = [];
    for (let i = 0; i < total; i += stride) {
      // groupMemberRowAt (issue #315 R1c): index-backed groups resolve the
      // strided member through their spec (`rowAt`, memoized per canonical
      // index); plain arrays read the slot as before.
      const aPoint = groupMemberRowAt(aEl.samples, i);
      if (!aPoint) continue;
      const s = Object.create(aPoint) as EdgeAugmentedPoint;
      s.edgeStart = aPoint;
      s.edgeEnd = groupMemberRowAt(bSamples, i % n);
      samples.push(s);
    }
    attachEdgeSides(samples, { starts: aEl.samples, ends: bEl.samples });
    // Scratch renderer: rendering through aEl.renderer would overwrite the node
    // element's stored bounding box with the edge-diff bbox, breaking leader-line
    // clipping against the node inset for as long as the hover lasts.
    return instantiateRenderer(aEl.datasetType).renderGroupEdgeInset(samples);
  }, [aEl, bEl]);

  return (
    <motion.div
      key={`hover-diff-${aEl.id}-${bUid}`}
      initial={{ opacity: 0, x, y, scale: 0.8 }}
      animate={{ opacity: 1, x, y, scale: 1 }}
      exit={{ opacity: 0, x, y, scale: 0.8 }}
      transition={transition}
      transformTemplate={TRANSFORM_TEMPLATE}
      style={{ position: "absolute", pointerEvents: "none" }}
    >
      {content}
    </motion.div>
  );
});

/**
 * Animated diff glyph divs for hover diff pairs.
 * Delegates content computation to HoverDiffInsetItem children (each with their own useMemo).
 */
export const HoverDiffInsets = React.memo(function HoverDiffInsets({
  pairs,
  scales,
}: InsetsProps) {
  const { positions } = useLayout();
  const { duration, ease } = useSelector((s: RootState) => s.clusterSettings);
  const transition = React.useMemo(() => ({ default: { duration, ease } }), [duration, ease]);

  return (
    <AnimatePresence>
      {pairs.map(({ aEl, bEl, bUid }) => {
        const aPos = positions.get(aEl.id) ?? aEl.position;
        const bPos = positions.get(bEl.id) ?? bEl.position;
        const x = scales.xScale((aPos.x + bPos.x) / 2);
        const y = scales.yScale((aPos.y + bPos.y) / 2);
        return (
          <HoverDiffInsetItem
            key={`hover-diff-${aEl.id}-${bUid}`}
            aEl={aEl}
            bEl={bEl}
            bUid={bUid}
            x={x}
            y={y}
            transition={transition}
          />
        );
      })}
    </AnimatePresence>
  );
});
