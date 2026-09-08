// packages/app/src/dataPreprocessing/frontierDensityIndex.ts
//
// Frontier-backed density substitute for the annealer's scatter-overlap
// term (issue #315 A2). Server-cut datasets no longer build the client
// point/segment spatial indexes at boot; the only remaining consumer of
// those indexes was the annealer's per-candidate hit count
// (InsetOptimization accumulateRTreeCost). The cut frontier — active
// cluster candidates with data-space bbox + member count, already
// client-resident — approximates the same quantity: hits under a query
// bbox ≈ Σ over intersecting candidates of size × bbox-overlap fraction.
// Coarser than per-point counts (a cluster bbox over-approximates its
// points' coverage), so the hard scatter-overlap penalty errs
// conservative: insets avoid slightly more area than strictly necessary.

interface BBoxLike {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FrontierDensityCandidate {
  bbox?: BBoxLike | null;
  size: number;
}

/**
 * A NodeSearchIndex / EdgeSearchIndex-compatible view over the current cut
 * frontier. `search` answers empty (the annealer consumes only counts via
 * `countIn`; no other consumer receives this index). `getCandidates` is
 * read per query so the view stays live across frontier updates.
 */
export function createFrontierDensityIndex(
  getCandidates: () => ReadonlyArray<FrontierDensityCandidate>
): {
  search(bbox: BBoxLike): never[];
  countIn(bbox: BBoxLike): number;
} {
  return {
    search: () => [],
    countIn(bbox: BBoxLike): number {
      let count = 0;
      for (const c of getCandidates()) {
        const b = c.bbox;
        if (!b) continue;
        // `< 0` (not `<= 0`): a degenerate point-sized candidate inside the
        // query yields exactly-zero extents and must still count.
        const ix = Math.min(bbox.maxX, b.maxX) - Math.max(bbox.minX, b.minX);
        if (ix < 0) continue;
        const iy = Math.min(bbox.maxY, b.maxY) - Math.max(bbox.minY, b.minY);
        if (iy < 0) continue;
        const area = (b.maxX - b.minX) * (b.maxY - b.minY);
        // Degenerate (point-sized) bbox that intersects: count it whole.
        count += area > 0 ? c.size * Math.min(1, (ix * iy) / area) : c.size;
      }
      return count;
    },
  };
}
