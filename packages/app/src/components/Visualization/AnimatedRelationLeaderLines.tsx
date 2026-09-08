/**
 * AnimatedRelationLeaderLines
 *
 * Renders two structural leader lines per floating cluster-conditioned edge relation inset:
 *   - inset border → node-inset glyph border for cluster A (always drawn)
 *   - inset border → node-inset glyph border for cluster B (always drawn)
 *
 * Both leaders are always fully opaque — their presence signals which two clusters the
 * inset connects.  Direction is encoded by **arrowhead size** (and optionally line width),
 * never by opacity or by hiding a leader.  Arrowhead drawn at cluster end only when that
 * direction has transitions (score > 0).
 *
 * Strength → visual-channel mapping is handled by `computeRelationLeaderStyle`
 * (see `relationLeaderStyle.ts`) — a pure function that is independently unit-tested.
 *
 * Geometry: each leader is clipped to both bounding-box borders using
 * segmentRectBorderPoint so lines emerge from the inset border and stop on the
 * node-inset border, aimed at the respective glyph centre.
 */
import * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useSelector } from "react-redux";
import { useLayout } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import { segmentRectBorderPoint } from "src/utils/geometryUtils";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { relationSpotlightOpacity } from "src/utils/spotlightDim";
import { computeRelationLeaderStyle } from "./relationLeaderStyle";
import type { RelationLeaderStyleOpts } from "./relationLeaderStyle";
import { computeLeaderShadowFilter } from "./leaderShadow";

interface RelationItem {
  element: VisualElement;
  /** Placed node inset for cluster A (canonical uidA). */
  elementA: VisualElement;
  /** Placed node inset for cluster B (canonical uidB). */
  elementB: VisualElement;
}

interface Props {
  items: RelationItem[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  canvasWidth: number;
  canvasHeight: number;
  /** Current 1/zoomK — passed as a prop so the component re-renders on every zoom frame
   *  and arrowheads stay correctly sized without waiting for the layout version to bump. */
  cssScale: number;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Relation leaders whose {uidA,uidB} pair does not match fade to SPOTLIGHT_DIM.
   *  Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
  /** Uid of the hovered node cluster (its inset renders at insetHoverScale) — the
   *  clip box for that endpoint is grown accordingly so tips track the border. */
  hoverUid?: string | null;
  /** clusterSettings.insetHoverScale (rendered via framer whileHover). */
  hoverScale?: number;
}

/**
 * Compute the angle (in degrees) pointing from `tail` to `tip`.
 * Used to orient the arrowhead polygon via CSS transform.
 */
function arrowAngleDeg(tip: [number, number], tail: [number, number]): number {
  return (Math.atan2(tip[1] - tail[1], tip[0] - tail[0]) * 180) / Math.PI;
}

/**
 * Unit arrowhead polygon `points` string: tip at origin, pointing in the +x direction,
 * scaled so the total length is `lengthPx` (before any CSS scale transform).
 * The caller positions and scales it with a CSS transform so zoom applies correctly.
 */
function unitArrowPoints(lengthPx: number): string {
  const halfBase = lengthPx * 0.42;
  return `0,0 ${-lengthPx},${halfBase} ${-lengthPx},${-halfBase}`;
}

function RelationLeaderLines({ items, scales, canvasWidth, canvasHeight, cssScale: cssProp, spotlightUids, hoverUid, hoverScale }: Props) {
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
    duration,
    ease,
  } = useSelector((s: RootState) => s.clusterSettings);
  const canvasBgColor = useSelector((s: RootState) => s.visualizationSettings.canvasBgColor);

  const gray = Math.round(relationLeaderGray * 255);
  const strokeColor = `rgb(${gray},${gray},${gray})`;

  // Normalise: strongest single direction across all shown relations = 1.0.
  const allMax = React.useMemo(() => {
    let m = 1e-9;
    for (const { element } of items) {
      const a = element.relationAnchors;
      if (!a) continue;
      m = Math.max(m, a.forwardScore, a.backwardScore);
    }
    return m;
  }, [items]);

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

  const resolvedEase = React.useMemo(() => resolveEase(ease), [ease]);
  // opacity is listed explicitly: without it the spotlight dim fade would fall
  // back to framer-motion's built-in default transition and desync from the
  // other overlay layers and the WebGL spotlight tween.
  const transition = React.useMemo(
    () => ({
      x1: { duration, ease: resolvedEase },
      y1: { duration, ease: resolvedEase },
      x2: { duration, ease: resolvedEase },
      y2: { duration, ease: resolvedEase },
      opacity: { duration, ease: resolvedEase },
    }),
    [duration, resolvedEase]
  );

  return (
    <svg
      width={canvasWidth}
      height={canvasHeight}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <AnimatePresence>
        {items.flatMap(({ element, elementA, elementB }) => {
          const anchors = element.relationAnchors;
          if (!anchors) return null;

          // Inset placed position (data-space) → screen
          const posInset = positions.get(element.id) ?? element.center;
          const icx = scales.xScale(posInset.x);
          const icy = scales.yScale(posInset.y);

          // Node glyph bounding boxes in screen space. Visual (inset-body) boxes,
          // not the label-union layout boxes, so leader tips touch the rendered
          // border exactly; the hovered node's box grows with insetHoverScale.
          const posA = positions.get(elementA.id) ?? elementA.center;
          const posB = positions.get(elementB.id) ?? elementB.center;
          const hoverA = hoverUid && anchors.uidA === hoverUid ? (hoverScale ?? 1) : 1;
          const hoverB = hoverUid && anchors.uidB === hoverUid ? (hoverScale ?? 1) : 1;
          // cssProp (the live 1/k) is passed explicitly: the elements' stored
          // currentCssScale is only corrected by an effect after this render
          // committed, so clipping against the field-scaled boxes bakes stale
          // geometry when the zoom settles without a later position change (#345).
          const bboxInset = element.getScreenVisualBoundingBoxFor(posInset, scales.xScale, scales.yScale, 1, cssProp);
          const bboxA = elementA.getScreenVisualBoundingBoxFor(posA, scales.xScale, scales.yScale, hoverA, cssProp);
          const bboxB = elementB.getScreenVisualBoundingBoxFor(posB, scales.xScale, scales.yScale, hoverB, cssProp);

          // Screen centres of each glyph
          const acx = bboxA.x + bboxA.width / 2;
          const acy = bboxA.y + bboxA.height / 2;
          const bcx = bboxB.x + bboxB.width / 2;
          const bcy = bboxB.y + bboxB.height / 2;

          // Border-to-border endpoints: leader exits the inset border, stops at node border.
          const [aInsetX, aInsetY] = segmentRectBorderPoint([icx, icy], bboxInset, [acx, acy]);
          const [aNodeX,  aNodeY ] = segmentRectBorderPoint([acx, acy], bboxA,     [icx, icy]);
          const [bInsetX, bInsetY] = segmentRectBorderPoint([icx, icy], bboxInset, [bcx, bcy]);
          const [bNodeX,  bNodeY ] = segmentRectBorderPoint([bcx, bcy], bboxB,     [icx, icy]);

          // Directional strengths (normalised)
          const fwdStrength = anchors.forwardScore  / allMax; // A→B
          const bwdStrength = anchors.backwardScore / allMax; // B→A

          const aStyle = computeRelationLeaderStyle(bwdStrength, styleOpts); // B→A leader
          const bStyle = computeRelationLeaderStyle(fwdStrength, styleOpts); // A→B leader

          // Line widths and dash expressed via CSS calc(var(--invk,1)*Xpx) so they
          // counter-scale live with the annotation layer's matrix transform, avoiding
          // the React-commit lag that causes arrowheads to balloon during scroll-zoom.
          const aThicknessStyle = `calc(var(--invk,1) * ${aStyle.lineWidth}px)`;
          const bThicknessStyle = `calc(var(--invk,1) * ${bStyle.lineWidth}px)`;
          const aOutlineStyle   = `calc(var(--invk,1) * ${aStyle.outlineWidth}px)`;
          const bOutlineStyle   = `calc(var(--invk,1) * ${bStyle.outlineWidth}px)`;

          // Dash array also needs counter-scaling. CSS calc() in style.strokeDasharray
          // applies the live --invk var the same way strokeWidth does.
          const dash =
            relationLeaderDashLength > 0 || relationLeaderDashGap > 0
              ? `calc(var(--invk,1) * ${relationLeaderDashLength}px) calc(var(--invk,1) * ${relationLeaderDashGap}px)`
              : undefined;

          // Arrowheads: unit polygon at origin, placed with CSS transform so zoom applies live.
          const aHasArrow = anchors.backwardScore > 0;
          const bHasArrow = anchors.forwardScore > 0;
          const aArrowAngle = aHasArrow ? arrowAngleDeg([aNodeX, aNodeY], [aInsetX, aInsetY]) : 0;
          const bArrowAngle = bHasArrow ? arrowAngleDeg([bNodeX, bNodeY], [bInsetX, bInsetY]) : 0;
          const aArrowPts = aHasArrow ? unitArrowPoints(aStyle.arrowLength) : "";
          const bArrowPts = bHasArrow ? unitArrowPoints(bStyle.arrowLength) : "";

          // cssScale is still needed for the drop shadow filter.
          const cssScale = cssProp;

          const leaderOpacity = relationSpotlightOpacity(
            anchors.uidA, anchors.uidB, spotlightUids ?? null
          );
          const initialA = { x1: icx, y1: icy, x2: icx, y2: icy, opacity: 0 };
          const animateA = { x1: aInsetX, y1: aInsetY, x2: aNodeX, y2: aNodeY, opacity: leaderOpacity };
          const initialB = { x1: icx, y1: icy, x2: icx, y2: icy, opacity: 0 };
          const animateB = { x1: bInsetX, y1: bInsetY, x2: bNodeX, y2: bNodeY, opacity: leaderOpacity };

          const shadowFilter = computeLeaderShadowFilter(
            relationLeaderShadow,
            relationLeaderShadowIntensity,
            cssScale
          );

          return (
            <React.Fragment key={element.id}>
              {/* A-side: whole assembly in one group so shadow appears behind halo */}
              <g style={{ filter: shadowFilter }}>
                <motion.line
                  key={`${element.id}-a-outline`}
                  initial={initialA}
                  animate={{ ...animateA }}
                  exit={initialA}
                  transition={transition}
                  stroke={canvasBgColor}
                  style={{ strokeWidth: aOutlineStyle }}
                />
                <motion.line
                  key={`${element.id}-a`}
                  initial={initialA}
                  animate={animateA}
                  exit={initialA}
                  transition={transition}
                  stroke={strokeColor}
                  style={{ strokeWidth: aThicknessStyle, strokeDasharray: dash }}
                />
                {aHasArrow && (
                  <motion.g
                    key={`${element.id}-a-arrow`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: leaderOpacity }}
                    exit={{ opacity: 0 }}
                    transition={{ duration, ease: resolvedEase }}
                  >
                    <polygon
                      points={aArrowPts}
                      fill={strokeColor}
                      style={{
                        transform: `translate(${aNodeX}px,${aNodeY}px) rotate(${aArrowAngle}deg) scale(var(--invk,1))`,
                        transformOrigin: "0 0",
                        transformBox: "view-box",
                      }}
                    />
                  </motion.g>
                )}
              </g>

              {/* B-side: whole assembly in one group so shadow appears behind halo */}
              <g style={{ filter: shadowFilter }}>
                <motion.line
                  key={`${element.id}-b-outline`}
                  initial={initialB}
                  animate={{ ...animateB }}
                  exit={initialB}
                  transition={transition}
                  stroke={canvasBgColor}
                  style={{ strokeWidth: bOutlineStyle }}
                />
                <motion.line
                  key={`${element.id}-b`}
                  initial={initialB}
                  animate={animateB}
                  exit={initialB}
                  transition={transition}
                  stroke={strokeColor}
                  style={{ strokeWidth: bThicknessStyle, strokeDasharray: dash }}
                />
                {bHasArrow && (
                  <motion.g
                    key={`${element.id}-b-arrow`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: leaderOpacity }}
                    exit={{ opacity: 0 }}
                    transition={{ duration, ease: resolvedEase }}
                  >
                    <polygon
                      points={bArrowPts}
                      fill={strokeColor}
                      style={{
                        transform: `translate(${bNodeX}px,${bNodeY}px) rotate(${bArrowAngle}deg) scale(var(--invk,1))`,
                        transformOrigin: "0 0",
                        transformBox: "view-box",
                      }}
                    />
                  </motion.g>
                )}
              </g>
            </React.Fragment>
          );
        })}
      </AnimatePresence>
    </svg>
  );
}

export const AnimatedRelationLeaderLines = React.memo(
  RelationLeaderLines,
  (prev, next) =>
    prev.items === next.items &&
    prev.scales.xScale === next.scales.xScale &&
    prev.scales.yScale === next.scales.yScale &&
    prev.canvasWidth === next.canvasWidth &&
    prev.canvasHeight === next.canvasHeight &&
    prev.cssScale === next.cssScale &&
    prev.spotlightUids === next.spotlightUids &&
    prev.hoverUid === next.hoverUid &&
    prev.hoverScale === next.hoverScale
);
