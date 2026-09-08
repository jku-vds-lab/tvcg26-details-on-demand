// packages/app/src/dataPreprocessing/segmentIndex.ts
//
// Spatial index over columnar segments (issue #315 phase B1). Replaces the
// 775k-item per-segment rbush (object refs) with a 39k-item rbush over EDGES
// (payload = edge index) plus on-demand per-segment refinement from the
// columns. The only consumer contract to honor is the annealer's
// `edgeTree.search(box).length` (segment-hit counting for overlap penalties)
// behind ClusterVisualizations' DoI-threshold filter.

import rbush from "rbush";
import type { DataPoint, RTreeItem } from "./dataPreprocessing";
import { edgeControlIndices, evalEdgeAt, type SegmentColumns } from "./splineColumns";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The minimal searchable surface the annealer consumes. */
export interface SegmentSearchIndex {
  /** Segment indices intersecting `box` (DoI-filtered when built filtered). */
  search(box: BBox): number[];
}

export class EdgeSegmentIndex {
  readonly columns: SegmentColumns;
  /** Canonical point positions — required for virtual columns (issue #315
   * phase B2), whose segment geometry is evaluated on demand. */
  private readonly points: readonly Pick<DataPoint, "x" | "y">[] | null;
  /** Built on FIRST search (issue #315 boot): the eager build (per-edge
   * spline sampling + a 975k-item rbush bulk load) cost seconds of the 1M
   * boot while the annealer may not query for a long time — or ever. */
  private lazyTree: rbush<RTreeItem<number>> | null = null;

  constructor(columns: SegmentColumns, points?: readonly Pick<DataPoint, "x" | "y">[]) {
    this.columns = columns;
    this.points = points ?? null;
    const S = columns.virtualSamplesPerEdge ?? 0;
    if (S > 0 && !points) {
      throw new Error("EdgeSegmentIndex: virtual columns need the points array");
    }
  }

  private ensureTree(): rbush<RTreeItem<number>> {
    if (this.lazyTree) return this.lazyTree;
    const columns = this.columns;
    const points = this.points;
    const S = columns.virtualSamplesPerEdge ?? 0;
    const items: RTreeItem<number>[] = new Array(columns.edgeCount);
    for (let e = 0; e < columns.edgeCount; e++) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (S > 0) {
        // Exact spline bbox, allocation-free: inline Catmull-Rom over the
        // knots (evalEdgeAt allocates a point per call — 20M allocations at
        // 1M edges).
        const [i0, i1, i2, i3] = edgeControlIndices(columns, e);
        const p0 = points![i0], p1 = points![i1], p2 = points![i2], p3 = points![i3];
        for (let s = 0; s <= S; s++) {
          const t = s / S;
          const t2 = t * t;
          const t3 = t2 * t;
          const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
          const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      } else {
        const from = columns.edgeSegOffset[e];
        const to = columns.edgeSegOffset[e + 1];
        for (let s = from; s < to; s++) {
          const x0 = columns.segX0[s], x1 = columns.segX1[s];
          const y0 = columns.segY0[s], y1 = columns.segY1[s];
          if (x0 < minX) minX = x0;
          if (x1 < minX) minX = x1;
          if (x0 > maxX) maxX = x0;
          if (x1 > maxX) maxX = x1;
          if (y0 < minY) minY = y0;
          if (y1 < minY) minY = y1;
          if (y0 > maxY) maxY = y0;
          if (y1 > maxY) maxY = y1;
        }
      }
      items[e] = { minX, minY, maxX, maxY, data: e };
    }
    const tree = new rbush<RTreeItem<number>>();
    tree.load(items);
    this.lazyTree = tree;
    return tree;
  }

  /**
   * A searchable view returning per-segment hits for edges whose current
   * `edgeDoi` exceeds `doiThreshold`. `edgeDoi` is read at query time, so the
   * view stays cheap to construct (no tree rebuild per threshold/selection).
   */
  filtered(doiThreshold: number): SegmentSearchIndex {
    const cols = this.columns;
    const ensure = () => this.ensureTree();
    const points = this.points;
    const S = cols.virtualSamplesPerEdge ?? 0;
    return {
      search(box: BBox): number[] {
        const hits = ensure().search(box);
        const out: number[] = [];
        for (let h = 0; h < hits.length; h++) {
          const e = hits[h].data;
          if (!(cols.edgeDoi[e] > doiThreshold)) continue;
          if (S > 0) {
            // Virtual columns: walk the edge's samples once, testing each
            // chord's bbox — same hits as the materialized refinement.
            let prev = evalEdgeAt(cols, points!, e, 0);
            for (let s = 0; s < S; s++) {
              const next = evalEdgeAt(cols, points!, e, (s + 1) / S);
              const sMinX = prev.x < next.x ? prev.x : next.x;
              const sMaxX = prev.x < next.x ? next.x : prev.x;
              const sMinY = prev.y < next.y ? prev.y : next.y;
              const sMaxY = prev.y < next.y ? next.y : prev.y;
              if (!(sMaxX < box.minX || sMinX > box.maxX || sMaxY < box.minY || sMinY > box.maxY)) {
                out.push(e * S + s);
              }
              prev = next;
            }
            continue;
          }
          const from = cols.edgeSegOffset[e];
          const to = cols.edgeSegOffset[e + 1];
          for (let s = from; s < to; s++) {
            const x0 = cols.segX0[s], x1 = cols.segX1[s];
            const sMinX = x0 < x1 ? x0 : x1;
            const sMaxX = x0 < x1 ? x1 : x0;
            if (sMaxX < box.minX || sMinX > box.maxX) continue;
            const y0 = cols.segY0[s], y1 = cols.segY1[s];
            const sMinY = y0 < y1 ? y0 : y1;
            const sMaxY = y0 < y1 ? y1 : y0;
            if (sMaxY < box.minY || sMinY > box.maxY) continue;
            out.push(s);
          }
        }
        return out;
      },
    };
  }
}

/** An index that never returns hits (empty dataset / pre-load render). */
export const EMPTY_SEGMENT_SEARCH_INDEX: SegmentSearchIndex = {
  search: () => [],
};
