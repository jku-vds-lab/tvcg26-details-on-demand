// packages/app/src/dataPreprocessing/pointGridIndex.ts
//
// Uniform-grid point index (issue #315 boot). Replaces the eager 1M-point
// rbush bulk load in usePrepareDatasetRefs: the rbush OMT load
// (compareMinX/compareMinY/quickselect) is a single un-chunkable synchronous
// pass that cost seconds of main-thread CPU at 1M points. Binning point
// indices into a uniform grid is O(n) with no comparators, so the build
// splits into chunked passes that each yield under ~50 ms — and, unlike a
// lazy first-query rbush build, the index is ready before the first lasso /
// viewport query so no multi-hundred-ms hitch appears later either.
//
// The facade exposes EXACTLY the two rbush methods the point-tree consumers
// call (`.search(box)` in ClusterVisualizations' viewport query and
// DebugLassoBehavior's lasso prefilter; `.all()` in filteredNodeTree and the
// lasso stale-tree guard) and is cast to the rbush type like the sibling
// `lazyMidpointRTree` facade in usePrepareDatasetRefs.

import type rbush from "rbush";
import type { DataPoint, RTreeItem } from "./dataPreprocessing";

// Matches the padding the old buildPointRTreeChunked stored around each point.
const PADDING = 0.5;
// Target average cell occupancy — keeps ~64-256 points/cell at 1M so a
// viewport/lasso query touches few cells while the grid stays small.
const TARGET_OCCUPANCY = 128;
const BUILD_BATCH_POINTS = 2500;

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const yieldToMainThread = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

/**
 * Search-only + `.all()` uniform-grid facade over dataset points, shaped and
 * cast so it is a drop-in for the rbush the consumers expect.
 *
 * @param points Dataset points (already id/DoI initialized).
 * @param signal Abort signal honored between chunks, like the callers' other
 *   chunked builds.
 */
export async function buildPointGridIndexChunked(
  points: DataPoint[],
  signal?: AbortSignal
): Promise<rbush<RTreeItem<DataPoint>>> {
  const n = points.length;

  // Pass 1 (chunked): data extent.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let start = 0; start < n; start += BUILD_BATCH_POINTS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(n, start + BUILD_BATCH_POINTS);
    for (let i = start; i < end; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    await yieldToMainThread();
  }
  if (n === 0) {
    minX = minY = maxX = maxY = 0;
  }

  const width = maxX - minX;
  const height = maxY - minY;

  // Grid dimensions: aim for ~TARGET_OCCUPANCY points/cell, split across the
  // two axes proportional to the extent's aspect ratio. Collapsed extents
  // (all points on a line / a single point) degrade to a 1-wide strip.
  const targetCells = Math.max(1, Math.ceil(n / TARGET_OCCUPANCY));
  let cols: number;
  let rows: number;
  if (width <= 0 && height <= 0) {
    cols = 1;
    rows = 1;
  } else if (width <= 0) {
    cols = 1;
    rows = targetCells;
  } else if (height <= 0) {
    cols = targetCells;
    rows = 1;
  } else {
    const aspect = width / height;
    cols = Math.max(1, Math.round(Math.sqrt(targetCells * aspect)));
    rows = Math.max(1, Math.ceil(targetCells / cols));
  }
  // cellW/cellH map a coordinate to a cell; binning and search MUST use the
  // same scale or a wide single-column grid would early-out on valid queries.
  // A collapsed axis (extent 0) uses width 1 so the math stays finite (every
  // point then clamps into column/row 0).
  const cellW = width > 0 ? width / cols : 1;
  const cellH = height > 0 ? height / rows : 1;

  const cellOf = (x: number, y: number): number => {
    let cx = Math.floor((x - minX) / cellW);
    let cy = Math.floor((y - minY) / cellH);
    if (cx < 0) cx = 0;
    else if (cx >= cols) cx = cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= rows) cy = rows - 1;
    return cy * cols + cx;
  };

  // Pass 2 (chunked): materialize items and bin their indices. Items store the
  // padded bounds verbatim (p.x ± 0.5) so search reproduces rbush's float math.
  const items: RTreeItem<DataPoint>[] = new Array(n);
  const cells: number[][] = new Array(cols * rows);
  for (let start = 0; start < n; start += BUILD_BATCH_POINTS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(n, start + BUILD_BATCH_POINTS);
    for (let i = start; i < end; i++) {
      const p = points[i];
      items[i] = {
        minX: p.x - PADDING,
        minY: p.y - PADDING,
        maxX: p.x + PADDING,
        maxY: p.y + PADDING,
        data: p,
      };
      const c = cellOf(p.x, p.y);
      (cells[c] ?? (cells[c] = [])).push(i);
    }
    await yieldToMainThread();
  }

  const search = (box: BBox): RTreeItem<DataPoint>[] => {
    const result: RTreeItem<DataPoint>[] = [];
    if (n === 0) return result;
    // A point matches iff its padded box intersects `box`. Its center then
    // lies within `box` inflated by PADDING, so only cells overlapping that
    // inflated range can hold hits.
    const loX = box.minX - PADDING;
    const hiX = box.maxX + PADDING;
    const loY = box.minY - PADDING;
    const hiY = box.maxY + PADDING;
    let cxLo = Math.floor((loX - minX) / cellW);
    let cxHi = Math.floor((hiX - minX) / cellW);
    let cyLo = Math.floor((loY - minY) / cellH);
    let cyHi = Math.floor((hiY - minY) / cellH);
    if (cxLo < 0) cxLo = 0;
    if (cyLo < 0) cyLo = 0;
    if (cxHi >= cols) cxHi = cols - 1;
    if (cyHi >= rows) cyHi = rows - 1;
    if (cxHi < 0 || cyHi < 0 || cxLo >= cols || cyLo >= rows) return result;

    for (let cy = cyLo; cy <= cyHi; cy++) {
      const rowBase = cy * cols;
      for (let cx = cxLo; cx <= cxHi; cx++) {
        const cell = cells[rowBase + cx];
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const it = items[cell[k]];
          // rbush's exact (inclusive) intersection test on the stored bounds.
          if (
            box.minX <= it.maxX &&
            box.maxX >= it.minX &&
            box.minY <= it.maxY &&
            box.maxY >= it.minY
          ) {
            result.push(it);
          }
        }
      }
    }
    return result;
  };

  const facade = {
    search,
    all: () => items,
  };
  return facade as unknown as rbush<RTreeItem<DataPoint>>;
}
