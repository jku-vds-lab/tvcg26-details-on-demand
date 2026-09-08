// computeParentSummary (issue #315 Task 3 round 2): cumulative group percent
// that moves forward across phases instead of averaging only live children.
import { computeParentSummary } from "./GlobalProgressDock";

type Child = Parameters<typeof computeParentSummary>[0][number];
const child = (value: number | null): Child =>
  ({ id: "x", label: "x", value, startedAt: 0, visible: true }) as unknown as Child;

test("no completed phases: fraction of live determinate children", () => {
  const { pct, count } = computeParentSummary([child(50), child(50)], 0);
  expect(pct).toBe(50);
  expect(count).toBe(2);
});

test("completed phases keep their full share", () => {
  // 2 phases done + one live at 50% -> (2 + 0.5) / 3
  const { pct, count } = computeParentSummary([child(50)], 2);
  expect(pct).toBe(83);
  expect(count).toBe(3);
});

test("an indeterminate live phase counts in the total with zero contribution", () => {
  const { pct } = computeParentSummary([child(null)], 1);
  expect(pct).toBe(50);
});

test("all indeterminate and nothing done: indeterminate bar", () => {
  const { pct } = computeParentSummary([child(null), child(null)], 0);
  expect(pct).toBeUndefined();
});

test("a live root reserves one pending slot: no preemptive 100% in phase gaps", () => {
  // Gap between phases while the load is still running: 2 done, none live.
  expect(computeParentSummary([], 2, true).pct).toBe(67); // 2/3, not 100
  // Same gap after the root finished: the group really is at its end state.
  expect(computeParentSummary([], 2, false).pct).toBe(100);
  // A live child while the root runs: (1 + 0.5) / 3.
  expect(computeParentSummary([child(50)], 1, true).pct).toBe(50);
});

test("finishing a phase never lowers the percent (cumulative monotonicity)", () => {
  // live child at 90% of phase 2-of-2…
  const before = computeParentSummary([child(90)], 1).pct!;
  // …completes: done=2, no live children yet for the next phase.
  const after = computeParentSummary([], 2).pct!;
  expect(after).toBeGreaterThanOrEqual(before);
});
