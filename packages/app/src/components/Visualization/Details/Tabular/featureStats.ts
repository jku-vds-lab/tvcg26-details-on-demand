// packages/app/src/components/Visualization/Details/Tabular/featureStats.ts
//
// Pure stats core for the tabular summary / difference insets. Discovers
// feature columns (numeric AND low-cardinality categorical) on DataPoints,
// bins them against per-dataset reference distributions, and scores rows by
// Jensen-Shannon divergence — symmetric, bounded (normalized to [0,1]), and
// count-independent, so the ranking is comparable across numeric and
// categorical features alike (chosen over chi² for exactly that reason).
//
// Performance contract: the reference (whole-dataset) distribution of each
// column is computed once per dataset and memoized in a WeakMap keyed by the
// data array — inset renders only ever bin their own (≤ MAX_STAT_SAMPLES
// sampled) cluster against the cached bins.

import { groupMembersOf, groupStrideRows } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { deferredColumnNames } from "src/dataPreprocessing/lazyColumns";
import { rowAt } from "src/dataPreprocessing/lazyRows";
import { ASSIGNED_LABEL_OVERRIDE_FEATURE } from "../BaseInsetRenderer";

/** Pixel-grid keys ("3x7") are image payload, never summary features. */
const PIXEL_KEY_RE = /^\d+x\d+$/i;

/** DataPoint internals / pipeline-computed fields that are not features. */
const RESERVED_KEYS = new Set([
  "x",
  "y",
  "id",
  "line", // pipeline-computed trajectory id (the source column stays a feature)
  "selected",
  "DoI",
  "doiGroup",
  "neighbors",
  "edges",
  "px",
  "py",
  "features",
  "pixels",
  "pixelsWidth",
  "pixelsHeight",
  "nextEdgeCenter",
  "nextLineSegments",
  "lastLineSegments",
  "annotationClusterId",
  "insetClusterId",
  "edgeStart",
  "edgeEnd",
  // Pipeline-computed copy of the mapped action column (the source column
  // stays a feature) — showing both reads as a duplicate.
  "action",
  // Same for the mapped class-label column (#305); for bespoke datasets the
  // label field duplicates the overlay label and trivially separates every
  // cluster, so it only pollutes the divergence ranking.
  "label",
  ASSIGNED_LABEL_OVERRIDE_FEATURE,
]);

/** Bins of numeric density estimates (shared cluster/reference bins). */
export const NUMERIC_BINS = 16;
/** Top categories kept for categorical distributions (rest → "other"). */
export const MAX_CATEGORIES = 8;
/** Columns with more distinct probe values than this are treated as free text. */
const CATEGORICAL_UNIQUE_CAP = 24;
/** Per-cluster stats sampling cap: clusters can hold the whole dataset. */
const MAX_STAT_SAMPLES = 2000;
/** Reference-distribution sampling cap (whole dataset, computed once). */
const REFERENCE_SAMPLE_CAP = 5000;
/** Column-discovery probe size. */
const PROBE_SAMPLES = 200;

export type FeatureKind = "numeric" | "categorical";

export interface FeatureColumn {
  column: string;
  kind: FeatureKind;
}

// NOT getAnnotationValue: its assigned-label override branch returns the
// user-assigned label for EVERY column of a labeled point, which would
// poison all stats after a labeling pass. Read the actual stored value.
const rawValue = (point: DataPoint, column: string): string => {
  const featureValue = (point as { features?: Record<string, unknown> }).features?.[column];
  if (featureValue !== undefined && featureValue !== null) return String(featureValue).trim();
  if (column in point) {
    return String(point[column as keyof DataPoint] ?? "").trim();
  }
  return "";
};

/** Even-stride subsample so stats stay O(cap) on huge inputs. */
const strideSample = <T>(items: readonly T[], cap: number): T[] => {
  if (items.length <= cap) return items.slice();
  const out: T[] = [];
  const stride = items.length / cap;
  for (let i = 0; i < cap; i++) out.push(items[Math.floor(i * stride)]);
  return out;
};

/** strideSample over the CANONICAL points array, resolving each sampled index
 * through the row seam (issue #315 R1b) so a row-lazy dataset serves it. */
const strideSampleRows = (points: readonly DataPoint[], cap: number): DataPoint[] => {
  const out: DataPoint[] = [];
  const n = points.length;
  const stride = n <= cap ? 1 : n / cap;
  const take = n <= cap ? n : cap;
  for (let i = 0; i < take; i++) {
    const row = rowAt(points, n <= cap ? i : Math.floor(i * stride));
    if (row) out.push(row);
  }
  return out;
};

/**
 * Feature columns of a sample set: keys found top-level or under .features,
 * excluding DataPoint internals and pixel-grid keys. Columns where ≥ half of
 * the non-empty probe values parse as finite numbers are numeric; remaining
 * columns with at most CATEGORICAL_UNIQUE_CAP distinct values are
 * categorical; everything else (free text, near-unique ids) is dropped.
 */
export function collectFeatureColumns(
  samples: readonly DataPoint[],
  opts?: {
    /** The CANONICAL points array holding the deferred-columns registry, for
     * callers whose `samples` is a freshly merged array the group seam cannot
     * resolve (the edge-diff probe). Defaults to resolving via the member
     * spec, falling back to `samples` itself. */
    canonical?: readonly DataPoint[];
  }
): FeatureColumn[] {
  if (samples.length === 0) return [];
  // Index-backed groups (issue #315 R1c) hold no rows in their slots — the
  // probe materializes exactly its ≤ PROBE_SAMPLES strided rows via the
  // member spec instead.
  const probe = groupStrideRows(samples, PROBE_SAMPLES) ?? strideSample(samples, PROBE_SAMPLES);

  const keys = new Set<string>();
  for (const p of probe) {
    for (const k of Object.keys(p)) keys.add(k);
    const features = (p as { features?: Record<string, unknown> }).features;
    if (features) for (const k of Object.keys(features)) keys.add(k);
  }
  // Deferred columns (issue #315 R3c) live as PROTOTYPE accessors, which
  // Object.keys can never enumerate — even after their bytes attach. Add the
  // manifest-declared names explicitly: `rawValue`'s `in` check reads through
  // the accessors, so an attached column probes normally, while a still
  // server-resident one reads "" everywhere and drops out below (the caller
  // triggers ensureResidentColumns and re-renders on the attach bump).
  const canonical = opts?.canonical ?? groupMembersOf(samples)?.nodes ?? samples;
  for (const name of deferredColumnNames(canonical)) keys.add(name);

  const columns: FeatureColumn[] = [];
  for (const key of keys) {
    if (RESERVED_KEYS.has(key)) continue;
    if (PIXEL_KEY_RE.test(key)) continue;
    let nonEmpty = 0;
    let numeric = 0;
    const distinct = new Set<string>();
    for (const p of probe) {
      const raw = rawValue(p, key);
      if (raw === "") continue;
      nonEmpty++;
      if (Number.isFinite(Number(raw))) numeric++;
      if (distinct.size <= CATEGORICAL_UNIQUE_CAP) distinct.add(raw);
    }
    if (nonEmpty === 0) continue;
    if (numeric >= 1 && numeric * 2 >= nonEmpty) {
      columns.push({ column: key, kind: "numeric" });
    } else if (distinct.size <= CATEGORICAL_UNIQUE_CAP) {
      columns.push({ column: key, kind: "categorical" });
    }
  }
  return columns.sort((a, b) => a.column.localeCompare(b.column));
}

// ---------------------------------------------------------------------------
// Reference (whole-dataset) distributions — cached per data array
// ---------------------------------------------------------------------------

export interface ReferenceDistribution {
  kind: FeatureKind;
  /** Probabilities over bins (numeric) or categories (categorical); sums to 1. */
  probs: number[];
  /** Numeric: shared bin range. */
  min?: number;
  max?: number;
  /** Categorical: bin labels; last one is "other" when hasOther. */
  categories?: string[];
  hasOther?: boolean;
}

const referenceCache = new WeakMap<
  readonly DataPoint[],
  Map<string, ReferenceDistribution | null>
>();

const numericValues = (points: readonly DataPoint[], column: string): number[] => {
  const values: number[] = [];
  for (const p of points) {
    const raw = rawValue(p, column);
    if (raw === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v)) values.push(v);
  }
  return values;
};

const binNumeric = (values: readonly number[], min: number, max: number): number[] => {
  const probs = new Array<number>(NUMERIC_BINS).fill(0);
  if (values.length === 0) return probs;
  const scale = max > min ? NUMERIC_BINS / (max - min) : 0;
  for (const v of values) {
    let bin = scale > 0 ? Math.floor((v - min) * scale) : 0;
    if (bin < 0) bin = 0;
    if (bin >= NUMERIC_BINS) bin = NUMERIC_BINS - 1;
    probs[bin]++;
  }
  for (let i = 0; i < probs.length; i++) probs[i] /= values.length;
  return probs;
};

const binCategorical = (
  points: readonly DataPoint[],
  column: string,
  categories: readonly string[],
  hasOther: boolean
): { probs: number[]; count: number; modeLabel?: string; modeShare?: number } => {
  const index = new Map(categories.map((c, i) => [c, i]));
  const counts = new Array<number>(categories.length).fill(0);
  let count = 0;
  for (const p of points) {
    const raw = rawValue(p, column);
    if (raw === "") continue;
    count++;
    const i = index.get(raw);
    if (i !== undefined) counts[i]++;
    else if (hasOther) counts[counts.length - 1]++;
  }
  if (count === 0) return { probs: counts, count: 0 };
  let modeIdx = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[modeIdx]) modeIdx = i;
  return {
    probs: counts.map((c) => c / count),
    count,
    modeLabel: categories[modeIdx],
    modeShare: counts[modeIdx] / count,
  };
};

/**
 * Whole-dataset distribution of one column, memoized per data-array identity.
 * Returns null (cached) when the column has no usable values in the sample.
 */
export function getReferenceDistribution(
  data: readonly DataPoint[],
  col: FeatureColumn
): ReferenceDistribution | null {
  let perColumn = referenceCache.get(data);
  if (!perColumn) {
    perColumn = new Map();
    referenceCache.set(data, perColumn);
  }
  const cached = perColumn.get(col.column);
  if (cached !== undefined) return cached;

  // Whole-dataset reference (issue #315 R1b): the local-stats fallback is a
  // row-contract member, but a bounded one — the stride picks at most
  // REFERENCE_SAMPLE_CAP indices, so on the row-lazy lane exactly those rows
  // get built instead of the whole dataset.
  const sampled = strideSampleRows(data, REFERENCE_SAMPLE_CAP);
  let dist: ReferenceDistribution | null = null;

  if (col.kind === "numeric") {
    const values = numericValues(sampled, col.column);
    if (values.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const v of values) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
      dist = { kind: "numeric", min, max, probs: binNumeric(values, min, max) };
    }
  } else {
    const counts = new Map<string, number>();
    for (const p of sampled) {
      const raw = rawValue(p, col.column);
      if (raw === "") continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
    if (counts.size > 0) {
      const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      const hasOther = ranked.length > MAX_CATEGORIES;
      const kept = ranked.slice(0, hasOther ? MAX_CATEGORIES - 1 : MAX_CATEGORIES);
      const categories = kept.map(([label]) => label);
      if (hasOther) categories.push("other");
      const { probs } = binCategorical(sampled, col.column, categories, hasOther);
      dist = { kind: "categorical", categories, hasOther, probs };
    }
  }

  perColumn.set(col.column, dist);
  return dist;
}

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

/**
 * Jensen-Shannon divergence between two aligned probability vectors,
 * normalized to [0,1] (division by ln 2).
 */
export function jensenShannon(p: readonly number[], q: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i];
    const qi = q[i] ?? 0;
    const m = (pi + qi) / 2;
    if (pi > 0) sum += (pi / 2) * Math.log(pi / m);
    if (qi > 0) sum += (qi / 2) * Math.log(qi / m);
  }
  return Math.min(1, Math.max(0, sum / Math.LN2));
}

// ---------------------------------------------------------------------------
// Summary rows (cluster vs whole dataset)
// ---------------------------------------------------------------------------

export interface SummaryRow {
  column: string;
  kind: FeatureKind;
  /** Cluster points with a usable value. */
  count: number;
  /** Cluster distribution over the reference bins/categories. */
  probs: number[];
  /** Reference (whole-dataset) distribution over the same bins. */
  referenceProbs: number[];
  /** Normalized JSD cluster-vs-dataset — the default rank key. */
  divergence: number;
  // Numeric extras (undefined for categorical):
  mean?: number;
  median?: number;
  min?: number;
  max?: number;
  std?: number;
  // Categorical extras:
  modeLabel?: string;
  modeShare?: number;
  categories?: string[];
}

const numericSummary = (values: number[]) => {
  values.sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const mid = values.length >> 1;
  const median =
    values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (values.length - 1);
  return {
    mean,
    median,
    min: values[0],
    max: values[values.length - 1],
    std: Math.sqrt(variance),
  };
};

/**
 * Per-column cluster summaries against the dataset-wide reference
 * distributions. `referenceData` is normally the full dataset; when empty
 * (no provider yet / tests), the cluster itself is used, making the
 * reference curve identical and every divergence 0.
 */
export function computeSummaryRows(
  samples: readonly DataPoint[],
  columns: readonly FeatureColumn[],
  referenceData: readonly DataPoint[]
): SummaryRow[] {
  // Spec-resolved stride on index-backed groups (issue #315 R1c); the
  // no-provider reference fallback must use the RESOLVED rows too — an
  // index-backed array's slots are holes the reference stride would skip.
  const specSampled = groupStrideRows(samples, MAX_STAT_SAMPLES);
  const sampled = specSampled ?? strideSample(samples, MAX_STAT_SAMPLES);
  const reference = referenceData.length > 0 ? referenceData : (specSampled ?? samples);
  const rows: SummaryRow[] = [];

  for (const col of columns) {
    const ref = getReferenceDistribution(reference, col);
    if (!ref) continue;

    if (col.kind === "numeric") {
      const values = numericValues(sampled, col.column);
      if (values.length === 0) continue;
      const probs = binNumeric(values, ref.min!, ref.max!);
      rows.push({
        column: col.column,
        kind: "numeric",
        count: values.length,
        probs,
        referenceProbs: ref.probs,
        divergence: jensenShannon(probs, ref.probs),
        ...numericSummary(values),
      });
    } else {
      const binned = binCategorical(sampled, col.column, ref.categories!, !!ref.hasOther);
      if (binned.count === 0) continue;
      rows.push({
        column: col.column,
        kind: "categorical",
        count: binned.count,
        probs: binned.probs,
        referenceProbs: ref.probs,
        divergence: jensenShannon(binned.probs, ref.probs),
        modeLabel: binned.modeLabel,
        modeShare: binned.modeShare,
        categories: ref.categories,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Diff rows (cluster A vs cluster B, on the shared reference bins)
// ---------------------------------------------------------------------------

export interface DiffRow {
  column: string;
  kind: FeatureKind;
  countA: number;
  countB: number;
  probsA: number[];
  probsB: number[];
  /** Normalized JSD A-vs-B — the default rank key. */
  divergence: number;
  // Numeric extras:
  meanA?: number;
  meanB?: number;
  deltaMean?: number;
  // Categorical extras:
  modeA?: string;
  modeB?: string;
  categories?: string[];
}

/**
 * Per-column A-vs-B differences. Both sides are binned on the dataset-wide
 * reference bins (cached), so distributions and divergences are comparable
 * across insets.
 */
export function computeDiffRows(
  aSamples: readonly DataPoint[],
  bSamples: readonly DataPoint[],
  columns: readonly FeatureColumn[],
  referenceData: readonly DataPoint[]
): DiffRow[] {
  const aSpec = groupStrideRows(aSamples, MAX_STAT_SAMPLES);
  const bSpec = groupStrideRows(bSamples, MAX_STAT_SAMPLES);
  const a = aSpec ?? strideSample(aSamples, MAX_STAT_SAMPLES);
  const b = bSpec ?? strideSample(bSamples, MAX_STAT_SAMPLES);
  // Resolved rows in the no-provider fallback (see computeSummaryRows).
  const reference =
    referenceData.length > 0 ? referenceData : aSpec || bSpec ? [...a, ...b] : [...aSamples, ...bSamples];
  const rows: DiffRow[] = [];

  for (const col of columns) {
    const ref = getReferenceDistribution(reference, col);
    if (!ref) continue;

    if (col.kind === "numeric") {
      const aValues = numericValues(a, col.column);
      const bValues = numericValues(b, col.column);
      if (aValues.length === 0 || bValues.length === 0) continue;
      const probsA = binNumeric(aValues, ref.min!, ref.max!);
      const probsB = binNumeric(bValues, ref.min!, ref.max!);
      const meanA = aValues.reduce((s, v) => s + v, 0) / aValues.length;
      const meanB = bValues.reduce((s, v) => s + v, 0) / bValues.length;
      rows.push({
        column: col.column,
        kind: "numeric",
        countA: aValues.length,
        countB: bValues.length,
        probsA,
        probsB,
        divergence: jensenShannon(probsA, probsB),
        meanA,
        meanB,
        deltaMean: meanB - meanA,
      });
    } else {
      const binnedA = binCategorical(a, col.column, ref.categories!, !!ref.hasOther);
      const binnedB = binCategorical(b, col.column, ref.categories!, !!ref.hasOther);
      if (binnedA.count === 0 || binnedB.count === 0) continue;
      rows.push({
        column: col.column,
        kind: "categorical",
        countA: binnedA.count,
        countB: binnedB.count,
        probsA: binnedA.probs,
        probsB: binnedB.probs,
        divergence: jensenShannon(binnedA.probs, binnedB.probs),
        modeA: binnedA.modeLabel,
        modeB: binnedB.modeLabel,
        categories: ref.categories,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SummarySortKey = "name" | "difference" | "value" | "variance";
export type DiffSortKey = "name" | "difference" | "value";

/** Gini impurity — the categorical stand-in for variance. */
const impurity = (probs: readonly number[]): number =>
  1 - probs.reduce((s, p) => s + p * p, 0);

export function sortSummaryRows(
  rows: readonly SummaryRow[],
  key: SummarySortKey,
  descending: boolean
): SummaryRow[] {
  const sign = descending ? -1 : 1;
  const value = (r: SummaryRow) => (r.kind === "numeric" ? r.mean! : r.modeShare!);
  const variance = (r: SummaryRow) =>
    r.kind === "numeric" ? r.std! * r.std! : impurity(r.probs);
  return rows.slice().sort((a, b) => {
    if (key === "name") return sign * a.column.localeCompare(b.column);
    if (key === "difference") return sign * (a.divergence - b.divergence);
    if (key === "value") return sign * (value(a) - value(b));
    return sign * (variance(a) - variance(b));
  });
}

export function sortDiffRows(
  rows: readonly DiffRow[],
  key: DiffSortKey,
  descending: boolean
): DiffRow[] {
  const sign = descending ? -1 : 1;
  // "value" = |Δ mean| for numeric rows; categorical rows fall back to their
  // divergence so they stay meaningfully placed on the same axis.
  const value = (r: DiffRow) =>
    r.kind === "numeric" ? Math.abs(r.deltaMean!) : r.divergence;
  return rows.slice().sort((a, b) => {
    if (key === "name") return sign * a.column.localeCompare(b.column);
    if (key === "difference") return sign * (a.divergence - b.divergence);
    return sign * (value(a) - value(b));
  });
}

/** Compact number formatting for inset cells. */
export function formatStatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 10000 || abs < 0.001) return value.toExponential(1);
  if (abs >= 100) return value.toFixed(0);
  return String(Number(value.toPrecision(3)));
}
