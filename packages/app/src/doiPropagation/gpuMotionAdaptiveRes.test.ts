// Adaptive motion-raster degradation (deployed-perf, 2026-08-21). Pinned:
// slow GPU tick-fence samples degrade the motion raster one tier at a time
// (5-of-8 over budget), outliers never trip it, 256 is the floor, and the
// window knob beats both the adaptive tier and the default.

import { describe, expect, it } from "@jest/globals";
import {
  GPU_MOTION_ADAPTIVE_TIERS,
  GPU_MOTION_TICK_BUDGET_MS,
  createGpuMotionAdaptiveRes,
  resolveMotionGridRes,
} from "./gpuMotionAdaptiveRes";

const SLOW = GPU_MOTION_TICK_BUDGET_MS + 20;
const FAST = 8;

describe("createGpuMotionAdaptiveRes", () => {
  it("stays at the default while ticks are under budget", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    for (let i = 0; i < 50; i++) expect(ctrl.note(FAST)).toBeNull();
    expect(ctrl.current()).toBeNull();
  });

  it("degrades to the first tier after 5-of-8 over-budget ticks", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    for (let i = 0; i < 4; i++) expect(ctrl.note(SLOW)).toBeNull();
    expect(ctrl.note(SLOW)).toBe(GPU_MOTION_ADAPTIVE_TIERS[0]);
    expect(ctrl.current()).toBe(GPU_MOTION_ADAPTIVE_TIERS[0]);
  });

  it("a burst pattern (slow frames between healthy ones) still degrades", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    // 3 fast + 5 slow within one window of 8.
    const seq = [FAST, SLOW, FAST, SLOW, SLOW, FAST, SLOW, SLOW];
    const results = seq.map((d) => ctrl.note(d));
    expect(results[seq.length - 1]).toBe(GPU_MOTION_ADAPTIVE_TIERS[0]);
  });

  it("a few outliers inside a healthy drag never degrade", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    for (let round = 0; round < 10; round++) {
      // 4 slow max per window — always under the 5-of-8 rule.
      for (const d of [SLOW, FAST, SLOW, FAST, SLOW, FAST, SLOW, FAST]) {
        expect(ctrl.note(d)).toBeNull();
      }
    }
    expect(ctrl.current()).toBeNull();
  });

  it("skips settle samples after a degrade (transition backlog must not cascade)", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    for (let i = 0; i < 5; i++) ctrl.note(SLOW);
    expect(ctrl.current()).toBe(512);
    // The 3 settle samples right after the switch still carry the old tier's
    // queue backlog — even slow ones must not count toward the next drop.
    for (let i = 0; i < 3; i++) expect(ctrl.note(SLOW)).toBeNull();
    // A healthy new tier then holds indefinitely.
    for (let i = 0; i < 30; i++) expect(ctrl.note(FAST)).toBeNull();
    expect(ctrl.current()).toBe(512);
  });

  it("continues to the next tier when the degraded tier is still slow, and floors there", () => {
    const ctrl = createGpuMotionAdaptiveRes();
    for (let i = 0; i < 5; i++) ctrl.note(SLOW);
    expect(ctrl.current()).toBe(512);
    for (let i = 0; i < 3; i++) ctrl.note(SLOW); // settle skip
    // The window was cleared on degrade: five fresh slow samples again.
    for (let i = 0; i < 4; i++) expect(ctrl.note(SLOW)).toBeNull();
    expect(ctrl.note(SLOW)).toBe(256);
    // At the floor, further slow ticks change nothing.
    for (let i = 0; i < 20; i++) expect(ctrl.note(SLOW)).toBeNull();
    expect(ctrl.current()).toBe(256);
  });
});

describe("resolveMotionGridRes", () => {
  it("the window knob beats the adaptive tier and the default", () => {
    expect(resolveMotionGridRes(256, 512, 1024)).toBe(256);
    expect(resolveMotionGridRes(2048, 512, 1024)).toBe(2048);
  });

  it("invalid knob values are ignored", () => {
    expect(resolveMotionGridRes(undefined, null, 1024)).toBe(1024);
    expect(resolveMotionGridRes(32, null, 1024)).toBe(1024); // < 64
    expect(resolveMotionGridRes("512", null, 1024)).toBe(1024);
  });

  it("the adaptive tier beats the default when no knob is set", () => {
    expect(resolveMotionGridRes(undefined, 512, 1024)).toBe(512);
    expect(resolveMotionGridRes(null, null, 1024)).toBe(1024);
  });
});
