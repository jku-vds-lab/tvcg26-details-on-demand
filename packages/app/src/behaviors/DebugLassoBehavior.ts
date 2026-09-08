import * as d3 from "d3";
import type rbush from "rbush";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import { InteractionBehavior } from "../types/InteractionBehavior";

interface LassoBehaviorParams {
  overlay: HTMLCanvasElement;
  getNodes: () => DataPoint[];
  getScales: () => { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null;
  getZoomTransform: () => d3.ZoomTransform;
  getRTree: () => rbush<{ minX: number; minY: number; maxX: number; maxY: number; data: DataPoint }> | null;
  /** alt = momentary freehand selection (that one lasso), independent of the mode toggle */
  onComplete: (ids: number[], ctrl: boolean, alt?: boolean) => void;
  /** Server-side hit-test (issue #315 A2, optional): resolves a closed
   * screen-space polygon to node ids. When provided, real lassos await it
   * instead of the local R-tree path; a rejection falls back to the local
   * hit-test. Click-picks (< 3 vertices) always stay local. */
  resolveSelection?: (polygonScreen: { x: number; y: number }[]) => Promise<number[]>;
}

function isInteractionIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  if (target.closest('[data-interaction-ignore="true"]')) return true;

  const interactiveSelector = [
    "input",
    "textarea",
    "select",
    "button",
    "label",
    "option",
    "a",
    "[contenteditable='true']",
    "[role='button']",
  ].join(",");

  return Boolean(target.closest(interactiveSelector));
}

/**
 * Real lasso behavior: draws freeform polygon on overlay,
 * hit-tests via R-tree + point-in-polygon, and calls onComplete.
 */
export function createLassoBehavior(params: LassoBehaviorParams): InteractionBehavior {
  const {
    overlay,
    getNodes,
    getScales,
    getZoomTransform,
    getRTree,
    onComplete,
    resolveSelection,
  } = params;

  let isDrawing = false;
  // Monotonic token: a lasso completing while an older resolveSelection is
  // still in flight invalidates the older result (issue #315 A2).
  let resolveSeq = 0;
  const points: { x: number; y: number }[] = [];
  const ctx = overlay.getContext('2d')!;

  function clearOverlay() {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function drawPolygon() {
    if (points.length < 2) return;
    clearOverlay();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(128,128,128,0.2)';
    ctx.fill();
    ctx.setLineDash([4,4]);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Simple ray-casting for point in polygon
  function pointInPoly(px: number, py: number, vs: { x: number; y: number }[]) {
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

  function pickNearestNodeId(
    sx: number,
    sy: number,
    nodes: DataPoint[],
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    transform: d3.ZoomTransform,
    maxPxDistance: number = 10
  ): number | null {
    let bestId: number | null = null;
    let bestDist2 = maxPxDistance * maxPxDistance;

    // Columnar scan (issue #315 R1a step 6): a plain click walked every row
    // object for three property reads each. Same order, same comparison, same
    // ties (`<=` keeps the LAST nearest node, as before).
    const cols = columnsOf(nodes);
    if (cols) {
      const { x, y, id } = cols;
      for (let i = 0; i < cols.count; i++) {
        const nx = transform.applyX(xScale(x[i]));
        const ny = transform.applyY(yScale(y[i]));
        const dx = nx - sx;
        const dy = ny - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestDist2) {
          bestDist2 = d2;
          bestId = id[i];
        }
      }
      return bestId;
    }

    for (const node of nodes) {
      const nx = transform.applyX(xScale(node.x));
      const ny = transform.applyY(yScale(node.y));
      const dx = nx - sx;
      const dy = ny - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDist2) {
        bestDist2 = d2;
        bestId = node.id;
      }
    }

    return bestId;
  }

  /** The classic local hit-test: click-pick under 3 vertices, else R-tree
   * bbox prefilter + point-in-polygon (full scan when the tree is stale
   * or absent). */
  function localHitTest(polyPts: { x: number; y: number }[]): number[] {
    const nodes = getNodes();
    const scaleObj = getScales();
    const transform = getZoomTransform();
    const tree = getRTree();
    const selected: number[] = [];
    if (scaleObj) {
      const { xScale, yScale } = scaleObj;
      if (polyPts.length < 3) {
        // Click fallback: pick nearest visible node for single selection.
        const clickPoint = polyPts[0];
        const picked = pickNearestNodeId(
          clickPoint.x,
          clickPoint.y,
          nodes,
          xScale,
          yScale,
          transform
        );
        if (picked !== null) selected.push(picked);
      } else {
        // Prefilter candidates with the world-space R-tree: only nodes whose
        // (padded) bbox intersects the polygon's bounding box can lie inside
        // the polygon. Linear scales + the affine zoom transform map the
        // screen-space bbox to an axis-aligned world-space bbox (min/max both
        // corners because yScale is typically range-inverted).
        let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
        for (const p of polyPts) {
          if (p.x < sMinX) sMinX = p.x;
          if (p.y < sMinY) sMinY = p.y;
          if (p.x > sMaxX) sMaxX = p.x;
          if (p.y > sMaxY) sMaxY = p.y;
        }
        const wxA = xScale.invert(transform.invertX(sMinX));
        const wxB = xScale.invert(transform.invertX(sMaxX));
        const wyA = yScale.invert(transform.invertY(sMinY));
        const wyB = yScale.invert(transform.invertY(sMaxY));
        // Guard against a stale tree during dataset switches (the ref keeps
        // the previous dataset's tree until the new index finishes building)
        // and against datasets that build no index at all (issue #315 A2):
        // when sizes disagree or no tree exists, hit-test every node directly.
        const candidates =
          tree && tree.all().length === nodes.length
            ? tree
                .search({
                  minX: Math.min(wxA, wxB),
                  minY: Math.min(wyA, wyB),
                  maxX: Math.max(wxA, wxB),
                  maxY: Math.max(wyA, wyB),
                })
                .map((item) => item.data)
            : nodes;
        for (const node of candidates) {
          // world -> screen
          const sx = transform.applyX(xScale(node.x));
          const sy = transform.applyY(yScale(node.y));
          if (pointInPoly(sx, sy, polyPts)) selected.push(node.id);
        }
      }
    }

    return selected;
  }

  return {
    filter: e => e.button === 0 && !isInteractionIgnoredTarget(e.target),

    onStart: e => {
      overlay.setPointerCapture(e.pointerId);
      isDrawing = true;
      // A new stroke supersedes any still-in-flight server resolution.
      resolveSeq++;
      points.length = 0;
      const rect = overlay.getBoundingClientRect();
      points.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    },

    onMove: e => {
      if (!isDrawing) return;
      const rect = overlay.getBoundingClientRect();
      points.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      drawPolygon();
    },

    onEnd: e => {
      overlay.releasePointerCapture(e.pointerId);
      if (!isDrawing) return;
      isDrawing = false;
      // close and redraw
      drawPolygon();

      // Server-side hit-test (issue #315 A2): real lassos resolve async;
      // the ctrl/alt modifiers are captured now, the completion fires when
      // the resolver answers (or falls back locally on rejection).
      if (resolveSelection && points.length >= 3) {
        const poly = points.slice();
        const { ctrlKey, altKey } = e;
        const token = ++resolveSeq;
        clearOverlay();
        resolveSelection(poly)
          .then((ids) => {
            if (token === resolveSeq) onComplete(ids, ctrlKey, altKey);
          })
          .catch(() => {
            if (token === resolveSeq) onComplete(localHitTest(poly), ctrlKey, altKey);
          });
        return;
      }

      clearOverlay();
      onComplete(localHitTest(points), e.ctrlKey, e.altKey);
    },
  };
}
