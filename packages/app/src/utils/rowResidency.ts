// packages/app/src/utils/rowResidency.ts
//
// Progress chip for the row-lazy seam (issue #315 R1b). `ensureResidentRows`
// stays store-free so it can be unit-tested and imported from the member
// resolution hot path; this wrapper is what the CONTRACT MEMBERS call — the
// rare, user-initiated consumers that genuinely need every row object
// (labeling sync/assign, the local feature-stats fallback). They are the only
// places a user can see the cost, so they are the only places that announce it
// ("chip at cause time", plan §4 R1b).
//
// On every other lane the array was never lazy: `areRowsResident` is true, no
// task is ever started, and the awaited call resolves without work.

import { areRowsResident, ensureResidentRows } from "../dataPreprocessing/lazyRows";
import {
  ensureResidentColumns,
  hasPendingDeferredColumns,
  pendingDeferredColumns,
} from "../dataPreprocessing/lazyColumns";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { completeTask, failTask, startTask, updateTask } from "./progressApi";
import { warnServerLoss } from "./serverLoss";

let chipSeq = 0;

/**
 * Materialize every row of `points`, showing a progress chip while it runs.
 * Resolves immediately when the rows are already resident.
 */
export async function ensureResidentRowsWithChip(
  points: readonly DataPoint[],
  label = "Preparing rows",
  signal?: AbortSignal
): Promise<void> {
  // Deferred columns keep the skip honest (issue #315 R3c): resident rows on
  // a deferred-columns dataset still owe the column fetch before full row
  // access is truthful — ensureResidentRows awaits it via its prerequisite.
  if (areRowsResident(points) && !hasPendingDeferredColumns(points)) return;
  const id = `row-residency:${++chipSeq}`;
  startTask({
    id,
    label,
    kind: "compute",
    phase: "Preparing rows…",
    value: 0,
    minShowMs: 200,
    progressMode: "predictive",
  });
  try {
    await ensureResidentRows(points, {
      signal,
      onProgress: (done, total) =>
        updateTask({ id, phase: "Preparing rows…", value: Math.min(99, (done / total) * 100) }),
    });
    updateTask({ id, value: 100 });
    completeTask(id);
  } catch (err) {
    failTask(id, signal?.aborted ? "Cancelled" : "Failed to prepare rows");
    throw err;
  }
}

/**
 * Fetch the named deferred columns, showing a progress chip while the
 * network round trip runs (issue #315 R3c — the user-visible wrapper of
 * `ensureResidentColumns`, mirroring the rows chip above). Resolves
 * immediately when nothing is pending, so callers may invoke it
 * unconditionally with any column list.
 */
export async function ensureResidentColumnsWithChip(
  points: readonly DataPoint[],
  names: readonly string[],
  label = "Fetching columns"
): Promise<void> {
  const pending = pendingDeferredColumns(points, names);
  if (pending.length === 0) return;
  const id = `column-residency:${++chipSeq}`;
  startTask({
    id,
    label,
    kind: "io",
    phase: "Fetching columns…",
    value: null,
    minShowMs: 200,
    progressMode: "indeterminate",
  });
  try {
    await ensureResidentColumns(points, pending);
    completeTask(id);
  } catch (err) {
    failTask(id, "Failed to fetch columns — is the dataset server running?");
    // Unreachable deferred columns = the server-loss story (issue #315
    // §8.8d): the degraded state must be LOUD, not a vanished chip.
    warnServerLoss();
    throw err;
  }
}
