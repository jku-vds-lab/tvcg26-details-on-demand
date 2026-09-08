import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getTypedGridPixels } from "src/dataPreprocessing/pixelGrid";
import type { RootState } from "src/store";

/**
 * Grid geometry of the image insets: one grayscale (0–255) column per pixel,
 * keyed `"{row}x{col}"` (1-based), read row-major. Shared by the MNIST
 * insets, which the generic `"image"` dataset type reuses with the grid
 * taken from the dataset metadata (the widget's `image_shape`).
 */
export interface ImageShape {
  rows: number;
  cols: number;
}

/** Dataset types with a fixed grid; `"image"` takes it from the metadata. */
export const IMAGE_SHAPE_PRESETS: Readonly<Record<string, ImageShape>> = {
  mnist: { rows: 28, cols: 28 },
};

export const DEFAULT_IMAGE_SHAPE: ImageShape = IMAGE_SHAPE_PRESETS.mnist;

/** Edge of the MNIST inset in CSS px at scale 1; smaller grids upscale to it. */
const INSET_BASE_PX = 28;

/** The grid to render: dataset metadata (widget `image_shape`), else the type preset, else 28×28. */
export function resolveImageShape(state: RootState): ImageShape {
  const meta = state.dataset.imageShape;
  if (meta) return { rows: meta[0], cols: meta[1] };
  return IMAGE_SHAPE_PRESETS[state.dataset.datasetType] ?? DEFAULT_IMAGE_SHAPE;
}

/** The widget's `imageShape` trait (`[rows, cols]`); anything else ⇒ undefined. */
export function parseImageShape(raw: unknown): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [rows, cols] = raw as unknown[];
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return undefined;
  if ((rows as number) <= 0 || (cols as number) <= 0) return undefined;
  return [rows as number, cols as number];
}

/**
 * CSS px per image pixel at scale 1. Small grids are upscaled (whole pixels,
 * drawn nearest-neighbour) so the longest side is at least the MNIST inset
 * edge — an 8×8 digit renders 4 px per pixel; 28×28 stays 1:1.
 */
export function imagePixelUnit(shape: ImageShape): number {
  return Math.max(1, Math.round(INSET_BASE_PX / Math.max(shape.rows, shape.cols)));
}

const PIXEL_KEY_CACHE = new Map<string, string[]>();

/** `"1x1"` .. `"{rows}x{cols}"` in row-major order, built once per shape. */
export function pixelKeysFor(shape: ImageShape): string[] {
  const id = `${shape.rows}x${shape.cols}`;
  let keys = PIXEL_KEY_CACHE.get(id);
  if (!keys) {
    keys = [];
    for (let r = 1; r <= shape.rows; r++) {
      for (let c = 1; c <= shape.cols; c++) keys.push(`${r}x${c}`);
    }
    PIXEL_KEY_CACHE.set(id, keys);
  }
  return keys;
}

/** Per-sample pixel cache: DataPoint -> Float32Array[rows*cols] */
const SAMPLE_PIXELS = new WeakMap<DataPoint, Float32Array>();

/**
 * One sample's pixels in row-major order, cached per point. Prefers the typed
 * `pixels` field (worker-extracted; transposed — the keys are "{row}x{col}",
 * see pixelGrid.ts), falling back to the keys on the point or in its
 * `features` bag (the widget's simple-format rows keep them on the point).
 */
export function getSamplePixels(sample: DataPoint, shape: ImageShape): Float32Array {
  const numPixels = shape.rows * shape.cols;
  const cached = SAMPLE_PIXELS.get(sample);
  if (cached && cached.length === numPixels) return cached;

  const typed = getTypedGridPixels(sample, numPixels, true);
  if (typed) {
    SAMPLE_PIXELS.set(sample, typed);
    return typed;
  }

  const keys = pixelKeysFor(shape);
  const out = new Float32Array(numPixels);
  const rec = sample as unknown as Record<string, unknown>;
  const feat = sample.features;

  // Tight loop; minimal branching; robust numeric coercion.
  for (let i = 0; i < numPixels; i++) {
    const key = keys[i];
    // Prefer direct property, then features map.
    let v: unknown = rec[key];
    if (v === undefined && feat) v = feat[key];

    let num = 0;
    if (typeof v === "number") num = v;
    else if (typeof v === "string") {
      const parsed = v.length ? Number(v) : 0;
      num = Number.isFinite(parsed) ? parsed : 0;
    } else if (v === true) num = 1;

    out[i] = num;
  }

  SAMPLE_PIXELS.set(sample, out);
  return out;
}
