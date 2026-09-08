// in src/services/LeaderLineConnector.ts
import type { ClusterConvexHull } from "src/models/ClusterConvexHull";
import type { LeaderLineGeometry, VisualElement } from "src/models/VisualElement";
import { closestPointOnPolygon } from "src/utils/geometryUtils";
import type { Pos } from "src/layout/layoutStore";

export class LeaderLineConnector {
  /**
   * `cssScale` must be the live 1/k when the caller knows it (issue #345):
   * the hull's stored currentCssScale is only corrected by an effect after
   * the commit that already baked this geometry, so anchoring on the
   * field-padded hull aims the leader at a phantom border scaled for an
   * earlier zoom level (same staleness family as issue #265 for the drawn
   * contour). The default keeps legacy callers unchanged.
   */
  static compute(
    el: VisualElement,
    hull: ClusterConvexHull,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    positions: Map<string, Pos>,
    cssScale: number = hull.currentCssScale
  ): LeaderLineGeometry {
    const poly = hull.getScreenHull(xScale, yScale, cssScale);
    const pos = positions.get(el.id) ?? el.center;
    if (poly.length > 1) {
      const center = [xScale(pos.x), yScale(pos.y)] as [number, number];
      const [x1, y1] = closestPointOnPolygon(poly, center);
      return { x1, y1, x2: center[0], y2: center[1] };
    }
    return {
      x1: xScale(el.sourcePosition.x),
      y1: yScale(el.sourcePosition.y),
      x2: xScale(pos.x),
      y2: yScale(pos.y),
    };
  }
}
