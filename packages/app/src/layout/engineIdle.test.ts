import {
  ANNEAL_FRAME_BUDGET_MS,
  isConvergedFrame,
  SLEEP_AFTER_CONVERGED_FRAMES,
  SLEEP_WATCHDOG_INTERVAL_MS,
  type FrameOutcome,
} from "./engineIdle";

const quiet: FrameOutcome = {
  isZooming: false,
  storeChanged: false,
  reheatApplied: false,
  reheatSuppressed: false,
  anyWarm: false,
  positioningMode: "annealing",
};

describe("isConvergedFrame", () => {
  it("is converged only when nothing happened and nothing is pending", () => {
    expect(isConvergedFrame(quiet)).toBe(true);
  });

  it("stays awake during zoom gestures", () => {
    expect(isConvergedFrame({ ...quiet, isZooming: true })).toBe(false);
  });

  it("stays awake when the layout store changed (clamp/annealer/cartographic patch)", () => {
    expect(isConvergedFrame({ ...quiet, storeChanged: true })).toBe(false);
  });

  it("stays awake when a reheat was applied", () => {
    expect(isConvergedFrame({ ...quiet, reheatApplied: true })).toBe(false);
  });

  it("stays awake while a reheat is cooldown-suppressed (fires within 500ms)", () => {
    expect(isConvergedFrame({ ...quiet, reheatSuppressed: true })).toBe(false);
  });

  it("stays awake while any element is warm in annealing mode", () => {
    expect(isConvergedFrame({ ...quiet, anyWarm: true })).toBe(false);
  });

  it("ignores warmth in cartographic mode (positions pinned, temps never cool)", () => {
    expect(
      isConvergedFrame({ ...quiet, anyWarm: true, positioningMode: "cartographic" })
    ).toBe(true);
  });
});

describe("gating constants", () => {
  it("keep documented relationships", () => {
    // The watchdog is the missed-wake safety net; a couple of frames of
    // hysteresis avoids sleep/wake thrash on isolated no-op frames.
    expect(SLEEP_AFTER_CONVERGED_FRAMES).toBeGreaterThanOrEqual(2);
    expect(SLEEP_WATCHDOG_INTERVAL_MS).toBeGreaterThanOrEqual(100);
    // Budget must leave headroom inside a 16.7ms frame for clamp + reheat scans.
    expect(ANNEAL_FRAME_BUDGET_MS).toBeLessThanOrEqual(10);
  });
});
