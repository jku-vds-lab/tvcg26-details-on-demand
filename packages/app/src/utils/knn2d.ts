// packages/app/src/utils/knn2d.ts
//
// k-nearest-neighbor graph over 2D coordinates, matching the semantics of the
// offline preprocessing step (public/data/preprocess_dataset_generate_knng.py:
// sklearn NearestNeighbors over df[["x","y"]] — each row lists the k nearest
// point indices, with the point itself first).

import type { KnnGraph } from "../types/graphTypes";

interface Candidate {
  index: number;
  distSq: number;
}

/**
 * Builds the k-nearest-neighbor graph for interleaved 2D coordinates
 * ([x0, y0, x1, y1, ...]) using a uniform grid (expanding ring search).
 * Each row contains the indices of the k nearest points including the point
 * itself (self is always first). When fewer than k points exist, rows are
 * correspondingly shorter.
 */
export function buildKnn2d(coords: Float32Array, k = 5): KnnGraph {
  const n = coords.length / 2;
  if (n === 0) return [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = coords[2 * i];
    const y = coords[2 * i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Cell size targeting ~2 points per cell on average; degenerate extents
  // (single point / all-identical coords) fall back to one cell.
  const width = Math.max(maxX - minX, Number.EPSILON);
  const height = Math.max(maxY - minY, Number.EPSILON);
  const targetCells = Math.max(1, Math.floor(n / 2));
  const cellSize = Math.max(Math.sqrt((width * height) / targetCells), Number.EPSILON);
  const gridW = Math.max(1, Math.min(4096, Math.ceil(width / cellSize)));
  const gridH = Math.max(1, Math.min(4096, Math.ceil(height / cellSize)));
  const cellW = width / gridW;
  const cellH = height / gridH;

  const cellOf = (i: number): number => {
    const cx = Math.min(gridW - 1, Math.floor((coords[2 * i] - minX) / cellW));
    const cy = Math.min(gridH - 1, Math.floor((coords[2 * i + 1] - minY) / cellH));
    return cy * gridW + cx;
  };

  const cells: number[][] = new Array(gridW * gridH);
  for (let i = 0; i < n; i++) {
    const c = cellOf(i);
    (cells[c] ??= []).push(i);
  }

  const kEff = Math.min(k, n);
  const result: KnnGraph = new Array(n);

  for (let i = 0; i < n; i++) {
    const px = coords[2 * i];
    const py = coords[2 * i + 1];
    const cx = Math.min(gridW - 1, Math.floor((px - minX) / cellW));
    const cy = Math.min(gridH - 1, Math.floor((py - minY) / cellH));

    // Collect candidates ring by ring until the kth-best distance is closer
    // than anything a farther ring could contain.
    const best: Candidate[] = [];
    const maxRing = Math.max(gridW, gridH);
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best.length >= kEff) {
        // Points in ring r are at least (r - 1) cells away in the worst case.
        const minPossible = (ring - 1) * Math.min(cellW, cellH);
        if (minPossible > 0 && minPossible * minPossible > best[best.length - 1].distSq) break;
      }

      for (let dy = -ring; dy <= ring; dy++) {
        const gy = cy + dy;
        if (gy < 0 || gy >= gridH) continue;
        for (let dx = -ring; dx <= ring; dx++) {
          // Ring perimeter only (interior was visited by smaller rings).
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const gx = cx + dx;
          if (gx < 0 || gx >= gridW) continue;
          const bucket = cells[gy * gridW + gx];
          if (!bucket) continue;
          for (const j of bucket) {
            const ddx = coords[2 * j] - px;
            const ddy = coords[2 * j + 1] - py;
            insertCandidate(best, kEff, { index: j, distSq: ddx * ddx + ddy * ddy });
          }
        }
      }
    }

    // Self has distance 0 and is therefore always first; ties keep insertion
    // order, and self is encountered in its own cell at ring 0.
    result[i] = best.map((c) => c.index);
    if (result[i][0] !== i) {
      // Guard against coincident points winning the distance-0 tie: force
      // self first (self may even have been crowded out entirely).
      const selfPos = result[i].indexOf(i);
      if (selfPos > 0) result[i].splice(selfPos, 1);
      else if (selfPos === -1) result[i].pop();
      result[i].unshift(i);
    }
  }

  return result;
}

/** Inserts into a small sorted-by-distSq array capped at k entries. */
function insertCandidate(best: Candidate[], k: number, cand: Candidate): void {
  if (best.length >= k && cand.distSq >= best[best.length - 1].distSq) return;
  let lo = 0;
  let hi = best.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (best[mid].distSq <= cand.distSq) lo = mid + 1;
    else hi = mid;
  }
  best.splice(lo, 0, cand);
  if (best.length > k) best.pop();
}
