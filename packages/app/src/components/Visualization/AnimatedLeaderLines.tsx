import * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React from "react";
import { useSelector } from "react-redux";
import { useLayout } from "src/layout/layoutStore";
import type { ClusterConvexHull } from "src/models/ClusterConvexHull";
import { parseClusterUid, type VisualElement } from "src/models/VisualElement";
import { LeaderLineConnector } from "src/services/leaderLineConnector";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { spotlightOpacity } from "src/utils/spotlightDim";
import { computeLeaderShadowFilter } from "./leaderShadow";

interface Props {
  items: { element: VisualElement; hull: ClusterConvexHull }[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  canvasWidth: number;
  canvasHeight: number;
  /** Live counter-scale (1/k). Passed explicitly (issue #345) so leader anchors are
   *  computed against the hull padded for the CURRENT zoom — the hull's stored
   *  currentCssScale is only corrected by an effect after this render committed —
   *  and so the memo comparator re-renders leaders when the settled zoom changes
   *  (position changes are otherwise their only re-render trigger). */
  cssScale: number;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Leaders whose cluster uid is not in this set fade to SPOTLIGHT_DIM. Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

function LeaderLines({ items, scales, canvasWidth, canvasHeight, cssScale, spotlightUids }: Props) {
  const { positions } = useLayout();
  const {
    leaderGray,
    leaderOutlineThickness,
    leaderThickness,
    leaderDashLength,
    leaderDashGap,
    leaderShadow,
    leaderShadowIntensity,
    duration,
    ease,
  } = useSelector((s: RootState) => s.clusterSettings);
  const canvasBgColor = useSelector((s: RootState) => s.visualizationSettings.canvasBgColor);

  const strokeColor = `rgb(${Math.round(leaderGray * 255)},${Math.round(
    leaderGray * 255
  )},${Math.round(leaderGray * 255)})`;

  const transition = React.useMemo(() => {
    const resolved = resolveEase(ease);
    return {
      x1: { duration, ease: resolved },
      y1: { duration, ease: resolved },
      x2: { duration, ease: resolved },
      y2: { duration, ease: resolved },
      opacity: { duration, ease: resolved },
    };
  }, [duration, ease]);

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
        {items.map(({ element, hull }) => {
          const pos = positions.get(element.id) ?? element.center;
          if (
            hull.hullPoints &&
            d3.polygonContains(hull.hullPoints, [pos.x, pos.y])
          ) {
            return null;
          }

          const { x1, y1, x2, y2 } = LeaderLineConnector.compute(
            element,
            hull,
            scales.xScale,
            scales.yScale,
            positions,
            cssScale
          );
          // Use CSS calc(var(--invk,1)*Xpx) so widths counter-scale live with the
          // annotation layer's matrix — same pattern as AnimatedRelationLeaderLines.tsx.
          const dash =
            leaderDashLength > 0 || leaderDashGap > 0
              ? `calc(var(--invk,1) * ${leaderDashLength}px) calc(var(--invk,1) * ${leaderDashGap}px)`
              : undefined;

          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          const initial = { x1: midX, y1: midY, x2: midX, y2: midY, opacity: 0 };
          const leaderOpacity = spotlightOpacity(parseClusterUid(element.id), spotlightUids ?? null);
          const animate = { x1, y1, x2, y2, opacity: leaderOpacity };

          const shadowFilter = computeLeaderShadowFilter(
            leaderShadow,
            leaderShadowIntensity,
            element.currentCssScale
          );

          return (
            <React.Fragment key={element.id}>
              {/* whole assembly in one group so shadow appears behind both halo and line */}
              <g style={{ filter: shadowFilter }}>
                <motion.line
                  initial={initial}
                  animate={animate}
                  exit={initial}
                  transition={transition}
                  stroke={canvasBgColor}
                  style={{ strokeWidth: `calc(var(--invk,1) * ${leaderOutlineThickness}px)` }}
                />
                <motion.line
                  initial={initial}
                  animate={animate}
                  exit={initial}
                  transition={transition}
                  stroke={strokeColor}
                  style={{
                    strokeWidth: `calc(var(--invk,1) * ${leaderThickness}px)`,
                    strokeDasharray: dash,
                  }}
                />
              </g>
            </React.Fragment>
          );
        })}
      </AnimatePresence>
    </svg>
  );
}

export const AnimatedLeaderLines = React.memo(
  LeaderLines,
  (prev, next) =>
    prev.items === next.items &&
    prev.scales.xScale === next.scales.xScale &&
    prev.scales.yScale === next.scales.yScale &&
    prev.canvasWidth === next.canvasWidth &&
    prev.canvasHeight === next.canvasHeight &&
    prev.cssScale === next.cssScale &&
    prev.spotlightUids === next.spotlightUids
);