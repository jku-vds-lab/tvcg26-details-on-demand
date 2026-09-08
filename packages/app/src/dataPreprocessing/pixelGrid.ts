/**
 * Pixel-grid extraction for image datasets (CCTV 128x72, MNIST 28x28).
 *
 * These datasets inline every grayscale pixel as an own JSON property keyed
 * `"1x1".."{A}x{B}"` (CCTV: ~9,216 keys per point, ~49M properties per
 * dataset). Keeping them as object properties makes JSON.parse, structured
 * clone, feature scans, and every pixel read pathologically slow. This module
 * converts them into one contiguous typed array per chunk (transferable
 * across the worker boundary, zero-copy) and slim point objects.
 *
 * Canonical buffer order: key `"{a}x{b}"` is stored at index
 * `(b-1)*width + (a-1)` where `width = max(a)`, `height = max(b)`.
 * This matches the CCTV insets' PIXEL_KEYS convention (`"{col}x{row}"`).
 * MNIST keys are `"{row}x{col}"` — square grids cannot be disambiguated at
 * extraction time, so MNIST consumers read with `transposed: true`.
 *
 * Shared by `workers/jsonParse.worker.ts` (extraction, off main thread) and
 * `DatasetLoader.ts` (view attachment on the main thread). Pure module: no
 * DOM, no React.
 */

/** Matches inlined pixel keys like "1x1", "128x72". */
export const PIXEL_GRID_KEY_RE = /^\d+x\d+$/;

/** Minimum matching keys before an object is treated as a pixel grid. */
export const MIN_PIXEL_GRID_KEYS = 64;

export interface PixelGridInfo {
  width: number;
  height: number;
}

export type PixelBufferKind = "u8" | "f32";

export interface ExtractedPixelGrid {
  /** Slim points: original objects minus their pixel keys. */
  points: Record<string, unknown>[];
  /** One contiguous buffer holding all points' pixels (transferable). */
  buffer: ArrayBuffer;
  width: number;
  height: number;
  /** "u8" when every value is an integer in [0,255], else "f32". */
  kind: PixelBufferKind;
}

/** Metadata needed to rehydrate per-point views from the transferred buffer. */
export interface PixelViewMeta {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  kind: PixelBufferKind;
}

/** Mirrors the legacy getSamplePixels coercion in the inset renderers. */
function coercePixelValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const parsed = v.length ? Number(v) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (v === true) return 1;
  return 0;
}

/**
 * Detect whether an object carries a complete inlined pixel grid.
 * Requires >= MIN_PIXEL_GRID_KEYS matching keys forming a full width*height
 * grid (guards against coincidental feature names like "2x4").
 */
export function detectPixelGrid(point: unknown): PixelGridInfo | null {
  if (typeof point !== "object" || point === null || Array.isArray(point)) return null;
  let width = 0;
  let height = 0;
  let count = 0;
  for (const key in point) {
    if (!Object.prototype.hasOwnProperty.call(point, key)) continue;
    if (!PIXEL_GRID_KEY_RE.test(key)) continue;
    const sep = key.indexOf("x");
    const a = +key.slice(0, sep);
    const b = +key.slice(sep + 1);
    if (a > width) width = a;
    if (b > height) height = b;
    count++;
  }
  if (count < MIN_PIXEL_GRID_KEYS || width * height !== count) return null;
  return { width, height };
}

/** Key -> canonical buffer index map for a width*height grid. */
function buildKeyIndexMap(width: number, height: number): Map<string, number> {
  const map = new Map<string, number>();
  for (let b = 1; b <= height; b++) {
    for (let a = 1; a <= width; a++) {
      map.set(`${a}x${b}`, (b - 1) * width + (a - 1));
    }
  }
  return map;
}

/**
 * Extract the pixel grid of every point in `points` into one contiguous
 * typed-array buffer and return slim points without the pixel keys.
 * Returns null when the first point does not carry a complete grid
 * (non-pixel datasets pass through untouched).
 */
export function extractPixelGrid(points: unknown[]): ExtractedPixelGrid | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  const grid = detectPixelGrid(points[0]);
  if (!grid) return null;

  const { width, height } = grid;
  const per = width * height;
  const keyToIdx = buildKeyIndexMap(width, height);
  const values = new Float32Array(points.length * per);
  const slimPoints = new Array<Record<string, unknown>>(points.length);
  let allByte = true;

  for (let i = 0; i < points.length; i++) {
    const point = points[i] as Record<string, unknown>;
    if (typeof point !== "object" || point === null) {
      slimPoints[i] = point;
      continue;
    }
    const base = i * per;
    const slim: Record<string, unknown> = {};
    for (const key in point) {
      if (!Object.prototype.hasOwnProperty.call(point, key)) continue;
      const idx = keyToIdx.get(key);
      if (idx === undefined) {
        slim[key] = point[key];
        continue;
      }
      const v = coercePixelValue(point[key]);
      if (allByte && (v < 0 || v > 255 || !Number.isInteger(v))) allByte = false;
      values[base + idx] = v;
    }
    slimPoints[i] = slim;
  }

  if (allByte) {
    const u8 = new Uint8Array(values.length);
    u8.set(values);
    return { points: slimPoints, buffer: u8.buffer, width, height, kind: "u8" };
  }
  return { points: slimPoints, buffer: values.buffer, width, height, kind: "f32" };
}

/**
 * Attach zero-copy per-point typed-array views (`pixels`, `pixelsWidth`,
 * `pixelsHeight`) onto points, from the buffer transferred by the worker.
 */
export function attachPixelViews(points: unknown[], meta: PixelViewMeta): void {
  const { buffer, width, height, kind } = meta;
  const per = width * height;
  const bytesPer = kind === "u8" ? 1 : 4;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null) continue;
    p.pixels =
      kind === "u8"
        ? new Uint8Array(buffer, i * per * bytesPer, per)
        : new Float32Array(buffer, i * per * bytesPer, per);
    p.pixelsWidth = width;
    p.pixelsHeight = height;
  }
}

/**
 * Read a point's typed `pixels` field as a fresh Float32Array in the caller's
 * canonical order, or null when absent/mismatched (callers then fall back to
 * the legacy per-key extraction).
 *
 * `transposed: true` is for consumers whose PIXEL_KEYS treat the FIRST key
 * index as the row (MNIST); the extraction buffer stores the first index as
 * the column (CCTV convention).
 */
export function getTypedGridPixels(
  sample: unknown,
  numPixels: number,
  transposed = false
): Float32Array | null {
  const s = sample as { pixels?: unknown; pixelsWidth?: unknown; pixelsHeight?: unknown } | null;
  const p = s?.pixels;
  if (!(p instanceof Uint8Array) && !(p instanceof Float32Array)) return null;
  if (p.length !== numPixels) return null;
  if (!transposed) return new Float32Array(p);

  const width = typeof s?.pixelsWidth === "number" ? s.pixelsWidth : 0;
  const height = typeof s?.pixelsHeight === "number" ? s.pixelsHeight : 0;
  if (width <= 0 || height <= 0 || width * height !== numPixels) return null;
  const out = new Float32Array(numPixels);
  // Buffer stores key "axb" at (b-1)*width+(a-1); transposed consumers index
  // the same key at (a-1)*height+(b-1).
  for (let b = 0; b < height; b++) {
    for (let a = 0; a < width; a++) {
      out[a * height + b] = p[b * width + a];
    }
  }
  return out;
}
