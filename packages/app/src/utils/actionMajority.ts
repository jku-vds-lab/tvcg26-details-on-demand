// Columnar action majority for `__leafRange`-marked sample arrays (issue
// #315 insets-at-boot I2).
//
// The node-inset overlay label falls back to the majority of the action
// column, walked per member through `actionLabelOf` — ~107 ms of closure +
// property reads on the 1M boot first-apply, where the winners span the
// whole dataset. A range-marked group IS the cluster's full membership in
// leaf order, so the same majority resolves with two typed-array reads per
// member straight from the sidecar action column.
//
// Dependency shape: this module must stay rbush/DOM-free (it sits on the
// renderer import graph, which many jest suites load without the rbush
// mock) — the leaf order + canonical rows are therefore REGISTERED here by
// `cutDrivenGroups` (which owns the clustering context) instead of being
// pulled from `hdbscanClustering`. The WeakMap key is the exact samples
// array built for those ranges, so a stale or foreign context is
// unrepresentable; every gate failure returns null and the caller keeps
// the exact per-member path.

import {
  groupMemberCount,
  groupMemberIndexAt,
  groupMembersOf,
} from "../clustering/groupMembers";
import { sidecarColumnsFor } from "../dataPreprocessing/columnSidecar";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident } from "../dataPreprocessing/lazyRows";
import { leafRangeOf } from "../scaling.types";

const columnarCtx = new WeakMap<
  readonly DataPoint[],
  { order: ArrayLike<number>; nodes: readonly DataPoint[] }
>();

/** Called by cutDrivenGroups for full-membership (range-marked) group
 * arrays: captures the leaf order the ranges index and the canonical rows
 * the sidecar columns are registered for. */
export function registerActionMajorityContext(
  samples: readonly DataPoint[],
  order: ArrayLike<number>,
  nodes: readonly DataPoint[]
): void {
  columnarCtx.set(samples, { order, nodes });
}

/**
 * Pure core: byte-identical to
 * `majorityVoteBy(samples, actionLabelOf)` over the members
 * `order[first..last)` — raw-value counting first (dict columns hold
 * category strings; numeric columns count by number and stringify only the
 * UNIQUE values — Map's SameValueZero collapses exactly what String()
 * collapses: NaN and ±0), then the same plain-object + stable-sort
 * tie-breaking as majorityVote, with first-seen order equal to the
 * per-member path's (both walk the leaf order).
 */
export function actionMajorityFromColumn(
  col: ArrayLike<unknown>,
  order: ArrayLike<number>,
  first: number,
  last: number
): { label: string; multiple: boolean } {
  const raw = new Map<unknown, number>();
  for (let k = first; k < last; k++) {
    const v = col[order[k]];
    if (v === undefined || v === null) continue;
    raw.set(v, (raw.get(v) ?? 0) + 1);
  }
  const counts: Record<string, number> = {};
  for (const [v, n] of raw) {
    const s = typeof v === "string" ? v : String(v);
    if (s !== "") counts[s] = (counts[s] ?? 0) + n;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return { label: "", multiple: false };
  entries.sort((a, b) => b[1] - a[1]);
  return { label: entries[0][0], multiple: entries.length > 1 };
}

/**
 * The columnar majority for `samples` when every gate holds (points-tree
 * single-range marker, a registered build-time context, sidecar columns
 * with an action column, and the marker covering the array exactly); null
 * otherwise — callers fall back to the per-member walk.
 */
export function actionMajorityColumnarOf(
  samples: DataPoint[]
): { label: string; multiple: boolean } | null {
  // Index-backed groups (issue #315 R1c) carry their membership as a spec —
  // list specs (doiGroup-filtered subsets) have no range marker, so this
  // branch is what keeps their overlay label columnar.
  const spec = groupMembersOf(samples);
  if (spec) {
    const col = sidecarColumnsFor(spec.nodes)?.byName["action"];
    if (!col) return null;
    const n = groupMemberCount(spec);
    if (samples.length !== n) return null;
    const raw = new Map<unknown, number>();
    for (let k = 0; k < n; k++) {
      const v = col[groupMemberIndexAt(spec, k)];
      if (v === undefined || v === null) continue;
      raw.set(v, (raw.get(v) ?? 0) + 1);
    }
    return tallyMajority(raw);
  }
  const marker = leafRangeOf(samples);
  if (!marker || marker.tree !== "points" || marker.ranges.length !== 1) return null;
  const ctx = columnarCtx.get(samples);
  if (!ctx) return null;
  const col = sidecarColumnsFor(ctx.nodes)?.byName["action"];
  if (!col) return null;
  const [first, last] = marker.ranges[0];
  if (samples.length !== last - first) return null;
  return actionMajorityFromColumn(col, ctx.order, first, last);
}

/**
 * Columnar majority of ANY sidecar column for an index-backed group,
 * with `getAnnotationValueOrPlaceholder` semantics: every member votes —
 * a missing/empty value votes for `placeholder`, values stringify and
 * trim — then the same plain-object + stable-sort tie-breaking as
 * `majorityVoteBy` (issue #315 R1c: the group-label majority walked every
 * member row; an index-backed group has no rows to walk).
 *
 * Null ⇒ caller falls back to a row path: when the samples carry no spec
 * (resident/client lane — the legacy walk is exact), when the rows became
 * resident (labeling may have written `__assignedLabel` overrides the
 * sidecar cannot see), or when the column has no sidecar backing.
 */
export function columnMajorityColumnarOf(
  samples: DataPoint[],
  column: string,
  placeholder: string
): { label: string; multiple: boolean } | null {
  const spec = groupMembersOf(samples);
  if (!spec) return null;
  if (areRowsResident(spec.nodes)) return null;
  const col = sidecarColumnsFor(spec.nodes)?.byName[column];
  if (!col) return null;
  const n = groupMemberCount(spec);
  if (samples.length !== n) return null;
  const raw = new Map<unknown, number>();
  let missing = 0;
  for (let k = 0; k < n; k++) {
    const v = col[groupMemberIndexAt(spec, k)];
    if (v === undefined || v === null) {
      missing++;
      continue;
    }
    raw.set(v, (raw.get(v) ?? 0) + 1);
  }
  const counts: Record<string, number> = {};
  let emptyish = missing;
  for (const [v, cnt] of raw) {
    const s = (typeof v === "string" ? v : String(v)).trim();
    if (s === "") emptyish += cnt;
    else counts[s] = (counts[s] ?? 0) + cnt;
  }
  if (emptyish > 0 && placeholder !== "") {
    counts[placeholder] = (counts[placeholder] ?? 0) + emptyish;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return { label: "", multiple: false };
  entries.sort((a, b) => b[1] - a[1]);
  return { label: entries[0][0], multiple: entries.length > 1 };
}

/** The shared actionLabelOf-parity tail: raw counting → string counts with
 * "" excluded → stable-sorted plain object (see actionMajorityFromColumn's
 * contract comment). */
function tallyMajority(raw: Map<unknown, number>): { label: string; multiple: boolean } {
  const counts: Record<string, number> = {};
  for (const [v, n] of raw) {
    const s = typeof v === "string" ? v : String(v);
    if (s !== "") counts[s] = (counts[s] ?? 0) + n;
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) return { label: "", multiple: false };
  entries.sort((a, b) => b[1] - a[1]);
  return { label: entries[0][0], multiple: entries.length > 1 };
}
