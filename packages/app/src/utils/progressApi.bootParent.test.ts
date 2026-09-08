// bootParentIdFor / setActiveDatasetLoadTask (issue #315 Arc 1 Task 3b):
// one stable progress parent per dataset load, adopting the live menu-load
// task id when one is active.
import { bootParentIdFor, setActiveDatasetLoadTask } from "./progressApi";

afterEach(() => setActiveDatasetLoadTask(null));

test("same data identity gets the same parent id; new identity a new one", () => {
  const a = {};
  const b = {};
  const idA = bootParentIdFor(a);
  expect(bootParentIdFor(a)).toBe(idA);
  const idB = bootParentIdFor(b);
  expect(idB).not.toBe(idA);
});

test("adopts the active dataset-load task id at first call and keeps it", () => {
  const data = {};
  setActiveDatasetLoadTask("dataset:data/x/manifest.json#3");
  const id = bootParentIdFor(data);
  expect(id).toBe("dataset:data/x/manifest.json#3");
  setActiveDatasetLoadTask(null);
  // Cached: later callers (deferred clustering) still group under the load.
  expect(bootParentIdFor(data)).toBe("dataset:data/x/manifest.json#3");
});

test("without an active load a synthetic id is minted", () => {
  const id = bootParentIdFor({});
  expect(id).toMatch(/^task:dataset-boot:\d+$/);
});
