// src/utils/midpointObstacles.ts
import type { ObstacleAABB } from "src/hooks/useLayoutEngine";
import type * as d3 from "d3";

/**
 * Build screen-space AABBs for pinned midpoint annotations/insets.
 * For text labels: approximate with font metrics; for inset renderers: use intrinsic bbox.
 */
export function buildMidpointObstacles(args: {
  items: Array<{
    id: string;
    // data-space anchor
    x: number; y: number;
    // either text or intrinsic bbox
    kind: "text" | "inset";
    text?: string;              // when kind==="text"
    fontPx?: number;            // screen px (already scaled by invk)
    insetWidth?: number;        // intrinsic width in px (screen-space)
    insetHeight?: number;       // intrinsic height in px (screen-space)
  }>;
  xScale: d3.ScaleLinear<number,number>;
  yScale: d3.ScaleLinear<number,number>;
}): ObstacleAABB[] {
  const { items, xScale, yScale } = args;
  const out: ObstacleAABB[] = [];
  for (const it of items) {
    const sx = xScale(it.x);
    const sy = yScale(it.y);

    if (it.kind === "text") {
      const font = it.fontPx ?? 14;
      const txt  = it.text ?? "";
      // simple text bbox: ~0.5em per char, 1.1em height
      const w = Math.max(4, txt.length * font * 0.5);
      const h = font * 1.1;
      out.push({ x: sx - w/2, y: sy - h*0.8, width: w, height: h });
    } else {
      const w = it.insetWidth  ?? 16;
      const h = it.insetHeight ?? 16;
      out.push({ x: sx - w/2, y: sy - h/2, width: w, height: h });
    }
  }
  return out;
}

