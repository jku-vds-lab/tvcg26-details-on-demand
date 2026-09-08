// src/utils/deferPastFirstInput.ts
//
// Issue #315 Arc 1 Task 3a — defer the server-cut initial clustering past
// the user's FIRST input. On server-cut datasets the boot "Clustering" pass
// (O(n) DoI marking, leaf-order fetches, label buffers, first cut apply)
// used to land exactly when the G4 aggregate base became interactive,
// stalling the user's first gesture. This helper runs the deferred work:
//  - after the first input burst goes quiet (`quietMs` after the last
//    pointerdown/pointerup/wheel/drag-move/keydown), or
//  - after `idleMs` when the user never touches anything, or
//  - at the hard `maxMs` cap when a continuous gesture would starve it.
// Hover moves (pointermove with no buttons) never re-arm the quiet window.

export interface DeferPastFirstInputOptions {
  /** Run after this long when NO input arrives at all. */
  idleMs?: number;
  /** After input, run once this much quiet time has passed. */
  quietMs?: number;
  /** Hard cap: run at the next input event past this deadline. */
  maxMs?: number;
  /** Event target (a Window); injectable for tests. */
  target?: Window;
}

/**
 * Schedule `onRun` per the policy above. Returns a cancel function — after
 * cancellation (or after the single run) all listeners/timers are released.
 */
export function deferPastFirstInput(
  onRun: () => void,
  { idleMs = 2000, quietMs = 300, maxMs = 8000, target = window }: DeferPastFirstInputOptions = {}
): () => void {
  let done = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = performance.now();

  const run = () => {
    if (done) return;
    done = true;
    cleanup();
    onRun();
  };

  const onInput = (e: Event) => {
    if (done) return;
    // Hover must not re-arm the quiet window; drag moves (buttons held) do.
    if (e.type === "pointermove" && ((e as PointerEvent).buttons ?? 0) === 0) return;
    if (performance.now() - startedAt > maxMs) {
      run();
      return;
    }
    clearTimeout(idleTimer);
    clearTimeout(quietTimer);
    quietTimer = setTimeout(run, quietMs);
  };

  const idleTimer = setTimeout(run, idleMs);
  const EVENTS = ["pointerdown", "pointerup", "pointermove", "wheel", "keydown"] as const;
  for (const name of EVENTS) {
    target.addEventListener(name, onInput, { capture: true, passive: true });
  }

  const cleanup = () => {
    clearTimeout(idleTimer);
    clearTimeout(quietTimer);
    for (const name of EVENTS) {
      target.removeEventListener(name, onInput, { capture: true });
    }
  };

  return () => {
    done = true;
    cleanup();
  };
}
