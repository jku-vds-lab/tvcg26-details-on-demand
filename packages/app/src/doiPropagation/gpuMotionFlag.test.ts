// Default-ON contract of the GPU motion lane switch (default-on
// since CS 2026-08-18): active with no param, explicit opt-out via `gpumotion=0`
// or `window.__gpuMotionLane = false`, window override beats the hash, and
// the hash read is latched (an in-app hash rewrite cannot flip a session).

import {
  gpuMotionLaneEnabled,
  resetGpuMotionFlagForTests,
} from "./gpuMotionFlag";

type FlaggedWindow = Window & { __gpuMotionLane?: boolean };

const setHash = (hash: string) => {
  window.location.hash = hash;
};

beforeEach(() => {
  resetGpuMotionFlagForTests();
  delete (window as FlaggedWindow).__gpuMotionLane;
  setHash("");
});

afterEach(() => {
  delete (window as FlaggedWindow).__gpuMotionLane;
  setHash("");
});

describe("gpuMotionLaneEnabled", () => {
  it("is ON by default (no param, no window flag)", () => {
    expect(gpuMotionLaneEnabled()).toBe(true);
  });

  it("gpumotion=0 opts out", () => {
    setHash("#v=1&ds=chess&gpumotion=0");
    expect(gpuMotionLaneEnabled()).toBe(false);
  });

  it("gpumotion=1 stays an explicit opt-in", () => {
    setHash("#v=1&gpumotion=1");
    expect(gpuMotionLaneEnabled()).toBe(true);
  });

  it("window.__gpuMotionLane = false force-disables over any hash", () => {
    setHash("#gpumotion=1");
    (window as FlaggedWindow).__gpuMotionLane = false;
    expect(gpuMotionLaneEnabled()).toBe(false);
  });

  it("window.__gpuMotionLane = true force-enables over gpumotion=0", () => {
    setHash("#gpumotion=0");
    (window as FlaggedWindow).__gpuMotionLane = true;
    expect(gpuMotionLaneEnabled()).toBe(true);
  });

  it("the hash read is latched: a later in-app rewrite cannot flip the session", () => {
    setHash("#gpumotion=0");
    expect(gpuMotionLaneEnabled()).toBe(false);
    setHash("#v=1&ds=chess"); // deep-link sync rewrote the hash
    expect(gpuMotionLaneEnabled()).toBe(false); // still the latched opt-out
  });
});
