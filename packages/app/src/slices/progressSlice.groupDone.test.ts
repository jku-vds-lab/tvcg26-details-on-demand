// groupDone accounting (issue #315 Task 3 round 2): completed/failed
// children accumulate per parent so the dock's grouped bar is cumulative;
// the counter survives while the parent task or any child lives and is
// dropped when the whole group is gone.
import reducer, {
  progressComplete,
  progressFail,
  progressResetAll,
  progressStart,
} from "./progressSlice";

const start = (s: ReturnType<typeof reducer> | undefined, id: string, parentId?: string) =>
  reducer(s, progressStart({ id, label: id, parentId }));

test("completed children accumulate; counter survives while the parent task lives", () => {
  let s = start(undefined, "load");
  s = start(s, "download", "load");
  s = start(s, "index", "load");
  s = reducer(s, progressComplete({ id: "download" }));
  expect(s.groupDone.load).toBe(1);
  s = reducer(s, progressComplete({ id: "index" }));
  // No children left, but the parent task itself is still running.
  expect(s.groupDone.load).toBe(2);
  s = start(s, "cluster", "load");
  expect(s.groupDone.load).toBe(2);
});

test("failed children count as done (the group bar must not stall)", () => {
  let s = start(undefined, "load");
  s = start(s, "features", "load");
  s = reducer(s, progressFail({ id: "features" }));
  expect(s.groupDone.load).toBe(1);
});

test("counter is dropped once the parent task and every child are gone", () => {
  let s = start(undefined, "load");
  s = start(s, "download", "load");
  s = reducer(s, progressComplete({ id: "load" }));
  s = reducer(s, progressComplete({ id: "download" }));
  expect(s.groupDone.load).toBeUndefined();
});

test("synthetic parents (no parent task) drop the counter with the last child", () => {
  let s = start(undefined, "a", "task:dataset-boot:1");
  s = start(s, "b", "task:dataset-boot:1");
  s = reducer(s, progressComplete({ id: "a" }));
  expect(s.groupDone["task:dataset-boot:1"]).toBe(1);
  s = reducer(s, progressComplete({ id: "b" }));
  expect(s.groupDone["task:dataset-boot:1"]).toBeUndefined();
});

test("progressResetAll clears the counters", () => {
  let s = start(undefined, "load");
  s = start(s, "x", "load");
  s = reducer(s, progressComplete({ id: "x" }));
  s = reducer(s, progressResetAll());
  expect(s.groupDone).toEqual({});
});
