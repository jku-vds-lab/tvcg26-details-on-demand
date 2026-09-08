import * as d3 from "d3";
import { AnimatePresence, motion } from "framer-motion";
import React, { useMemo } from "react";
import { useSelector } from "react-redux";
import type { ClusterConvexHull } from "src/models/ClusterConvexHull";
import { parseClusterUid } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { spotlightOpacity } from "src/utils/spotlightDim";

export interface AnimatedConvexHullItemsProps {
  hulls: ClusterConvexHull[];
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  canvasWidth: number;
  canvasHeight: number;
  /** Live counter-scale (1/k). Passed explicitly so the very first render of a
   *  freshly created hull pads with the real zoom scale instead of the hull's
   *  constructor-default currentCssScale of 1, which the setCssScale effect
   *  only corrects after this component has already baked the path (issue #265). */
  cssScale: number;
  /** When a D2 diff-inset spotlight is active, the two endpoint cluster uids.
   *  Contours whose cluster uid is not in this set fade to SPOTLIGHT_DIM. Null = no spotlight. */
  spotlightUids?: ReadonlySet<string> | null;
}

export const AnimatedConvexHullItems = React.memo(function AnimatedConvexHullItems({
  hulls,
  scales,
  canvasWidth,
  canvasHeight,
  cssScale,
  spotlightUids,
}: AnimatedConvexHullItemsProps) {
  const {
    contourThickness,
    contourGray,
    contourStippling,
    contourOutlineThickness,
    hullSplineAlpha,
    duration,
    ease,
  } = useSelector((s: RootState) => s.clusterSettings);
  const canvasBgColor = useSelector((s: RootState) => s.visualizationSettings.canvasBgColor);

  const transition = React.useMemo(
    () => ({ default: { duration, ease: resolveEase(ease) } }),
    [duration, ease]
  );

  const strokeGray = Math.round(contourGray * 255);
  const strokeColor = `rgb(${strokeGray},${strokeGray},${strokeGray})`;

  // Precompute hull paths. uid is stored so the render loop can compute
  // spotlight opacity without an extra Map lookup.
  const items = useMemo(() => {
    return hulls
      .map(hull => {
        if (!hull.hullPoints) return null;
        const pts = hull.getScreenHull(scales.xScale, scales.yScale, cssScale);
        if (pts.length === 0) return null;

        const cx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
        const cy = pts.reduce((s, [, y]) => s + y, 0) / pts.length;

        const d = d3
          .line<[number, number]>()
          .curve(d3.curveCatmullRomClosed.alpha(hullSplineAlpha))
          .x(p => p[0])
          .y(p => p[1])(pts)!;

        return { id: hull.id, uid: parseClusterUid(hull.id), d, cx, cy };
      })
      .filter(Boolean) as Array<{
        id: string;
        uid: string;
        d: string;
        cx: number;
        cy: number;
      }>;
  }, [hulls, scales, hullSplineAlpha, cssScale]);

  return (
    <motion.svg
      width={canvasWidth}
      height={canvasHeight}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        pointerEvents: "none",
        overflow: "visible",
      }}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={transition}
    >
      <AnimatePresence>
        {items.map(({ id, uid, d, cx, cy }) => {
          // Use CSS calc(var(--invk,1)*Xpx) so stroke widths counter-scale live with the
          // annotation layer's matrix transform (set every zoom frame in App.tsx via
          // --invk = 1/k). This prevents the "balloon-and-freeze" bug that occurred when
          // the baked `currentCssScale * thickness` value went stale between React renders.
          const dash =
            contourStippling > 0
              ? `calc(var(--invk,1) * ${contourStippling}px) calc(var(--invk,1) * ${contourStippling}px)`
              : undefined;

          return (
            <motion.g
              key={id}
              style={{ transformOrigin: `${cx}px ${cy}px` }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: spotlightOpacity(uid, spotlightUids ?? null), scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={transition}
            >
              <path
                d={d}
                fill="none"
                stroke={canvasBgColor}
                style={{ strokeWidth: `calc(var(--invk,1) * ${contourOutlineThickness}px)` }}
              />
              <path
                d={d}
                fill="none"
                stroke={strokeColor}
                style={{
                  strokeWidth: `calc(var(--invk,1) * ${contourThickness}px)`,
                  strokeDasharray: dash,
                }}
              />
            </motion.g>
          );
        })}
      </AnimatePresence>
    </motion.svg>
  );
},
// shallow‐compare only what matters
(prev, next) =>
  prev.hulls === next.hulls &&
  prev.scales.xScale === next.scales.xScale &&
  prev.scales.yScale === next.scales.yScale &&
  prev.canvasWidth === next.canvasWidth &&
  prev.canvasHeight === next.canvasHeight &&
  prev.cssScale === next.cssScale &&
  prev.spotlightUids === next.spotlightUids
);