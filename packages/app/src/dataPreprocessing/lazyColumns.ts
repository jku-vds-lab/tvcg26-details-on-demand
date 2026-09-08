// packages/app/src/dataPreprocessing/lazyColumns.ts
//
// Deferred-column residency (issue #315 R3c, plan-315-server-first.md §6.1).
//
// An endgame (R3a) manifest ships only the boot-critical columns in
// `columns.bin` — x, y, line, id, the preset colorEncoding column — and
// declares every other column in a `deferredColumns` section: names and
// types WITHOUT bytes. The row prototype carries one enumerable accessor per
// deferred name (the DoI/`selected` pattern, pointColumns.ts), reading
// through the registered sidecar's `byName` slot: `undefined` before the
// column is fetched, live values after — SAME row instance, so a row built
// before the fetch gains the fields retroactively (plan §2.4).
//
// This module is the fetch seam. `ensureResidentColumns(points, names)` is
// the ONE entry: it fetches the missing columns via the loader-provided
// transport (the `@scaling` columns provider — dead code in the public
// build), attaches the decoded arrays into the REGISTERED sidecar object
// (the renderer and every columnar reader look `byName` up at call time),
// and shares in-flight fetches so concurrent callers never double-download.
//
// CS 2026-08-03 (§8.8a-c): this on-demand fetch is the ONE mechanism — no
// pre-fetch lane, no core-residency exceptions. It gates like an
// interaction (≤ 300 ms warm per column at 1M proposed).
//
// Must stay DOM/store-free (worker + jest graphs); the progress chip lives
// in utils/rowResidency.ts.

import type { PointColumns as SidecarColumns } from "./columnSidecar";
import type { DataPoint } from "./dataPreprocessing";
import { registerRowResidencyPrereq } from "./lazyRows";

/** One manifest `deferredColumns` entry: a sidecar column minus the bytes. */
export interface DeferredColumnEntry {
  name: string;
  dtype: "f64" | "f32" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";
  scale?: number;
  categories?: Array<string | number | boolean | null>;
}

/** Decoded columns as the transport returns them (columnSidecar shape). */
export type FetchColumns = (names: string[]) => Promise<SidecarColumns>;

interface DeferredColumnsState {
  /** The REGISTERED sidecar object — attach mutates its `byName` in place. */
  sidecar: SidecarColumns;
  entries: Map<string, DeferredColumnEntry>;
  fetchColumns: FetchColumns;
  /** In-flight fetch per column name, shared by concurrent callers and
   * cleared on failure so a later call can retry. */
  inflight: Map<string, Promise<void>>;
}

const deferredByArray = new WeakMap<readonly DataPoint[], DeferredColumnsState>();

/** Attach listeners (module-level): UI glue subscribes once to re-render
 * surfaces whose inputs became readable (overlay labels, color encodings). */
type AttachListener = (points: readonly DataPoint[], names: string[]) => void;
const attachListeners = new Set<AttachListener>();

/**
 * The kill switch (plan §6.1 A/B levers): `window.__deferColumns = false` in
 * the console before a load makes the loader fetch every declared deferred
 * column during boot — the fat-download A/B without a manifest rebuild.
 */
export function deferColumnsEnabled(): boolean {
  return (globalThis as { __deferColumns?: boolean }).__deferColumns !== false;
}

/**
 * Register the deferred-column set for a canonical rows array. Called by the
 * loader once per deferred-manifest load, BEFORE any row is built (the row
 * factory needs the names for its prototype accessors). Also installs the
 * row-residency prerequisite: `ensureResidentRows` on this array fetches all
 * deferred columns first, so full row access never reads `undefined` where
 * the dataset has a value (plan §6.1 identity audit).
 */
export function registerDeferredColumns(
  points: readonly DataPoint[],
  sidecar: SidecarColumns,
  entries: readonly DeferredColumnEntry[],
  fetchColumns: FetchColumns
): void {
  const state: DeferredColumnsState = {
    sidecar,
    entries: new Map(entries.map((e) => [e.name, e])),
    fetchColumns,
    inflight: new Map(),
  };
  deferredByArray.set(points, state);
  registerRowResidencyPrereq(points, () =>
    ensureResidentColumns(points, deferredColumnNames(points))
  );
}

/** Un-register (loader fallback path — mirrors clearLazyRowArray). */
export function clearDeferredColumns(points: readonly DataPoint[]): void {
  deferredByArray.delete(points);
}

/** The manifest-declared deferred column names for `points` ([] when the
 * dataset has none — every fat-manifest and public-build load). */
export function deferredColumnNames(points: readonly DataPoint[]): string[] {
  const state = deferredByArray.get(points);
  return state ? Array.from(state.entries.keys()) : [];
}

/** The manifest entry for one deferred column, if declared. */
export function deferredColumnEntry(
  points: readonly DataPoint[],
  name: string
): DeferredColumnEntry | undefined {
  return deferredByArray.get(points)?.entries.get(name);
}

/**
 * The subset of `names` that are declared deferred AND not yet attached —
 * what a caller must `ensureResidentColumns` before a columnar read can see
 * them. Empty on every non-deferred lane, so gating on `.length` is free.
 */
export function pendingDeferredColumns(
  points: readonly DataPoint[],
  names: readonly string[]
): string[] {
  const state = deferredByArray.get(points);
  if (!state) return [];
  return names.filter(
    (n) => state.entries.has(n) && state.sidecar.byName[n] === undefined
  );
}

/** True while any declared deferred column is still server-resident. */
export function hasPendingDeferredColumns(points: readonly DataPoint[]): boolean {
  const state = deferredByArray.get(points);
  if (!state) return false;
  for (const name of state.entries.keys()) {
    if (state.sidecar.byName[name] === undefined) return true;
  }
  return false;
}

/**
 * Fetch + attach the named deferred columns (row contract §3.6: a deferred
 * column is readable only after this resolves). Idempotent; concurrent
 * callers share in-flight fetches per column; a failed fetch clears its
 * in-flight slots so the next call retries. Non-deferred names resolve
 * without work, so callers may pass any column list.
 */
export async function ensureResidentColumns(
  points: readonly DataPoint[],
  names: readonly string[]
): Promise<void> {
  const state = deferredByArray.get(points);
  if (!state) return;
  const wanted = names.filter((n) => state.entries.has(n));
  if (wanted.length === 0) return;

  const toFetch = wanted.filter(
    (n) => state.sidecar.byName[n] === undefined && !state.inflight.has(n)
  );
  if (toFetch.length > 0) {
    const run = (async () => {
      const fetched = await state.fetchColumns(toFetch);
      if (fetched.count !== state.sidecar.count) {
        throw new Error(
          `Deferred columns count mismatch: got ${fetched.count}, expected ${state.sidecar.count}`
        );
      }
      for (const name of toFetch) {
        const col = fetched.byName[name];
        if (col === undefined) {
          throw new Error(`Deferred column ${name} missing from the fetch response`);
        }
        state.sidecar.byName[name] = col;
      }
      for (const listener of attachListeners) listener(points, toFetch);
    })();
    for (const name of toFetch) state.inflight.set(name, run);
    // Win or lose, the in-flight slots clear: attached columns short-circuit
    // on `byName`, failures become retryable.
    void run.catch(() => undefined).finally(() => {
      for (const name of toFetch) {
        if (state.inflight.get(name) === run) state.inflight.delete(name);
      }
    });
  }

  const waits: Promise<void>[] = [];
  for (const name of wanted) {
    const inflight = state.inflight.get(name);
    if (inflight) waits.push(inflight);
  }
  await Promise.all(waits);
}

/**
 * Subscribe to column attaches (any dataset). UI glue uses this to bump a
 * store revision so memoized inset labels / color encodings re-resolve once
 * their column became readable. Returns the unsubscribe.
 */
export function onDeferredColumnsAttached(listener: AttachListener): () => void {
  attachListeners.add(listener);
  return () => attachListeners.delete(listener);
}
