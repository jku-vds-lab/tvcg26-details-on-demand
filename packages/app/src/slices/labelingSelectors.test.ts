/**
 * Memoization tests for labelingSelectors (perf overhaul phase 6).
 *
 * The derived selectors must return the SAME reference while the underlying
 * labeling fields are unchanged — otherwise every store dispatch (including
 * per-settled-tick clustering updates during zoom) re-renders all labeling
 * consumers — and must recompute when the fields actually change.
 *
 * The full cluster-id list lives in the lazy registry
 * (`labelingClusterIds.ts`), never in Redux (issue #315 insets-at-boot I2);
 * the boot path (empty assignments) must not touch the registry at all.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { RootState } from "../store";
import { createClusterId, createSemanticLabel } from "../types/labeling";
import { setLabelingClusterIdProvider } from "./labelingClusterIds";
import {
    selectExistingLabels,
    selectLabelAssignments,
    selectLabelCounts,
    selectLabeledClusterIds,
    selectLabeledNodeIds,
    selectLabelingProgress,
    selectSelectedClusterIds,
} from "./labelingSelectors";

type LabelingLike = {
  assignments: Map<string, string>;
  selectedIds: Set<string>;
  existingLabels: Set<string>;
  totalClusters: number;
};

function makeState(labeling: LabelingLike): RootState {
  return { labeling } as unknown as RootState;
}

function makeLabeling(overrides: Partial<LabelingLike> = {}): LabelingLike {
  return {
    assignments: new Map([
      [createClusterId("1"), createSemanticLabel("walk")],
      [createClusterId("2"), createSemanticLabel("run")],
    ]),
    selectedIds: new Set([createClusterId("3")]),
    existingLabels: new Set([createSemanticLabel("run"), createSemanticLabel("walk")]),
    totalClusters: 4,
    ...overrides,
  };
}

const provider = jest.fn(() =>
  ["1", "2", "3", "4"].map(createClusterId)
);

beforeEach(() => {
  provider.mockClear();
  setLabelingClusterIdProvider(provider);
});

describe("labelingSelectors memoization", () => {
  it("returns identical references across different root states with unchanged labeling fields", () => {
    const labeling = makeLabeling();
    // Two distinct root-state objects (as produced by unrelated dispatches).
    const s1 = makeState(labeling);
    const s2 = makeState(labeling);

    expect(selectLabelingProgress(s1)).toBe(selectLabelingProgress(s2));
    expect(selectLabeledNodeIds(s1)).toBe(selectLabeledNodeIds(s2));
    expect(selectLabelAssignments(s1)).toBe(selectLabelAssignments(s2));
    expect(selectExistingLabels(s1)).toBe(selectExistingLabels(s2));
    expect(selectLabeledClusterIds(s1)).toBe(selectLabeledClusterIds(s2));
    expect(selectLabelCounts(s1)).toBe(selectLabelCounts(s2));
    expect(selectSelectedClusterIds(s1)).toBe(selectSelectedClusterIds(s2));
  });

  it("recomputes when the assignments map identity changes", () => {
    const labeling = makeLabeling();
    const s1 = makeState(labeling);
    const before = selectLabelingProgress(s1);

    const nextAssignments = new Map(labeling.assignments);
    nextAssignments.set(createClusterId("3"), createSemanticLabel("jump"));
    const changed = makeLabeling({ assignments: nextAssignments });
    const s2 = makeState(changed);
    const after = selectLabelingProgress(s2);

    expect(after).not.toBe(before);
    expect(after.labeled).toBe(3);
  });

  it("computes progress correctly (only counting assignments present in the dataset)", () => {
    const labeling = makeLabeling({
      assignments: new Map([
        [createClusterId("1"), createSemanticLabel("walk")],
        // Stale id from a previous dataset — must not count.
        [createClusterId("999"), createSemanticLabel("ghost")],
      ]),
    });
    const progress = selectLabelingProgress(makeState(labeling));

    expect(progress.labeled).toBe(1);
    expect(progress.total).toBe(4);
    expect(progress.percentage).toBe(25);
  });

  it("short-circuits on empty assignments without materializing the id list", () => {
    const labeling = makeLabeling({ assignments: new Map() });
    const progress = selectLabelingProgress(makeState(labeling));

    expect(progress.labeled).toBe(0);
    expect(progress.total).toBe(labeling.totalClusters);
    expect(progress.percentage).toBe(0);
    // The boot path (issue #315 insets-at-boot) must never pull the possibly
    // 1M-entry id list out of the registry.
    expect(provider).not.toHaveBeenCalled();
  });

  it("sorts existing labels and counts per label", () => {
    const state = makeState(makeLabeling());
    expect(selectExistingLabels(state)).toEqual(["run", "walk"]);
    expect(selectLabelCounts(state)).toEqual({ walk: 1, run: 1 });
  });
});
