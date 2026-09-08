// packages/app/src/doiPropagation/gpuMotionFlag.ts
//
// Switch for the GPU motion lane (plan-gpu-motion-lane.md): converged drag
// previews computed on the GPU during motion, exact CPU at rest/commit.
// **ON by default since CS's feel verdict (2026-08-18)** — the permanent
// per-session fallback latch in useDoIPropagation is what protects broken GL
// environments (any GPU failure drops the session to the worker lane).
// Explicit opt-OUT for debugging and A/B comparisons: the hash param
// `gpumotion=0` (e.g. #v=1&ds=chess&gpumotion=0) or `window.__gpuMotionLane
// = false`; the window flag always wins (true force-enables too). The hash
// read is LATCHED on first evaluation so in-app hash rewrites (deep-link
// sync) cannot flip a running session; the param is read-only — the deep-link
// codec never writes it.

let hashLatch: boolean | null = null;

export function gpuMotionLaneEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const override = (window as { __gpuMotionLane?: unknown }).__gpuMotionLane;
  if (override === true) return true;
  if (override === false) return false;
  if (hashLatch === null) {
    try {
      hashLatch =
        new URLSearchParams(window.location.hash.slice(1)).get("gpumotion") !==
        "0";
    } catch {
      hashLatch = true;
    }
  }
  return hashLatch;
}

/** Test-only: drop the latched hash read. */
export function resetGpuMotionFlagForTests(): void {
  hashLatch = null;
}
