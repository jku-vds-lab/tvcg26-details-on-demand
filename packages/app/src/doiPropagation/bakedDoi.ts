// packages/app/src/doiPropagation/bakedDoi.ts
//
// Server-baked DoI (issue #315 P7 S5). On the provider path the server owns
// DoI: the client receives a dense record-order f32 field and stops
// materializing per-point state from it — no `node.DoI =`, no `cols.doi[i] =`,
// no per-node `doiGroup` STRING. That apply loop was the measured ~1.3 s half
// of the lasso RTT at 1M (plan-315-p7/census-transport.md Q4).
//
// Two things replace it:
//   1. the f32 field is ADOPTED as the DoI column (pointColumns.adoptDoiColumn,
//      an O(1) buffer swap), so every `p.DoI` reader keeps reading server truth;
//   2. the `doiGroup` string — which has no column and therefore cannot be
//      swapped — becomes the O(1) LADDER in this module. Readers ask
//      `doiGroupOfPoint(p)` instead of reading a stored string.
//
// This module is deliberately dependency-free (no `@scaling`, no store): its
// readers live in `hooks/cutDrivenGroups.ts` and the details/hover path, whose
// module graphs must not gain the server transport (same rule as
// clusteringService's injected `committedDoiRevisionFn`).

import type { DataPoint, DoiGroup } from "../dataPreprocessing/dataPreprocessing";

export interface BakedDoiThresholds {
  grayOutDoiThreshold: number;
  annotationDoiThreshold: number;
  insetDoiThreshold: number;
}

/** Record-order DoI, float32, exactly as the server/falloff produced it. */
let field: Float32Array | null = null;
let thresholds: BakedDoiThresholds | null = null;
/** Bumped on every bake/clear — a content version for member-group caches. */
let revision = 0;

/**
 * Publish the field the last server apply materialized as THE DoI state.
 * Called only from `serverPropagation` after `adoptDoiColumn` succeeded, i.e.
 * only when `p.DoI` already resolves to `field[recordIndex]`.
 */
export function setBakedDoi(next: Float32Array, nextThresholds: BakedDoiThresholds): void {
  field = next;
  thresholds = { ...nextThresholds };
  revision += 1;
}

/** Drop the baked state — the client is back to per-point `doiGroup` strings
 * (local fallback, dataset switch, deselect). */
export function clearBakedDoi(): void {
  if (field === null && thresholds === null) return;
  field = null;
  thresholds = null;
  revision += 1;
}

/** The baked record-order field, or null when the client owns per-point DoI. */
export function getBakedDoi(): Float32Array | null {
  return field;
}

/** True while the per-node `doiGroup` strings are stale by design. */
export function isDoiBaked(): boolean {
  return field !== null && thresholds !== null;
}

/** The thresholds the bake was committed under, or null when not baked —
 * the clustering visible-subset filter (#342) evaluates the ladder over the
 * baked field columnar-ly instead of per point. */
export function getBakedThresholds(): BakedDoiThresholds | null {
  return thresholds ? { ...thresholds } : null;
}

/** Content version of the baked state (0 before the first bake). */
export function bakedDoiRevision(): number {
  return revision;
}

/** DoI at a canonical record index — the O(1) hover/details accessor. Null
 * when nothing is baked (caller reads `point.DoI`) or the index is out of
 * range. */
export function doiOf(recordIndex: number): number | null {
  const f = field;
  if (!f || recordIndex < 0 || recordIndex >= f.length) return null;
  return f[recordIndex];
}

/** The `doiGroup` ladder, evaluated instead of stored (propagateDoi's
 * `updateNodeGroup` is the reference implementation; the labeled-exclusion
 * branch is deliberately absent — `serverPropagationEligible` refuses the
 * server path while unlabeled-only mode is on, so no baked point can be
 * label-capped). */
export function doiGroupOfValue(doi: number, t: BakedDoiThresholds): DoiGroup {
  if (doi < t.grayOutDoiThreshold) return "gray";
  if (doi < t.annotationDoiThreshold) return "transparent";
  if (doi < t.insetDoiThreshold) return "annotation";
  return "inset";
}

/** The baked group at a canonical record index, or null when not baked. */
export function doiGroupOf(recordIndex: number): DoiGroup | null {
  const t = thresholds;
  const doi = doiOf(recordIndex);
  if (!t || doi === null) return null;
  return doiGroupOfValue(doi, t);
}

/**
 * The baked group of a point. Index-free on purpose: cluster members are
 * resolved as DataPoint refs against arrays that may be DoI-filtered SUBSETS
 * of the canonical order, so a positional read would be wrong. `p.DoI` is the
 * adopted column, so this is one accessor read plus three compares.
 * Null when nothing is baked — the caller keeps its `p.doiGroup` read.
 */
export function doiGroupOfPoint(p: DataPoint): DoiGroup | null {
  const t = thresholds;
  if (!t || field === null) return null;
  return doiGroupOfValue(p.DoI ?? 0, t);
}
