// yieldBeforeCommit (issue #315 P3): the dataset commit must complete
// WITHOUT a rAF tick — background tabs throttle rAF to zero, and a bare
// rAF continuation froze the whole load until refocus (master plan §6b).

import { jest } from "@jest/globals";
import { yieldBeforeCommit } from "./yieldBeforeCommit";

describe("yieldBeforeCommit", () => {
  afterEach(() => {
    jest.useRealTimers();
    // @ts-expect-error test cleanup of the stub
    delete globalThis.requestAnimationFrame;
  });

  it("runs via the timer when rAF never fires (hidden tab)", () => {
    jest.useFakeTimers();
    // rAF that never calls back — the hidden-tab behavior.
    globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
    const fn = jest.fn();
    yieldBeforeCommit(fn);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs exactly once when rAF fires first (foreground)", () => {
    jest.useFakeTimers();
    let rafCb: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    }) as typeof requestAnimationFrame;
    const fn = jest.fn();
    yieldBeforeCommit(fn);
    rafCb!(0);
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("works with no rAF at all (non-browser hosts)", () => {
    jest.useFakeTimers();
    const fn = jest.fn();
    yieldBeforeCommit(fn);
    jest.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
