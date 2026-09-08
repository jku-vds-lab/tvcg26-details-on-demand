// GPU MOTION LANE adaptive raster resolution (deployed-perf, 2026-08-21).
//
// The default motion raster is the engine's exact grid (f32-ulp parity with
// the commit) — full frame rate on a discrete GPU, but ~54 ms/tick on the
// weaker iGPU some browsers pin all WebGL to (measured: Chrome on the demo
// machine's AMD+NVIDIA stack lands on the Radeon iGPU for EVERY
// powerPreference, while Brave lands on the RTX 3070). The tick's CPU-side
// encode is ~0.2 ms on every GPU and rAF scheduling stays prompt even under
// a saturated queue (both measured), so the only honest cost signal is the
// GPU itself: a sync fence after each tick's submission, polled once per
// frame — its time-to-signal is the tick's queue latency. This controller
// takes those samples and degrades the motion raster one tier at a time;
// the truth blend + settle/release flush still snap the screen to the exact
// field, so a coarser tier trades only transient in-drag quantization (max
// |GPU−CPU| 0.009 at 512 / 0.02 at 256 per the knob comment in
// tryGpuMotionTick).
//
// Degradation is sticky for the session (like the broken-latch): re-probing
// the exact tier would re-introduce the lag it just removed.

/** A fence sample above this counts as over budget. The signal overestimates
 * true GPU cost by up to one poll frame (~7–17 ms), so the budget sits above
 * tier-cost + one frame: measured iGPU tick costs are ~54 ms exact / ~24 ms
 * at 512 / 12–18 ms at 256 — 45 keeps a degraded-to-512 iGPU stable while
 * the exact tier's 54+ ms samples clear it every time. */
export const GPU_MOTION_TICK_BUDGET_MS = 45;

/** Degradation tiers, coarsest last (256 is the floor — measured smooth on
 * the weakest stack we target, and the quantization bound doubles per tier). */
export const GPU_MOTION_ADAPTIVE_TIERS = [512, 256];

/** Sliding window: degrade when at least OVER_TO_DEGRADE of the last
 * WINDOW_SIZE samples blew the budget — a couple of outliers (a fence
 * polled late behind a longtask) never trip it. */
const WINDOW_SIZE = 8;
const OVER_TO_DEGRADE = 5;

/** Samples ignored right after a degrade: the tier switch re-rasterizes and
 * re-uploads the field while the old tier's queue drains, so the first
 * samples still carry the backlog (measured: 66 ms samples immediately
 * after dropping to 512 pushed the controller straight to the floor). */
const SETTLE_SKIP = 3;

export interface GpuMotionAdaptiveRes {
  /** The degraded motion raster res, or null while still at the default. */
  current(): number | null;
  /** Record one tick-fence sample (ms from submission to GPU signal).
   * Returns the new res when this sample tipped a degradation, else null. */
  note(sampleMs: number): number | null;
}

/** One controller per session (hook-lifetime ref). */
export function createGpuMotionAdaptiveRes(): GpuMotionAdaptiveRes {
  let tier = -1; // -1 = default (exact grid), else index into the tiers
  let settleSkip = 0;
  const samples: number[] = [];
  return {
    current: () => (tier >= 0 ? GPU_MOTION_ADAPTIVE_TIERS[tier] : null),
    note(sampleMs: number): number | null {
      if (tier >= GPU_MOTION_ADAPTIVE_TIERS.length - 1) return null; // floor
      if (settleSkip > 0) {
        settleSkip -= 1;
        return null;
      }
      samples.push(sampleMs);
      if (samples.length > WINDOW_SIZE) samples.shift();
      const over = samples.filter((d) => d > GPU_MOTION_TICK_BUDGET_MS).length;
      if (over < OVER_TO_DEGRADE) return null;
      tier += 1;
      samples.length = 0; // fresh window measures the new tier
      settleSkip = SETTLE_SKIP;
      return GPU_MOTION_ADAPTIVE_TIERS[tier];
    },
  };
}

/**
 * The motion raster res a tick should request: the `window.__gpuMotionGridRes`
 * knob (any number ≥ 64) beats everything — it is the manual override the
 * adaptive path must never fight — then the adaptive tier, then the default.
 */
export function resolveMotionGridRes(
  knob: unknown,
  adaptive: number | null,
  defaultRes: number
): number {
  if (typeof knob === "number" && knob >= 64) return Math.round(knob);
  return adaptive ?? defaultRes;
}
