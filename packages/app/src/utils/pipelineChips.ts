// src/utils/pipelineChips.ts
//
// The two-chip taxonomy (issue #315 P7, plan-315-p7-server-select.md §2 A5,
// design-seam-first.md §4.4): `refining` / `doi`. Every chip is SET at cause
// time (fit dispatch, propagate dispatch) and CLEARED at effect time (fitted
// frame applied, overlay applied). There are no timers and no `minShowMs`
// guard: when a cause and its effect land in the SAME tick — a propagate that
// routes back to the local path — React 18 batches the two dispatches and the
// dock never paints, so instant work cannot flash a chip.
//
// The `refining` chip is the fit chip shipped in `hdbscanClustering.ts`
// (`runBackgroundSubsetRefine`); it is already A5-shaped and stays there
// because it also carries the worker's progress fractions. This module owns
// the `doi` chip, a server round trip (hence `kind: "io"`, against the compute
// chips the local pipeline raises).
//
// A cluster-cut chip used to live here too. It was dropped (CS 2026-07-25):
// cut latency is now low enough that a view update needs no indicator at all.

import { completeTask, startTask } from "./progressApi";

const DOI_TASK_ID = "task:chip:doi";

// ── doi chip ─────────────────────────────────────────────────────────────────

/** Re-entrancy depth: a slider commit that 409s re-seeds through the selection
 * path, and the two nested dispatches must read as ONE pending state. */
let doiDepth = 0;

/** Cause: a server DoI propagate was dispatched. */
export function beginDoiChip(): void {
  if (doiDepth++ > 0) return;
  startTask({
    id: DOI_TASK_ID,
    label: "Interest",
    phase: "Updating interest…",
    kind: "io",
    value: null,
    progressMode: "indeterminate",
  });
}

/** Effect: the overlay / distance field was applied (or the call fell back). */
export function endDoiChip(): void {
  if (doiDepth === 0) return;
  if (--doiDepth > 0) return;
  completeTask(DOI_TASK_ID);
}
