// packages/app/src/doiPropagation/fieldDistanceCore.ts
//
// Client-side distance-field production for provider-less builds (issue #315
// field parity). Port of doi_field.py's barrier-free fast path — the ONLY
// regime the shipped product can reach (`maxEmbeddingDistance` has no UI
// control and is deep-link-excluded, so the traversable mask is always the
// whole grid; plan-315-field-parity.md §8 D1). Produces
// `residentField.recordDist`: record-order distances from the seed set, in
// metric (embedding) units, +Infinity = unreachable, cast to Float32Array
// EXACTLY ONCE at the end — the same quantization point as the server wire.
//
// Pure and worker-safe: no DOM, no imports. Mirrors doi_field.py operation
// for operation (rounding mode, clip bounds, lerp order) so the parity
// fixture can hold the two sides to near-bitwise agreement:
//   _rasterize        -> rasterize        (np.round = round-half-to-even)
//   distance_transform_edt -> edtSquared  (exact: row sweep + column
//                                          lower-envelope, INF-safe)
//   fast path of _geodesic_from_seeds -> seedDistanceGrid (sqrt * cellSize)
//   _bilinear_sample  -> bilinearSampleDist (same in-place lerp order,
//                                          isfinite guard -> nearest cell)

/** Server-equal default; doi_field.py's `grid_resolution` (not wire-exposed). */
export const FIELD_GRID_RESOLUTION = 1024;

export interface FieldRaster {
  /** Per-point integer cell coords (rounded fractional coords, clipped ≥ 0). */
  rows: Int32Array;
  cols: Int32Array;
  /** Per-point fractional grid coords (same transform, no rounding). */
  frows: Float64Array;
  fcols: Float64Array;
  W: number;
  H: number;
  /** Uniform square cell size in metric units. */
  cellSize: number;
}

/** numpy's rint semantics for non-negative v: round half to EVEN (np.round),
 * where JS Math.round rounds half up. Grid-aligned synthetic data lands on
 * exact .5 fractions, so the difference flips cell assignment. */
function roundHalfEven(v: number): number {
  const r = Math.round(v);
  return v - Math.floor(v) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Map points onto a uniform square-cell grid — doi_field._rasterize. Cell size
 * is uniform on both axes so grid distance × cellSize is a metric distance;
 * `gridResolution` cells span the longer axis.
 */
export function rasterize(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  gridResolution: number
): FieldRaster {
  const n = x.length;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = x[i];
    const py = y[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const rx = Math.max(maxX - minX, 1e-12);
  const ry = Math.max(maxY - minY, 1e-12);
  const cellSize = Math.max(rx, ry) / Math.max(gridResolution - 1, 1);

  const frows = new Float64Array(n);
  const fcols = new Float64Array(n);
  const rows = new Int32Array(n);
  const cols = new Int32Array(n);
  let maxR = 0;
  let maxC = 0;
  for (let i = 0; i < n; i++) {
    const fc = (x[i] - minX) / cellSize;
    const fr = (y[i] - minY) / cellSize;
    fcols[i] = fc;
    frows[i] = fr;
    const c = Math.max(roundHalfEven(fc), 0);
    const r = Math.max(roundHalfEven(fr), 0);
    cols[i] = c;
    rows[i] = r;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { rows, cols, frows, fcols, W: maxC + 1, H: maxR + 1, cellSize };
}

/**
 * Exact squared Euclidean distance transform to the nearest seed cell
 * (`seed[r*W+c] != 0`), Infinity where no seed exists. Two separable passes:
 * per-row nearest-seed-in-row by twin linear sweeps (integer cell distances),
 * then a per-column Felzenszwalb–Huttenlocher lower envelope over those
 * squared row distances — INF-safe by skipping seedless rows' parabolas.
 */
export function edtSquared(seed: Uint8Array, W: number, H: number): Float64Array {
  // Pass 1: g[r][c] = |c - c_seed| within the row (Infinity if none).
  const g = new Float64Array(W * H);
  for (let r = 0; r < H; r++) {
    const base = r * W;
    let d = Infinity;
    for (let c = 0; c < W; c++) {
      d = seed[base + c] !== 0 ? 0 : d + 1;
      g[base + c] = d;
    }
    d = Infinity;
    for (let c = W - 1; c >= 0; c--) {
      d = seed[base + c] !== 0 ? 0 : d + 1;
      const i = base + c;
      if (d < g[i]) g[i] = d;
    }
  }

  // Pass 2: per column, D²(r) = min over r' of (r - r')² + g(r')².
  const out = new Float64Array(W * H);
  const v = new Int32Array(H); // parabola apexes (row indices)
  const z = new Float64Array(H + 1); // envelope boundaries
  const f = new Float64Array(H); // g² for this column
  for (let c = 0; c < W; c++) {
    for (let r = 0; r < H; r++) {
      const rowDist = g[r * W + c];
      f[r] = rowDist === Infinity ? Infinity : rowDist * rowDist;
    }
    let k = -1; // index of the rightmost parabola in the envelope
    for (let q = 0; q < H; q++) {
      if (f[q] === Infinity) continue;
      if (k < 0) {
        k = 0;
        v[0] = q;
        z[0] = -Infinity;
        z[1] = Infinity;
        continue;
      }
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    if (k < 0) {
      for (let r = 0; r < H; r++) out[r * W + c] = Infinity;
      continue;
    }
    let j = 0;
    for (let r = 0; r < H; r++) {
      while (z[j + 1] < r) j++;
      const dr = r - v[j];
      out[r * W + c] = dr * dr + f[v[j]];
    }
  }
  return out;
}

/**
 * Metric-unit distance grid from the seed cells — the
 * doi_field._geodesic_from_seeds fast path (exact EDT, offsets 0):
 * per cell sqrt of the squared transform, times cellSize.
 */
export function seedDistanceGrid(
  seedRows: ArrayLike<number>,
  seedCols: ArrayLike<number>,
  W: number,
  H: number,
  cellSize: number
): Float64Array {
  const seed = new Uint8Array(W * H);
  for (let i = 0; i < seedRows.length; i++) {
    seed[seedRows[i] * W + seedCols[i]] = 1;
  }
  const sq = edtSquared(seed, W, H);
  const grid = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    grid[i] = Math.sqrt(sq[i]) * cellSize;
  }
  return grid;
}

/**
 * Bilinearly interpolate a distance grid at one fractional position —
 * doi_field._bilinear_sample, same clamped coords and lerp op order. INF
 * GUARD: when any of the 4 corners is non-finite the IEEE arithmetic poisons
 * the lerp, and the nearest-cell value is returned instead (infinity is never
 * blended into a finite distance).
 */
export function bilinearSampleDist(
  grid: Float64Array,
  W: number,
  H: number,
  frow: number,
  fcol: number,
  nearRow: number,
  nearCol: number
): number {
  const fr = Math.min(Math.max(frow, 0), H - 1);
  const fc = Math.min(Math.max(fcol, 0), W - 1);
  const r0 = Math.floor(fr);
  const c0 = Math.floor(fc);
  const r1 = Math.min(r0 + 1, H - 1);
  const c1 = Math.min(c0 + 1, W - 1);
  const tr = fr - r0;
  const tc = fc - c0;
  const v00 = grid[r0 * W + c0];
  const v01 = grid[r0 * W + c1];
  const v10 = grid[r1 * W + c0];
  const v11 = grid[r1 * W + c1];
  // Same sequence as the python in-place lerps: top = lerp(v00, v01, tc),
  // bot = lerp(v10, v11, tc), out = lerp(top, bot, tr).
  const top = (v01 - v00) * tc + v00;
  const bot = (v11 - v10) * tc + v10;
  const out = (bot - top) * tr + top;
  if (!isFinite(out)) return grid[nearRow * W + nearCol];
  return out;
}

/**
 * Multi-source OFFSET distance grid for the converged alternation's re-spread
 * rounds: C*(x) = min over sources j of (offset_j + chamfer(x, j)), where
 * offset_j = f⁻¹(v_j) is the metric distance a chain-raised state re-enters
 * the falloff at. Computed as the classic TWO-PASS chamfer sweep (forward
 * scan with the causal half of the 8-connected 3×3 mask, backward scan with
 * the anti-causal half; weights cellSize and cellSize·√2). On a barrier-free
 * grid — the client lane's only regime — this is EXACT for the chamfer
 * metric: any chamfer-optimal path reorders into a causal prefix + an
 * anti-causal suffix without leaving the grid, and per-source additive
 * offsets just initialize the sweep. A multi-source Dijkstra with the same
 * mask computes the identical function (the jest twin asserts this); the
 * sweep is O(N) with no queue.
 *
 * Sources sharing a cell enter at the MIN of their offsets (the strongest
 * co-cell source wins — min-plus composition, never additive). Cells whose
 * best distance exceeds `maxDist` are set to +Infinity: past that distance
 * the falloff is at or below the convergence floor, and the +Infinity keeps
 * `bilinearSampleDist`'s inf-guard semantics identical to a pruned solver.
 * Returns a (H·W) float64 grid in metric units, +Infinity = never reached.
 * Pure and worker-safe (no imports), like the rest of this module.
 */
export function respreadDistanceSweep(
  W: number,
  H: number,
  cellSize: number,
  seedRows: ArrayLike<number>,
  seedCols: ArrayLike<number>,
  seedOffsets: ArrayLike<number>,
  maxDist: number,
  /** Optional reusable grid buffer (drag previews run this at ~10 Hz; a
   * fresh multi-MB Float64Array per round would churn the GC mid-drag).
   * Used when its length matches W·H, re-initialized here either way. */
  out?: Float64Array
): Float64Array {
  const size = W * H;
  const dist = out && out.length === size ? out.fill(Infinity) : new Float64Array(size).fill(Infinity);
  const straight = cellSize;
  const diag = Math.SQRT2 * cellSize;

  for (let j = 0; j < seedRows.length; j++) {
    const c = seedRows[j] * W + seedCols[j];
    const o = seedOffsets[j];
    if (o < dist[c]) dist[c] = o;
  }

  // Forward pass: causal mask half — predecessors W, NW, N, NE.
  for (let r = 0; r < H; r++) {
    const base = r * W;
    for (let c = 0; c < W; c++) {
      const i = base + c;
      let d = dist[i];
      if (r > 0) {
        const up = i - W;
        if (c > 0) { const nd = dist[up - 1] + diag; if (nd < d) d = nd; }
        { const nd = dist[up] + straight; if (nd < d) d = nd; }
        if (c < W - 1) { const nd = dist[up + 1] + diag; if (nd < d) d = nd; }
      }
      if (c > 0) { const nd = dist[i - 1] + straight; if (nd < d) d = nd; }
      dist[i] = d;
    }
  }

  // Backward pass: anti-causal mask half — predecessors E, SE, S, SW.
  for (let r = H - 1; r >= 0; r--) {
    const base = r * W;
    for (let c = W - 1; c >= 0; c--) {
      const i = base + c;
      let d = dist[i];
      if (r < H - 1) {
        const down = i + W;
        if (c < W - 1) { const nd = dist[down + 1] + diag; if (nd < d) d = nd; }
        { const nd = dist[down] + straight; if (nd < d) d = nd; }
        if (c > 0) { const nd = dist[down - 1] + diag; if (nd < d) d = nd; }
      }
      if (c < W - 1) { const nd = dist[i + 1] + straight; if (nd < d) d = nd; }
      dist[i] = d;
    }
  }

  // Futility crop: beyond maxDist the falloff is sub-floor dust; +Infinity
  // (not a large finite value) so bilinear sampling falls back to the
  // nearest cell exactly as it would beside a pruned/cropped solver.
  for (let i = 0; i < size; i++) {
    if (dist[i] > maxDist) dist[i] = Infinity;
  }
  return dist;
}

export interface RecordDistanceInput {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Record indices of the selected seeds. */
  seedIdx: ArrayLike<number>;
  gridResolution?: number;
}

/**
 * The composition: rasterize → exact EDT from the seed cells → bilinear
 * sample at each point's fractional position. Returns record-order distances
 * cast to Float32Array exactly ONCE here — the same quantization point as the
 * server wire's `recordDist`, so downstream thresholding runs on the same
 * representation in both lanes. No seeds ⇒ all +Infinity (the caller's
 * no-seed full-space branch never asks for a field).
 */
export function computeRecordDistances(input: RecordDistanceInput): {
  recordDist: Float32Array;
} {
  const { x, y, seedIdx } = input;
  const n = x.length;
  const recordDist = new Float32Array(n);
  if (seedIdx.length === 0) {
    recordDist.fill(Infinity);
    return { recordDist };
  }
  const raster = rasterize(x, y, input.gridResolution ?? FIELD_GRID_RESOLUTION);
  const { rows, cols, frows, fcols, W, H, cellSize } = raster;
  const seedRows = new Int32Array(seedIdx.length);
  const seedCols = new Int32Array(seedIdx.length);
  for (let i = 0; i < seedIdx.length; i++) {
    seedRows[i] = rows[seedIdx[i]];
    seedCols[i] = cols[seedIdx[i]];
  }
  const grid = seedDistanceGrid(seedRows, seedCols, W, H, cellSize);
  for (let i = 0; i < n; i++) {
    recordDist[i] = bilinearSampleDist(grid, W, H, frows[i], fcols[i], rows[i], cols[i]);
  }
  return { recordDist };
}
