// packages/app/src/utils/yieldBeforeCommit.ts
//
// Dependency-free (worker-factory import.meta poisons jest graphs, so the
// boot-commit yield lives outside the hooks module - same reasoning as
// registerSwitchClear).

/**
 * Yield-to-paint that cannot stall in a background tab (issue #315 P3).
 * The internalData commit used a bare requestAnimationFrame so the preset
 * UI could paint before the heavy normalize+setState burst — but browsers
 * throttle rAF to ZERO in hidden tabs, freezing the entire load until the
 * tab is refocused (master plan §6b: data readiness must never be
 * frame-gated). Racing the rAF with a timer keeps the paint-friendly tick
 * in the foreground and falls through on the timer when hidden (background
 * timer throttling delays it, never cancels it).
 */
export function yieldBeforeCommit(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  setTimeout(run, 50);
}
