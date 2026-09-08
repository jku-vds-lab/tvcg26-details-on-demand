// src/utils/serverLasso.ts
//
// Server-side lasso resolution (issue #315 A2): the polygon hit-test moves
// to POST /v1/select (data-space polygon → half-open leaf ranges), and the
// client expands ranges → node ids via the cached leaf order. The local
// linear fallback keeps behavior identical when the server is absent or
// fails mid-session — one O(n) bbox pass, point-in-polygon only on bbox
// survivors, same screen-space semantics as the classic R-tree path.

import type * as d3 from "d3";
import { resolveCutProvider } from "@scaling";
import type { PropagateParams } from "../scaling.types";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import { stashPendingOverlay, stashPendingPolygon } from "../doiPropagation/serverPropagation";
import { ledgerEvent } from "./insetLedger";

export interface ScreenPoint {
  x: number;
  y: number;
}

interface Scales {
  xScale: d3.ScaleLinear<number, number>;
  yScale: d3.ScaleLinear<number, number>;
}

/** Server-side vertex cap is 512; decimating well below it keeps the
 * request small — a lasso's selection is insensitive to sub-pixel vertex
 * detail at this density. */
export const LASSO_MAX_VERTICES = 128;

/** Uniform-stride decimation preserving the first vertex (the polygon is
 * implicitly closed, so the last vertex needs no special casing). */
export function decimatePolygon(
  points: ScreenPoint[],
  maxVertices: number = LASSO_MAX_VERTICES
): ScreenPoint[] {
  if (points.length <= maxVertices) return points;
  const out: ScreenPoint[] = [];
  const stride = points.length / maxVertices;
  for (let i = 0; i < maxVertices; i++) out.push(points[Math.floor(i * stride)]);
  return out;
}

/** Screen polygon → data-space vertices through the same scales + affine
 * zoom inversion the classic hit-test uses. */
export function screenPolygonToData(
  points: ScreenPoint[],
  scales: Scales,
  transform: d3.ZoomTransform
): Array<[number, number]> {
  return points.map((p) => [
    scales.xScale.invert(transform.invertX(p.x)),
    scales.yScale.invert(transform.invertY(p.y)),
  ]);
}

/** Expand half-open leaf ranges to node ids: order[pos] is a dataset index,
 * idOfIndex maps it to the node id. O(|selection|). */
export function expandLeafRangesToIds(
  leafOrder: ArrayLike<number>,
  ranges: Array<[number, number]>,
  idOfIndex: (datasetIndex: number) => number
): number[] {
  const ids: number[] = [];
  for (const [start, end] of ranges) {
    for (let pos = start; pos < end; pos++) ids.push(idOfIndex(leafOrder[pos]));
  }
  return ids;
}

/** Ray-casting point-in-polygon, same algorithm as the lasso behavior's. */
function pointInPoly(px: number, py: number, vs: ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y;
    const xj = vs[j].x, yj = vs[j].y;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Index-free hit-test: screen-space bbox gate over all nodes, PIP only on
 * survivors. Replaces the R-tree prefilter for datasets that no longer
 * build one; result ids match the classic path exactly (same projection,
 * same PIP). */
export function linearPolygonHitTest(
  nodes: DataPoint[],
  scales: Scales,
  transform: d3.ZoomTransform,
  polygonScreen: ScreenPoint[]
): number[] {
  if (polygonScreen.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygonScreen) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const { xScale, yScale } = scales;
  const selected: number[] = [];
  // Columnar hit-test (issue #315 R1b): this is the SERVER lane's own
  // degradation path, so it must work without row objects — and it reads
  // nothing but x/y/id, all of which are canonical columns.
  const cols = columnsOf(nodes);
  if (cols) {
    for (let i = 0; i < cols.count; i++) {
      const sx = transform.applyX(xScale(cols.x[i]));
      const sy = transform.applyY(yScale(cols.y[i]));
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      if (pointInPoly(sx, sy, polygonScreen)) selected.push(cols.id[i]);
    }
    return selected;
  }
  for (const node of nodes) {
    const sx = transform.applyX(xScale(node.x));
    const sy = transform.applyY(yScale(node.y));
    if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
    if (pointInPoly(sx, sy, polygonScreen)) selected.push(node.id);
  }
  return selected;
}

/**
 * Build the lasso resolver injected into createLassoBehavior (issue #315
 * A2). Returns undefined when the active dataset's backend does not offer
 * `select` — the behavior then keeps its classic local path untouched
 * (client-complete datasets stay bit-identical). The resolver itself never
 * rejects: any server failure degrades to the linear local hit-test.
 */
export function buildServerLassoResolver(deps: {
  getNodes: () => DataPoint[];
  getScales: () => Scales | null;
  getZoomTransform: () => d3.ZoomTransform;
  /** Fused server DoI propagation (issue #315 A3 / P-d): when this returns
   * a params block at commit time, the ONE select POST also propagates and
   * the overlay is stashed for the same commit's selection workflow (which
   * then issues zero additional propagation RTTs). `null`/absent keeps the
   * A2 stateless select. */
  getPropagateParams?: () => PropagateParams | null;
}): ((polygonScreen: ScreenPoint[]) => Promise<number[]>) | undefined {
  if (!resolveCutProvider(undefined)?.select) return undefined;
  return async (polygonScreen: ScreenPoint[]): Promise<number[]> => {
    const scales = deps.getScales();
    const transform = deps.getZoomTransform();
    if (!scales) return [];
    const provider = resolveCutProvider(undefined);
    if (provider?.select) {
      try {
        const polygon = screenPolygonToData(
          decimatePolygon(polygonScreen),
          scales,
          transform
        );
        // Fusion is GRAPH-path-only (issue #315 v2): on the field path the
        // JSON values would be the flood payload — the workflow issues the
        // DST1 distance commit instead (still one propagation RTT). Stashes
        // (the field polygon / the fused overlay) carry THIS lasso's
        // resolved ids: the workflow only uses them when the commit's
        // selection is exactly these ids — a ctrl-CHAINED selection is a
        // superset and must seed by ids instead (CS bug 2026-07-24).
        const params = deps.getPropagateParams?.() ?? null;
        // Every client shape is a field shape since #337 PR B — the graph
        // fusion below only serves providers without the DST1 field lane.
        const fieldPath = params?.falloff && !!provider.selectPropagateField;
        const fused = params !== null && !fieldPath && provider.selectPropagate;
        let fusedOverlay: import("../scaling.types").DoiOverlay | null = null;
        const [{ ranges, n }, order] = await Promise.all([
          fused
            ? provider
                .selectPropagate!("points", { polygon }, params!)
                .then((result) => {
                  fusedOverlay = result.overlay;
                  return { ranges: result.ranges, n: result.n };
                })
            : provider.select("points", polygon),
          provider.getLeafOrder("points"),
        ]);
        ledgerEvent(
          fused ? "select:server+doi" : "select:server",
          `n=${n} ranges=${ranges.length}`
        );
        const nodes = deps.getNodes();
        const cols = columnsOf(nodes);
        const ids = expandLeafRangesToIds(order, ranges, (idx) =>
          cols ? cols.id[idx] : nodes[idx].id
        );
        if (fieldPath) stashPendingPolygon(polygon, ids);
        if (fusedOverlay) stashPendingOverlay(fusedOverlay, ids);
        return ids;
      } catch (error) {
        ledgerEvent("select:fallback", String(error));
      }
    }
    return linearPolygonHitTest(
      deps.getNodes(),
      scales,
      transform,
      polygonScreen
    );
  };
}
