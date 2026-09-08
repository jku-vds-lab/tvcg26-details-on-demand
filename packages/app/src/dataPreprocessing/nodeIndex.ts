// packages/app/src/dataPreprocessing/nodeIndex.ts
//
// DoI-filtered searchable VIEW over the shared all-point rbush (issue #315
// scaling). Replaces a render-time `rTree.all().filter(...) + new RBush().load()`
// that rebuilt a full 1M-point tree on every threshold change — a single
// ~2.5 s main-thread block. This view instead filters candidates at query
// time, so it is O(1) to construct. Mirrors `SegmentSearchIndex.filtered` in
// segmentIndex.ts (same query-time-filter pattern over a shared index).

import type RBush from "rbush";
import type { BBox } from "rbush";
import type { DataPoint, RTreeItem } from "./dataPreprocessing";

/** The minimal searchable surface the annealer consumes for node density. */
export interface NodeSearchIndex {
  /** Node items intersecting `bbox` whose DoI exceeds the built threshold. */
  search(bbox: BBox): RTreeItem<DataPoint>[];
  /** Optional hit count without materializing items (issue #315 A2) —
   * provided by the frontier density substitute on server-cut datasets;
   * the annealer prefers it over search().length. */
  countIn?(bbox: BBox): number;
}

/**
 * A DoI-filtered view over `rTree`. `search` resolves candidates from the
 * shared tree and keeps only those above `doiThreshold`. DoI is read per
 * query on purpose: DoI values mutate in place, so a live read stays correct
 * where the old snapshot (built once per threshold change) went stale.
 * Predicate is `>` (strict), matching the retired inline filter exactly.
 */
export function createDoiFilteredNodeIndex(
  rTree: RBush<RTreeItem<DataPoint>>,
  doiThreshold: number
): NodeSearchIndex {
  return {
    search(bbox: BBox): RTreeItem<DataPoint>[] {
      return rTree.search(bbox).filter((item) => item.data.DoI > doiThreshold);
    },
  };
}
