// packages/app/src/dataPreprocessing/knnGraph.ts
//
// Exact k-nearest-neighbor graph over 2D points, computed with a uniform
// grid-bucket index (expanding Chebyshev rings). Replaces the offline
// sklearn.neighbors step of preprocess_dataset_generate_knng.py for the
// simple-format loading path. Matches sklearn semantics: each row lists the
// k nearest point indices sorted by ascending distance, with the point
// itself included (distance 0, first entry).

export interface KnnPoint {
  x: number;
  y: number;
}

/**
 * Compute the self-inclusive kNN graph for `points`.
 * Rows are positional indices into `points` (the same convention the DoI
 * propagation expects for `knnGraph`). Row length is min(k, n).
 */
export function computeKnnGraph(points: readonly KnnPoint[], k: number): number[][] {
  const n = points.length;
  if (n === 0) return [];
  const kEff = Math.max(1, Math.min(Math.floor(k), n));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Square cells sized so the average occupancy is ~4 points per cell.
  const extent = Math.max(maxX - minX, maxY - minY);
  const gridDim = Math.max(1, Math.floor(Math.sqrt(n / 4)));
  const cell = extent > 0 ? extent / gridDim : 1;
  const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);

  const cellOf = (p: KnnPoint): [number, number] => {
    const cx = Math.min(cols - 1, Math.floor((p.x - minX) / cell));
    const cy = Math.min(rows - 1, Math.floor((p.y - minY) / cell));
    return [cx, cy];
  };

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const [cx, cy] = cellOf(points[i]);
    const key = cy * cols + cx;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(i);
  }

  const result: number[][] = new Array(n);
  // Scratch best-k arrays, reused across points (k is small).
  const bestIdx = new Array<number>(kEff);
  const bestD2 = new Array<number>(kEff);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const [cx, cy] = cellOf(p);
    let count = 0;

    const consider = (j: number) => {
      const q = points[j];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (count === kEff && d2 >= bestD2[count - 1]) return;
      // Insertion sort into the best-k arrays.
      let pos = count < kEff ? count : kEff - 1;
      while (pos > 0 && bestD2[pos - 1] > d2) {
        bestD2[pos] = bestD2[pos - 1];
        bestIdx[pos] = bestIdx[pos - 1];
        pos--;
      }
      bestD2[pos] = d2;
      bestIdx[pos] = j;
      if (count < kEff) count++;
    };

    const scanBucket = (bx: number, by: number) => {
      if (bx < 0 || by < 0 || bx >= cols || by >= rows) return;
      const bucket = buckets.get(by * cols + bx);
      if (!bucket) return;
      for (let b = 0; b < bucket.length; b++) consider(bucket[b]);
    };

    const maxR = Math.max(cols, rows);
    for (let r = 0; r <= maxR; r++) {
      if (r === 0) {
        scanBucket(cx, cy);
      } else {
        // Chebyshev ring at distance r.
        for (let bx = cx - r; bx <= cx + r; bx++) {
          scanBucket(bx, cy - r);
          scanBucket(bx, cy + r);
        }
        for (let by = cy - r + 1; by <= cy + r - 1; by++) {
          scanBucket(cx - r, by);
          scanBucket(cx + r, by);
        }
      }
      // Any point outside rings 0..r is at least r*cell away, so once the
      // current kth distance is within that radius the result is exact.
      if (count === kEff) {
        const safe = r * cell;
        if (bestD2[count - 1] <= safe * safe) break;
      }
    }

    result[i] = bestIdx.slice(0, count);
  }

  return result;
}
