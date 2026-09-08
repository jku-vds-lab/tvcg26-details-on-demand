// packages/app/src/dataPreprocessing/lazyRows.ts
//
// Row-lazy boot (issue #315 R1b, plan-315-server-first.md §3 + §4).
//
// R1a removed every full-array row walk from the server lane's boot and
// interaction paths, so on a sidecar + server-cut dataset nothing between
// `load` and `first inset` needs a row OBJECT any more — the columns are the
// source of truth. What remained was the cost of building the objects anyway:
// `materializeRecords` copies every column value onto 1M fresh objects
// (~0.86 s of the synth1m dataDraw → boot:commit window).
//
// This module is the seam that skips it. The canonical array is created
// length-N with HOLES; only the ~201 rows that a bounded one-shot genuinely
// probes (the 200-row feature micro-scan and `columnsOf`'s two endpoints) are
// built eagerly. Everything else is built on demand:
//
//   rowAt(points, i)         one row, MEMOIZED into the array slot
//   ensureResidentRows(pts)  the whole array, chunked — the ONE entry to
//                            full-array row access (row-contract §3.3)
//
// Identity contract (plan §2.4 — why memoization is mandatory, not an
// optimization): reconcile keys `Set<DataPoint>`, `__memberHash` is written
// ONTO rows, `HoverDiffGlyphs` prototypes rows with `Object.create(row)`, and
// several registries are WeakMaps keyed by member. A facade returning a fresh
// view per read would break all four silently. `rowAt` therefore writes the
// built row back into the array slot: index i has exactly one instance,
// forever.
//
// The array IDENTITY exists from load time (the loader's own `data` array is
// filled in place), so every registry keyed by it — sidecar columns, validated
// ids, static featureStats, static bootFrame, boot parent id — keeps working
// unchanged.
//
// Fallback lanes are untouched: no sidecar, no server cut, or the
// `window.__rowLazyBoot = false` kill switch ⇒ the classic materialized boot,
// which is the only lane the public build has (row contract §3.5).
//
// Must stay DOM/store-free: the progress chip lives in utils/rowResidency.ts.

import type { PointColumns as SidecarColumns } from "./columnSidecar";
import { makeRecordBuilder } from "./columnSidecar";
import type { DataPoint } from "./dataPreprocessing";
import { FEATURE_MICRO_SCAN_ROWS } from "./featureScan";
import {
  createColumnBackedRowFactory,
  type PointColumns,
  type SidecarColumnSource,
} from "./pointColumns";

/** Rows materialized per slice by ensureResidentRows before yielding. */
const RESIDENCY_SLICE = 100_000;

interface LazyRowState {
  /** Builds the row at canonical index i — the SAME builder the eager
   * materialization uses, so shapes cannot drift (columnSidecar). */
  build: (i: number) => Record<string, unknown>;
  count: number;
  /** True once every hole has been filled (or the array was never lazy). */
  resident: boolean;
  /** In-flight ensureResidentRows, shared by concurrent callers. */
  pending: Promise<void> | null;
}

const lazyByArray = new WeakMap<readonly DataPoint[], LazyRowState>();

// Row-residency prerequisite (issue #315 R3c): on a deferred-columns dataset
// (lazyColumns.ts) full row access is only honest once every declared column
// is attached — otherwise export/labeling walks would read `undefined` where
// the dataset has a value. The registered prerequisite (fetch-all-columns)
// runs at the top of `ensureResidentRows`, BEFORE the row build, and also
// when the rows themselves were never lazy (kill-switch lanes materialize
// rows eagerly while columns stay deferred). WeakMap like everything else.
const residencyPrereqByArray = new WeakMap<readonly DataPoint[], () => Promise<void>>();

/** Register the awaitable that must resolve before `ensureResidentRows` may
 * report full residency (idempotent per array — last registration wins). */
export function registerRowResidencyPrereq(
  points: readonly DataPoint[],
  prereq: () => Promise<void>
): void {
  residencyPrereqByArray.set(points, prereq);
}

/** True when a residency prerequisite is registered for `points` — chip
 * wrappers use it to keep their fast-path skip honest. */
export function hasRowResidencyPrereq(points: readonly DataPoint[]): boolean {
  return residencyPrereqByArray.has(points);
}

/**
 * The kill switch (plan §7 A/B levers): `window.__rowLazyBoot = false` in the
 * console before a load reverts that load to the classic materialized boot, so
 * the census A/B is a page reload rather than a rebuild.
 */
export function rowLazyBootEnabled(): boolean {
  return (globalThis as { __rowLazyBoot?: boolean }).__rowLazyBoot !== false;
}

/**
 * The client-lane lever (issue #315 R3d, plan §6.1): `window.__clientLazyBoot
 * = false` reverts static-bootFrame datasets WITHOUT a cut provider to the
 * classic materialized boot — R3d's own A/B, independent of `__rowLazyBoot`
 * (which kills both lanes).
 */
export function clientLazyBootEnabled(): boolean {
  return (globalThis as { __clientLazyBoot?: boolean }).__clientLazyBoot !== false;
}

// Residency waiters (issue #315 R3d): consumers that must WAIT for residency
// without TRIGGERING it — the background index builds, which on the client
// lazy lane must not start the materialization that is deliberately idle-
// scheduled after first inset. Resolved by whichever path completes residency
// (chunked, blocking, or the JSON-fallback un-register).
const residentWaiters = new WeakMap<readonly DataPoint[], Array<() => void>>();

function notifyResidentWaiters(points: readonly DataPoint[]): void {
  const waiters = residentWaiters.get(points);
  if (!waiters) return;
  residentWaiters.delete(points);
  for (const w of waiters) w();
}

/**
 * Resolves once every row of `points` is resident — immediately for arrays
 * that were never lazy. Never triggers materialization and never rejects; the
 * caller that owns the lane (useInitialClustering's deferred block, the local
 * propagation oracle, export paths) is responsible for eventually running it.
 */
export function whenRowsResident(points: readonly DataPoint[]): Promise<void> {
  if (areRowsResident(points)) return Promise.resolve();
  return new Promise((resolve) => {
    const waiters = residentWaiters.get(points) ?? [];
    waiters.push(resolve);
    residentWaiters.set(points, waiters);
  });
}

/**
 * Turn `into` (the loader's canonical, still-empty array) into a length-N
 * array of holes served by `rowAt`, and build the bounded eager prefix.
 *
 * `eagerRows` covers the synchronous feature micro-scan; index N−1 is added on
 * top because `columnsOf` probes both endpoints for the columns link, and the
 * born-rows fast path of `attachPointColumns` checks the same two rows.
 */
export function createLazyRowArray(
  into: DataPoint[],
  sidecar: SidecarColumns,
  cols: PointColumns,
  opts?: {
    eagerRows?: number;
    /** Deferred-column prototype accessors (issue #315 R3c) — see
     * createColumnBackedRowFactory. */
    deferred?: { names: readonly string[]; source: SidecarColumnSource };
  }
): DataPoint[] {
  const count = sidecar.count;
  const build = makeRecordBuilder(
    sidecar,
    createColumnBackedRowFactory(cols, opts?.deferred)
  ) as (i: number) => Record<string, unknown>;

  into.length = count;
  const state: LazyRowState = { build, count, resident: count === 0, pending: null };
  lazyByArray.set(into, state);

  const eager = Math.min(count, opts?.eagerRows ?? FEATURE_MICRO_SCAN_ROWS);
  for (let i = 0; i < eager; i++) into[i] = build(i) as unknown as DataPoint;
  if (count > 0) into[count - 1] = (into[count - 1] ?? build(count - 1)) as unknown as DataPoint;
  return into;
}

/** True when `points` serves rows lazily (server lane) rather than holding
 * them all (every other lane, including the whole public build). */
export function isLazyRowArray(points: readonly DataPoint[]): boolean {
  return lazyByArray.has(points);
}

/** Un-register the lazy lane for `points` — the loader calls it when a sidecar
 * failure sends the same array down the JSON-chunk fallback, so the rows it
 * pushes are treated as the fully resident array they are. */
export function clearLazyRowArray(points: readonly DataPoint[]): void {
  lazyByArray.delete(points);
  // The array is now the fully resident array the JSON fallback pushes into.
  notifyResidentWaiters(points);
}

/** True when every index of `points` holds a row — trivially true for arrays
 * that were never lazy. Contract members use it to keep their synchronous
 * path byte-identical on the classic lane. */
export function areRowsResident(points: readonly DataPoint[]): boolean {
  const state = lazyByArray.get(points);
  return state === undefined || state.resident;
}

/**
 * The row at canonical index `i`, built and memoized into the array slot on
 * first ask. On a non-lazy array this is a plain indexing (and returns
 * undefined for a genuinely out-of-range index, exactly like `points[i]`).
 */
export function rowAt(points: readonly DataPoint[], i: number): DataPoint | undefined {
  const row = points[i];
  if (row !== undefined) return row;
  const state = lazyByArray.get(points);
  if (!state || i < 0 || i >= state.count) return undefined;
  const built = state.build(i) as unknown as DataPoint;
  (points as DataPoint[])[i] = built;
  return built;
}

/**
 * Rows for a bounded canonical-index subset (row contract §3.3): each row
 * resolves through `rowAt`, so holes materialize (and memoize) instead of
 * leaking `undefined` into the copy. The visible-subset clustering fallback
 * consumes this when the server fit failed — its local fit walks the subset
 * as a plain resident array afterwards, which slot reads cannot serve on the
 * lazy lane.
 */
export function subsetRowsByIndex(
  points: readonly DataPoint[],
  indices: readonly number[]
): DataPoint[] {
  const out = new Array<DataPoint>(indices.length);
  for (let k = 0; k < indices.length; k++) out[k] = rowAt(points, indices[k])!;
  return out;
}

/**
 * Materialize every remaining row NOW, blocking the thread.
 *
 * The awaitable `ensureResidentRows` is the contract entry; this is its
 * escape hatch for synchronous row consumers that cannot yield and cannot be
 * made columnar cheaply — today only the LOCAL DoI-propagation oracle, which
 * on a server-lane dataset runs exactly when the server apply already failed.
 * Blocking there is the honest trade: the degraded path costs what the classic
 * boot used to, instead of degrading a second time into wrong values.
 */
export function materializeRowsBlocking(points: readonly DataPoint[]): void {
  const state = lazyByArray.get(points);
  if (!state || state.resident) return;
  const arr = points as DataPoint[];
  for (let i = 0; i < state.count; i++) {
    if (arr[i] === undefined) arr[i] = state.build(i) as unknown as DataPoint;
  }
  state.resident = true;
  notifyResidentWaiters(points);
}

/**
 * Materialize every remaining row (row contract §3.2: the ONE entry to
 * full-array row access). Chunked with the same slice-yield cadence as the
 * eager materialization it replaces, idempotent, and abortable — an aborted
 * run leaves the rows it already built in place and lets a later call finish
 * the job.
 *
 * Resolves immediately (still asynchronously) when the array was never lazy,
 * so callers on the classic lane pay nothing; callers that must stay
 * synchronous there gate on `areRowsResident` first.
 */
export async function ensureResidentRows(
  points: readonly DataPoint[],
  opts?: {
    signal?: AbortSignal;
    sliceSize?: number;
    /** Called after each slice with (done, total) for a progress chip. */
    onProgress?: (done: number, total: number) => void;
  }
): Promise<void> {
  // Deferred columns first (issue #315 R3c): the fetch-then-materialize
  // ordering is what lets export/labeling paths keep their unchanged call
  // sites — after this await, rows AND every declared column are readable.
  // Cheap no-op when nothing is registered or everything is attached.
  const prereq = residencyPrereqByArray.get(points);
  if (prereq) await prereq();
  const state = lazyByArray.get(points);
  if (!state || state.resident) return;
  if (state.pending) return state.pending;

  const sliceSize = opts?.sliceSize ?? RESIDENCY_SLICE;
  const arr = points as DataPoint[];
  const run = (async () => {
    for (let start = 0; start < state.count; start += sliceSize) {
      if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const end = Math.min(state.count, start + sliceSize);
      for (let i = start; i < end; i++) {
        if (arr[i] === undefined) arr[i] = state.build(i) as unknown as DataPoint;
      }
      opts?.onProgress?.(end, state.count);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    state.resident = true;
    notifyResidentWaiters(points);
  })();

  state.pending = run;
  try {
    await run;
  } finally {
    // Clearing on failure too: an aborted run must not leave a rejected
    // promise that every later caller re-awaits.
    state.pending = null;
  }
}
