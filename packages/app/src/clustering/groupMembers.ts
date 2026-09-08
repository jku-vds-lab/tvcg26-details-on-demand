// packages/app/src/clustering/groupMembers.ts
//
// Member specs for index-backed cut-driven group arrays (issue #315 R1c).
//
// R1b resolved every active-cluster member through `rowAt` at group-build
// time — at the boot view the winners span ~the whole 1M dataset, so the
// deferred materialization was repaid inside the select-frame apply
// (+~0.35 s, plan §4 R1b Finding 2). R1c groups carry their membership as
// data instead: a group array built on the non-resident lazy lane is a
// HOLEY `DataPoint[]` of the member count, and its members live here as a
// registered spec — either the cluster's half-open leaf range over the
// boot-once leaf order, or an explicit canonical-index list for
// doiGroup-filtered subsets. The bounded sampling consumers (inset content
// probe, hover-diff stride, `samples[0]` label resolution, backend member
// refs) materialize exactly the rows they touch through `rowAt`; everything
// else reads columns.
//
// Identity: a spec'd array never exposes row identity (its slots stay
// holes). Reconcile compares spec'd memberships by index sequence under a
// hierarchy (`reconcileClusterItems`), never by slot — see the
// sameMembership spec branch for why the pairwise loop must not run.
//
// Must stay DOM/store/rbush-free: this module sits on the renderer import
// graph (BaseInsetRenderer, HoverDiffGlyphs) like utils/actionMajority.

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident, rowAt } from "../dataPreprocessing/lazyRows";
import { columnsOf } from "../dataPreprocessing/pointColumns";

interface GroupMemberSpecBase {
  /** The canonical (lazy) rows array the member indices point into. */
  nodes: readonly DataPoint[];
  /** Leaf positions renumber on recluster — specs from two hierarchies
   * never compare equal (same rule as the `__leafRange` digest). */
  hierarchyId: number;
}

export interface RangeMemberSpec extends GroupMemberSpecBase {
  kind: "range";
  /** Boot-once leaf order; members are order[first..last). */
  order: ArrayLike<number>;
  first: number;
  last: number;
}

export interface ListMemberSpec extends GroupMemberSpecBase {
  kind: "list";
  /** Kept canonical indices, in leaf order. */
  indices: Int32Array;
}

export type GroupMemberSpec = RangeMemberSpec | ListMemberSpec;

const specs = new WeakMap<readonly DataPoint[], GroupMemberSpec>();

/** Called by cutDrivenGroups for every index-backed group array it builds.
 * The WeakMap key is the exact array, so a stale spec is unrepresentable. */
export function registerGroupMembers(
  samples: readonly DataPoint[],
  spec: GroupMemberSpec
): void {
  specs.set(samples, spec);
}

/** The member spec of an index-backed group array, or undefined for a
 * plain row-carrying array (the resident/client lane). */
export function groupMembersOf(
  samples: readonly DataPoint[]
): GroupMemberSpec | undefined {
  return specs.get(samples);
}

export function groupMemberCount(spec: GroupMemberSpec): number {
  return spec.kind === "range" ? spec.last - spec.first : spec.indices.length;
}

/** Canonical index of member k (0-based within the group). */
export function groupMemberIndexAt(spec: GroupMemberSpec, k: number): number {
  return spec.kind === "range"
    ? (spec.order[spec.first + k] as number)
    : spec.indices[k];
}

/**
 * Member k as a row. Spec'd arrays resolve through `rowAt` (one memoized
 * instance per canonical index — plan §2.4); plain arrays read the slot,
 * so callers can use this unconditionally.
 */
export function groupMemberRowAt(
  samples: readonly DataPoint[],
  k: number
): DataPoint | undefined {
  const spec = specs.get(samples);
  if (!spec) return samples[k];
  return rowAt(spec.nodes, groupMemberIndexAt(spec, k));
}

/** The `samples[0]` accessor for label resolution paths. */
export function groupFirstRow(
  samples: readonly DataPoint[]
): DataPoint | undefined {
  return groupMemberRowAt(samples, 0);
}

/**
 * The first ≤ cap member rows (the bounded column-detection probe contract —
 * `slice(0, cap)` on a plain array), materialized through `rowAt` on
 * index-backed groups. The edge-diff renderers probe the `__edgeSides`
 * arrays, which ARE the original (possibly holey) group arrays — a direct
 * `slice` there spreads holes as `undefined` (issue #315 R1c E2E finding).
 */
export function groupHeadRows(
  samples: readonly DataPoint[],
  cap: number
): DataPoint[] {
  const spec = specs.get(samples);
  if (!spec) return samples.slice(0, cap);
  const n = Math.min(groupMemberCount(spec), cap);
  const out: DataPoint[] = [];
  for (let k = 0; k < n; k++) {
    const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
    if (row) out.push(row);
  }
  return out;
}

/**
 * Even-stride subsample of ≤ cap member rows (the featureStats
 * `strideSample` contract), materialized through `rowAt`. Null for plain
 * arrays — callers keep their existing direct-slot sampling.
 */
export function groupStrideRows(
  samples: readonly DataPoint[],
  cap: number
): DataPoint[] | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  const n = groupMemberCount(spec);
  const take = Math.min(n, cap);
  const stride = n <= cap ? 1 : n / cap;
  const out: DataPoint[] = [];
  for (let i = 0; i < take; i++) {
    const k = n <= cap ? i : Math.floor(i * stride);
    const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
    if (row) out.push(row);
  }
  return out;
}

/**
 * Member refs ({id, line}) straight from the canonical columns — the
 * backend adapter's fallback ref materialization without building rows.
 * Null for plain arrays; falls back to bounded `rowAt` reads only if the
 * columns are somehow missing (unreachable on the lazy lane, which is
 * born column-backed).
 */
export function groupMemberRefs(
  samples: readonly DataPoint[]
): Array<{ id: number; line: number }> | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  const n = groupMemberCount(spec);
  const cols = columnsOf(spec.nodes);
  const out: Array<{ id: number; line: number }> = new Array(n);
  if (cols) {
    for (let k = 0; k < n; k++) {
      const i = groupMemberIndexAt(spec, k);
      out[k] = { id: cols.id[i], line: cols.line[i] };
    }
  } else {
    for (let k = 0; k < n; k++) {
      const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
      out[k] = { id: row?.id ?? NaN, line: row?.line ?? NaN };
    }
  }
  return out;
}

/** Columnar centroid over the member indices. Null for plain arrays. */
export function groupMeanPoint(
  samples: readonly DataPoint[]
): { x: number; y: number } | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  const n = groupMemberCount(spec);
  if (n === 0) return { x: 0, y: 0 };
  const cols = columnsOf(spec.nodes);
  let sx = 0;
  let sy = 0;
  if (cols) {
    for (let k = 0; k < n; k++) {
      const i = groupMemberIndexAt(spec, k);
      sx += cols.x[i];
      sy += cols.y[i];
    }
  } else {
    for (let k = 0; k < n; k++) {
      const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
      if (!row) continue;
      sx += row.x;
      sy += row.y;
    }
  }
  return { x: sx / n, y: sy / n };
}

/**
 * Member x/y as typed views + the spec to index them with — the hull
 * fallback iterates `xs[groupMemberIndexAt(spec, k)]` without rows. Null
 * for plain arrays or when the columns are missing (caller keeps its
 * row loop).
 */
export function groupMemberXY(samples: readonly DataPoint[]): {
  spec: GroupMemberSpec;
  count: number;
  xs: ArrayLike<number>;
  ys: ArrayLike<number>;
} | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  const cols = columnsOf(spec.nodes);
  if (!cols) return null;
  return { spec, count: groupMemberCount(spec), xs: cols.x, ys: cols.y };
}

/**
 * Member rows for an exact-when-possible majority vote (issue #315 R1c —
 * the group-label fallback when no sidecar column serves): all member rows
 * once the canonical array is resident (cheap slot reads; exact, including
 * labeling's `__assignedLabel` overrides), a ≤ strideCap strided subset
 * while it is not (display-only, the hover-diff cap precedent). Null for
 * plain arrays — callers vote over the samples directly.
 */
export function groupVoteRows(
  samples: readonly DataPoint[],
  strideCap: number
): DataPoint[] | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  if (!areRowsResident(spec.nodes)) return groupStrideRows(samples, strideCap);
  const n = groupMemberCount(spec);
  const out: DataPoint[] = [];
  for (let k = 0; k < n; k++) {
    const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
    if (row) out.push(row);
  }
  return out;
}

/**
 * True when any member's id is in `ids` — the freehand-coverage test
 * (`sharesFreehandMembers`) for index-backed groups, via the id column.
 * Null for plain arrays.
 */
export function groupSharesAnyId(
  samples: readonly DataPoint[],
  ids: ReadonlySet<number>
): boolean | null {
  const spec = specs.get(samples);
  if (!spec) return null;
  const cols = columnsOf(spec.nodes);
  const n = groupMemberCount(spec);
  if (cols) {
    for (let k = 0; k < n; k++) {
      if (ids.has(cols.id[groupMemberIndexAt(spec, k)])) return true;
    }
    return false;
  }
  for (let k = 0; k < n; k++) {
    const row = rowAt(spec.nodes, groupMemberIndexAt(spec, k));
    if (row && ids.has(row.id)) return true;
  }
  return false;
}
