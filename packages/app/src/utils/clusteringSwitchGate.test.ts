// clusteringSwitchGate (issue #315 round 4): dependency-free registry seam.
import { registerSwitchClear, requestSwitchClear } from "./clusteringSwitchGate";

test("no-op before registration; calls through after", () => {
  expect(() => requestSwitchClear()).not.toThrow();
  const fn = jest.fn();
  registerSwitchClear(fn);
  requestSwitchClear();
  requestSwitchClear();
  expect(fn).toHaveBeenCalledTimes(2);
});
