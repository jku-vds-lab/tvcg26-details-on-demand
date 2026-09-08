// Tests for deferPastFirstInput (issue #315 Arc 1 Task 3a): first-input /
// idle / quiet-window / hard-cap semantics on fake timers.
import { deferPastFirstInput } from "./deferPastFirstInput";

const OPTS = { idleMs: 2000, quietMs: 300, maxMs: 8000 };

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const fire = (type: string, props: Record<string, unknown> = {}) => {
  window.dispatchEvent(Object.assign(new Event(type), props));
};

test("no input at all: runs once at idleMs", () => {
  const onRun = jest.fn();
  deferPastFirstInput(onRun, OPTS);
  jest.advanceTimersByTime(1999);
  expect(onRun).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(onRun).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(10_000);
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("input hands ownership to the quiet window; a burst keeps re-arming it", () => {
  const onRun = jest.fn();
  deferPastFirstInput(onRun, OPTS);
  jest.advanceTimersByTime(500);
  fire("pointerdown");
  jest.advanceTimersByTime(200);
  fire("wheel"); // burst continues: re-arms the quiet window
  jest.advanceTimersByTime(299);
  expect(onRun).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); // 300 ms of quiet after the LAST input
  expect(onRun).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(10_000); // idle timer must not double-fire
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("hover pointermove (no buttons) does not count as input", () => {
  const onRun = jest.fn();
  deferPastFirstInput(onRun, OPTS);
  jest.advanceTimersByTime(1000);
  fire("pointermove", { buttons: 0 });
  fire("pointermove"); // jsdom event without buttons: hover semantics
  jest.advanceTimersByTime(1000);
  expect(onRun).toHaveBeenCalledTimes(1); // idle deadline still fired
});

test("drag pointermove (buttons held) keeps re-arming until the hard cap", () => {
  const onRun = jest.fn();
  deferPastFirstInput(onRun, OPTS);
  fire("pointerdown");
  // Continuous drag: an event every 200 ms — quiet window never elapses.
  for (let t = 0; t < 8000; t += 200) {
    jest.advanceTimersByTime(200);
    fire("pointermove", { buttons: 1 });
  }
  expect(onRun).not.toHaveBeenCalled();
  // First event past maxMs triggers the capped run.
  jest.advanceTimersByTime(200);
  fire("pointermove", { buttons: 1 });
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("cancel prevents any run and releases listeners", () => {
  const onRun = jest.fn();
  const cancel = deferPastFirstInput(onRun, OPTS);
  cancel();
  jest.advanceTimersByTime(10_000);
  fire("pointerdown");
  jest.advanceTimersByTime(10_000);
  expect(onRun).not.toHaveBeenCalled();
});
