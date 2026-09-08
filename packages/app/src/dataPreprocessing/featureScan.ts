// packages/app/src/dataPreprocessing/featureScan.ts
//
// Pure feature-scan core (issue #315 — extracted from usePrepareDatasetRefs).
//
// At boot the client scans up to MAX_POINTS_TO_SCAN rows to compute per-column
// feature statistics (the "Analyzing features" progress bar). That scan core
// lives here as a dependency-free module so it can be unit-tested in isolation
// and pinned against the server's Python twin via a golden fixture
// (featureScan.golden.test.ts → tests/fixtures/feature_stats_golden.json).
//
// getAnnotationValue rule (preserved exactly): the scan reads RAW row values
// off the point objects, never annotation overrides. accumulatePoint iterates
// the point's own-enumerable keys directly — it must never route through
// getAnnotationValue, whose assigned-label override would poison every column
// of labeled points.

import { DataPoint } from "./dataPreprocessing";
import { PIXEL_GRID_KEY_RE } from "./pixelGrid";
import type { FeatureStats, FeatureVariableType } from "../slices/datasetFeatures";

const EXCLUDED_TOP_LEVEL_KEYS = new Set([
  "x",
  "y",
  "nextEdgeCenter",
  "lastLineSegments",
  "nextLineSegments",
]);

const isPrimitive = (value: unknown): value is string | number | boolean => {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean";
};

export interface MutableFeatureAccumulator {
  totalCount: number;
  numericCount: number;
  booleanCount: number;
  integerCount: number;
  min: number;
  max: number;
  hasNegative: boolean;
  hasPositive: boolean;
  categories: Map<string, number>;
  uniqueLimited: Set<string>;
  overflowUnique: boolean;
}

export const MAX_POINTS_TO_SCAN = 20000;
export const MAX_CATEGORIES_TRACKED = 50;
export const MAX_UNIQUES_TRACKED = 1000;
export const MAX_FEATURE_KEYS_PER_POINT_TO_SCAN = 256;
export const FEATURE_SCAN_BATCH_POINTS = 50;
// Phase 1 (visible snackbar): scan 2k rows with large batches + setTimeout yields
// so the task completes in ~10 fast ticks instead of 400 idle-callback ticks.
export const FEATURE_PRELIMINARY_SCAN_ROWS = 2000;
export const FEATURE_PRELIMINARY_BATCH_ROWS = 200;

// ---------------------------------------------------------------------------
// Synchronous micro-scan — runs in the first 200 rows with no awaits.
// Fast enough to call before starting the async preparation chain.
// ---------------------------------------------------------------------------

export const FEATURE_MICRO_SCAN_ROWS = 200;

/**
 * Idle-priority yield: the default cadence of the async chunked scan (phase 2)
 * and the explicit yield of phase 1's low-priority tail. Exported so the hook
 * keeps its call sites byte-identical after the extraction.
 */
export const yieldToIdleOrFrame = async () => {
  await new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 50 });
      return;
    }
    requestAnimationFrame(() => resolve());
  });
};

const createAccumulator = (): MutableFeatureAccumulator => ({
  totalCount: 0,
  numericCount: 0,
  booleanCount: 0,
  integerCount: 0,
  min: Number.POSITIVE_INFINITY,
  max: Number.NEGATIVE_INFINITY,
  hasNegative: false,
  hasPositive: false,
  categories: new Map<string, number>(),
  uniqueLimited: new Set<string>(),
  overflowUnique: false,
});

const compareCategoryValue = (a: string, b: string): number => {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = Number.isFinite(aNum) && a.trim() !== "";
  const bIsNum = Number.isFinite(bNum) && b.trim() !== "";

  if (aIsNum && bIsNum) {
    if (aNum !== bNum) return aNum - bNum;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
};

const inferVariableType = (key: string, acc: MutableFeatureAccumulator, uniqueCount: number): FeatureVariableType => {
  // DoI is a continuous score by design even when current values are degenerate.
  if (key === "DoI") return "sequential";

  if (acc.totalCount === 0) return "unknown";
  if (acc.booleanCount === acc.totalCount) return "boolean";

  const numericRatio = acc.numericCount / acc.totalCount;
  const mostlyNumeric = numericRatio >= 0.95;
  const allIntegers = acc.numericCount > 0 && acc.integerCount === acc.numericCount;

  if (mostlyNumeric) {
    if (allIntegers && uniqueCount <= 12) {
      return "categorical";
    }
    if (acc.hasNegative && acc.hasPositive) {
      return "diverging";
    }
    return "sequential";
  }

  return "categorical";
};

// ---------------------------------------------------------------------------
// Shared helpers used by both the synchronous micro-scan and the async full scan
// ---------------------------------------------------------------------------

export function shouldScanBags(points: DataPoint[], limit = points.length): boolean {
  // Bounded to the rows the scan can actually visit (issue #315 R1b): the
  // decision only matters for rows that get accumulated, and an unbounded
  // `find` walked the whole canonical array — 1M reads at synth1m, and a
  // hole-array dereference once rows are lazy. Missing rows are skipped, so a
  // lazy array answers from its eagerly built prefix.
  const end = Math.min(points.length, limit);
  for (let i = 0; i < end; i++) {
    const bag = points[i]?.features;
    if (bag) {
      const keys = Object.keys(bag).length;
      if (keys > 0) return keys <= MAX_FEATURE_KEYS_PER_POINT_TO_SCAN;
    }
  }
  return true;
}

export function accumulatePoint(
  point: DataPoint,
  accByKey: Map<string, MutableFeatureAccumulator>,
  scanBags: boolean
) {
  const addKeyIfValid = (key: string, value: unknown) => {
    if (!key || value === null || value === undefined) return;
    if (EXCLUDED_TOP_LEVEL_KEYS.has(key)) return;
    if (!isPrimitive(value)) return;

    const acc = accByKey.get(key) ?? createAccumulator();
    acc.totalCount += 1;

    if (typeof value === "number" && Number.isFinite(value)) {
      acc.numericCount += 1;
      if (Number.isInteger(value)) acc.integerCount += 1;
      if (value < acc.min) acc.min = value;
      if (value > acc.max) acc.max = value;
      if (value < 0) acc.hasNegative = true;
      if (value > 0) acc.hasPositive = true;
    }

    const cat = String(value);
    if (acc.categories.has(cat) || acc.categories.size < MAX_UNIQUES_TRACKED) {
      acc.categories.set(cat, (acc.categories.get(cat) ?? 0) + 1);
    }
    if (typeof value === "boolean") acc.booleanCount += 1;

    const valueKey = String(value);
    if (!acc.overflowUnique) {
      acc.uniqueLimited.add(valueKey);
      if (acc.uniqueLimited.size > MAX_UNIQUES_TRACKED) {
        acc.overflowUnique = true;
      }
    }

    accByKey.set(key, acc);
  };

  for (const key in point) {
    if (!Object.prototype.hasOwnProperty.call(point, key)) continue;
    if (key === "features") continue;
    // Inlined pixel keys ("1x1".."128x72") are image payload, not features —
    // scanning them costs ~49M accumulator calls on CCTV and pollutes the
    // feature list. Worker-extracted datasets no longer carry them; this
    // guards legacy-loaded ones.
    if (PIXEL_GRID_KEY_RE.test(key)) continue;
    addKeyIfValid(key, (point as unknown as Record<string, unknown>)[key]);
  }

  if (scanBags && point.features) {
    for (const key in point.features) {
      if (!Object.prototype.hasOwnProperty.call(point.features, key)) continue;
      addKeyIfValid(key, point.features[key]);
    }
  }
}

export function buildResultsFromAccumulators(
  accByKey: Map<string, MutableFeatureAccumulator>,
  confidence: FeatureStats["confidence"]
): { availableKeys: string[]; statsByKey: Record<string, FeatureStats> } {
  const availableKeys = Array.from(accByKey.keys()).sort((a, b) => a.localeCompare(b));
  const statsByKey: Record<string, FeatureStats> = {};

  availableKeys.forEach((key) => {
    const acc = accByKey.get(key);
    if (!acc) return;

    const uniqueCount = acc.overflowUnique ? MAX_UNIQUES_TRACKED + 1 : acc.uniqueLimited.size;
    const variableType = inferVariableType(key, acc, uniqueCount);
    const categories = Array.from(acc.categories.entries())
      .sort((a, b) => compareCategoryValue(a[0], b[0]))
      .slice(0, MAX_CATEGORIES_TRACKED)
      .map(([value, count]) => ({ value, count }));

    const stats: FeatureStats = {
      key,
      variableType,
      uniqueCount,
      totalCount: acc.totalCount,
      numericRatio: acc.totalCount > 0 ? acc.numericCount / acc.totalCount : 0,
      hasNegative: acc.hasNegative,
      hasPositive: acc.hasPositive,
      confidence,
    };

    if (key === "DoI") {
      // Keep the display/scale stable for dynamic DoI updates.
      stats.min = 0;
      stats.max = 1;
      stats.hasNegative = false;
      stats.hasPositive = true;
    } else if (acc.numericCount > 0 && Number.isFinite(acc.min) && Number.isFinite(acc.max)) {
      stats.min = acc.min;
      stats.max = acc.max;
    }

    if (categories.length > 0) {
      stats.categories = categories;
    }

    statsByKey[key] = stats;
  });

  return { availableKeys, statsByKey };
}

export function collectFeatureMetadataSync(points: DataPoint[]): {
  availableKeys: string[];
  statsByKey: Record<string, FeatureStats>;
} {
  const limit = Math.min(points.length, FEATURE_MICRO_SCAN_ROWS);
  if (limit === 0) return { availableKeys: [], statsByKey: {} };

  const accByKey = new Map<string, MutableFeatureAccumulator>();
  const scanBags = shouldScanBags(points, limit);

  for (let i = 0; i < limit; i++) {
    accumulatePoint(points[i], accByKey, scanBags);
  }

  return buildResultsFromAccumulators(accByKey, "provisional");
}

// ---------------------------------------------------------------------------
// Async chunked scan — resumable so Phase 1 and Phase 2 share accumulators
// ---------------------------------------------------------------------------

/** Accumulated state that can be passed to a continuation scan. */
export interface ScanResume {
  accByKey: Map<string, MutableFeatureAccumulator>;
  scanBags: boolean;
}

export interface ChunkedScanOptions {
  /** First row index to scan (inclusive). */
  fromRow: number;
  /** Last row index to scan (exclusive). Capped to MAX_POINTS_TO_SCAN. */
  toRow: number;
  /** How many rows to process per batch before yielding. */
  batchSize: number;
  /** Confidence to stamp on all produced FeatureStats. */
  confidence: FeatureStats["confidence"];
  /** Yield strategy. Defaults to yieldToIdleOrFrame (lowest priority). */
  yieldFn?: () => Promise<void>;
  signal?: AbortSignal;
  /** Called with 0-100 as rows are processed. */
  onProgress?: (progressPct: number) => void;
  /** Pass the result of a previous call to continue from existing accumulators. */
  resume?: ScanResume;
}

export async function collectFeatureMetadataChunked(
  points: DataPoint[],
  options: ChunkedScanOptions
): Promise<{
  availableKeys: string[];
  statsByKey: Record<string, FeatureStats>;
  resume: ScanResume;
}> {
  const { signal, onProgress, resume } = options;
  const yieldFn = options.yieldFn ?? yieldToIdleOrFrame;

  const fromRow = options.fromRow;
  const toRow = Math.min(options.toRow, MAX_POINTS_TO_SCAN, points.length);

  if (toRow <= fromRow) {
    const accByKey = resume?.accByKey ?? new Map<string, MutableFeatureAccumulator>();
    const scanBags = resume?.scanBags ?? shouldScanBags(points, MAX_POINTS_TO_SCAN);
    return { ...buildResultsFromAccumulators(accByKey, options.confidence), resume: { accByKey, scanBags } };
  }

  const accByKey = resume?.accByKey ?? new Map<string, MutableFeatureAccumulator>();
  const scanBags = resume?.scanBags ?? shouldScanBags(points, MAX_POINTS_TO_SCAN);
  const rangeSize = toRow - fromRow;

  for (let start = fromRow; start < toRow; start += options.batchSize) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(toRow, start + options.batchSize);

    for (let i = start; i < end; i++) {
      accumulatePoint(points[i], accByKey, scanBags);
    }

    if (onProgress) onProgress(((end - fromRow) / rangeSize) * 100);
    await yieldFn();
  }

  return { ...buildResultsFromAccumulators(accByKey, options.confidence), resume: { accByKey, scanBags } };
}
