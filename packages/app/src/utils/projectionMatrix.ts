// packages/app/src/utils/projectionMatrix.ts
//
// Pure helpers that turn DataPoints into the dense numeric matrix fed to the
// in-app UMAP projection (see ProjectionTabPanel / umap.worker.ts).
//
// Encoding follows the Projection Space Explorer model: every feature is
// projectable — numeric-ish columns (including numeric strings from CSV
// loaders) become one z-scorable column, categorical columns are one-hot
// encoded over their most frequent values, and image datasets expose their
// pixel buffer as one column per pixel.

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";

/** Synthetic feature key for the per-point pixel buffer (MNIST/CCTV). */
export const PIXELS_FEATURE_KEY = "__pixels__";

/** Cap on one-hot columns per categorical feature (most frequent first). */
export const ONE_HOT_MAX_CATEGORIES = 50;

/** Share of values that must parse as finite numbers for a numeric column. */
const NUMERIC_RATIO_THRESHOLD = 0.95;

export interface FeatureEncoding {
  key: string;
  kind: "numeric" | "onehot" | "pixels";
  /** Number of matrix columns this feature produced. */
  columns: number;
}

export interface ProjectionMatrixResult {
  /** Row-major nRows × nCols matrix. */
  matrix: Float32Array;
  nRows: number;
  nCols: number;
  /** Numeric cells that were missing/unparseable and imputed with the column mean. */
  imputedCells: number;
  /** How each selected feature was encoded, in column order. */
  encodings: FeatureEncoding[];
}

/** Reads a feature the same way the dataset feature scan does (top-level key first, then the `features` bag). */
function readRawFeature(point: DataPoint, key: string): unknown {
  const rec = point as unknown as Record<string, unknown>;
  const value = rec[key];
  if (value !== undefined) return value;
  return point.features ? point.features[key] : undefined;
}

/** Coerces a raw feature value to a finite number, or NaN when it isn't one. */
function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

/** Categorical string form of a value (trimmed — dataset strings may carry stray whitespace). */
function toCategory(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === "" ? undefined : s;
}

interface ColumnPlan {
  key: string;
  kind: FeatureEncoding["kind"];
  offset: number;
  columns: number;
  /** onehot: category → column index within the feature's block. */
  categoryIndex?: Map<string, number>;
}

function planColumns(points: DataPoint[], keys: string[]): ColumnPlan[] {
  const plans: ColumnPlan[] = [];
  let offset = 0;

  for (const key of keys) {
    if (key === PIXELS_FEATURE_KEY) {
      let pixelCount = 0;
      for (const p of points) {
        if (p.pixels && p.pixels.length > pixelCount) pixelCount = p.pixels.length;
      }
      if (pixelCount > 0) {
        plans.push({ key, kind: "pixels", offset, columns: pixelCount });
        offset += pixelCount;
      }
      continue;
    }

    let present = 0;
    let numeric = 0;
    const categoryCounts = new Map<string, number>();
    for (const p of points) {
      const raw = readRawFeature(p, key);
      const cat = toCategory(raw);
      if (cat === undefined) continue;
      present += 1;
      if (!Number.isNaN(toNumber(raw))) numeric += 1;
      categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
    }
    if (present === 0) continue;

    if (numeric / present >= NUMERIC_RATIO_THRESHOLD) {
      plans.push({ key, kind: "numeric", offset, columns: 1 });
      offset += 1;
    } else {
      const top = [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, ONE_HOT_MAX_CATEGORIES);
      const categoryIndex = new Map(top.map(([cat], i) => [cat, i] as const));
      plans.push({ key, kind: "onehot", offset, columns: categoryIndex.size, categoryIndex });
      offset += categoryIndex.size;
    }
  }

  return plans;
}

/**
 * Builds the row-major projection matrix for the given points and feature
 * keys. Numeric-ish features (≥95% of present values parse as numbers) become
 * one column with column-mean imputation for the rest; other features are
 * one-hot encoded over their up-to-50 most frequent (trimmed) values; the
 * PIXELS_FEATURE_KEY expands to one column per pixel. Features with no
 * present values are skipped (absent from `encodings`).
 */
export function buildProjectionMatrix(points: DataPoint[], keys: string[]): ProjectionMatrixResult {
  const nRows = points.length;
  const plans = planColumns(points, keys);
  const nCols = plans.reduce((sum, p) => sum + p.columns, 0);
  const matrix = new Float32Array(nRows * nCols);
  let imputedCells = 0;

  for (const plan of plans) {
    if (plan.kind === "pixels") {
      for (let r = 0; r < nRows; r++) {
        const pixels = points[r].pixels;
        if (!pixels) continue; // rows without pixels stay 0
        const base = r * nCols + plan.offset;
        const n = Math.min(pixels.length, plan.columns);
        for (let c = 0; c < n; c++) matrix[base + c] = pixels[c];
      }
      continue;
    }

    if (plan.kind === "numeric") {
      let sum = 0;
      let count = 0;
      for (let r = 0; r < nRows; r++) {
        const v = toNumber(readRawFeature(points[r], plan.key));
        matrix[r * nCols + plan.offset] = v;
        if (!Number.isNaN(v)) {
          sum += v;
          count += 1;
        }
      }
      const mean = count > 0 ? sum / count : 0;
      for (let r = 0; r < nRows; r++) {
        const idx = r * nCols + plan.offset;
        if (Number.isNaN(matrix[idx])) {
          matrix[idx] = mean;
          imputedCells += 1;
        }
      }
      continue;
    }

    // one-hot
    for (let r = 0; r < nRows; r++) {
      const cat = toCategory(readRawFeature(points[r], plan.key));
      if (cat === undefined) continue;
      const col = plan.categoryIndex!.get(cat);
      if (col !== undefined) matrix[r * nCols + plan.offset + col] = 1;
      // categories beyond the top-50 cap (and missing values) stay all-zero
    }
  }

  return {
    matrix,
    nRows,
    nCols,
    imputedCells,
    encodings: plans.map(({ key, kind, columns }) => ({ key, kind, columns })),
  };
}

/**
 * Z-scores each column of a row-major matrix in place. Columns with zero
 * standard deviation are set to 0 everywhere (they carry no information for
 * the projection); their indices are returned so the UI can report them.
 */
export function standardizeInPlace(
  matrix: Float32Array,
  nRows: number,
  nCols: number
): { constantColumns: number[] } {
  const constantColumns: number[] = [];
  if (nRows === 0) return { constantColumns };

  for (let c = 0; c < nCols; c++) {
    let sum = 0;
    for (let r = 0; r < nRows; r++) sum += matrix[r * nCols + c];
    const mean = sum / nRows;

    let sqSum = 0;
    for (let r = 0; r < nRows; r++) {
      const d = matrix[r * nCols + c] - mean;
      sqSum += d * d;
    }
    const std = Math.sqrt(sqSum / nRows);

    if (std === 0) {
      constantColumns.push(c);
      for (let r = 0; r < nRows; r++) matrix[r * nCols + c] = 0;
    } else {
      for (let r = 0; r < nRows; r++) {
        matrix[r * nCols + c] = (matrix[r * nCols + c] - mean) / std;
      }
    }
  }

  return { constantColumns };
}
