import { createSelector } from "@reduxjs/toolkit";
import { RootState } from "../store";
import type { ClusterId, LabelingProgress, SemanticLabel } from "../types/labeling";
import { getLabelingClusterIdSet } from "./labelingClusterIds";

/**
 * Selectors for labeling state.
 *
 * Selectors that derive a fresh object/array/Set are memoized with
 * createSelector on the identity of the underlying labeling fields (immer
 * produces new Map/Set identities only on actual change). Without this,
 * every store dispatch — including the per-settled-tick clustering updates
 * during zoom — hands each subscriber a new reference and re-renders the
 * whole labeling UI.
 */

export const selectLabelingIsEnabled = (state: RootState) => state.labeling.isEnabled;

export const selectUnlabeledOnlyMode = (state: RootState) =>
  state.labeling.unlabeledOnlyMode;

/**
 * Returns the set of node IDs (as plain strings) that already carry an
 * assigned label. ClusterId keys in the assignments map are node IDs, so
 * no secondary lookup is required.
 */
export const selectLabeledNodeIds: (state: RootState) => Set<string> = createSelector(
  [(state: RootState) => state.labeling.assignments],
  (assignments) => new Set<string>(assignments.keys())
);

export const selectSelectedClusterIds: (state: RootState) => ClusterId[] = createSelector(
  [(state: RootState) => state.labeling.selectedIds],
  (selectedIds) => Array.from(selectedIds)
);

export const selectSelectedCount = (state: RootState) =>
  state.labeling.selectedIds.size;

export const selectLabelAssignments: (state: RootState) => Record<string, SemanticLabel> =
  createSelector(
    [(state: RootState) => state.labeling.assignments],
    (assignments) => Object.fromEntries(assignments)
  );

export const selectExistingLabels: (state: RootState) => SemanticLabel[] = createSelector(
  [(state: RootState) => state.labeling.existingLabels],
  (existingLabels) => Array.from(existingLabels).sort()
);

export const selectInputLabel = (state: RootState) => state.labeling.inputLabel;

export const selectInputError = (state: RootState) => state.labeling.inputError;

export const selectLabelingMetadata = (state: RootState) =>
  state.labeling.metadata;

/**
 * Default label column per dataset type. Must agree with the
 * `resolveAnnotationColumn(...)` defaults in the `Details/*DatasetRenderer`
 * classes so the labeling panel names the column the insets actually show.
 */
export function getDefaultLabelFeature(datasetType: string): string {
  switch (datasetType) {
    case "rubik": return "phase";
    case "chess": return "algo";
    case "mnist": return "digit";
    default: return "label";
  }
}

/**
 * The one label column shared by the Visual Encoding tab, the inset
 * renderers and the labeling panel (issue #352): the user override from
 * `visualizationSettings.annotationLabelFeature`, else the dataset default.
 */
export const selectLabelFeatureName = (state: RootState): string =>
  state.visualizationSettings.annotationLabelFeature ??
  getDefaultLabelFeature(state.dataset.datasetType);

/**
 * Compute progress statistics.
 *
 * The id list itself lives in the lazy registry (`labelingClusterIds.ts`),
 * not in Redux — the boot path (empty assignments) must not materialize it
 * (issue #315 insets-at-boot I2). The registry read is impure but safe under
 * this memoization: the provider only changes together with a dataset switch
 * (which clears assignments) or a `totalClusters` change, both selector
 * inputs.
 */
export const selectLabelingProgress: (state: RootState) => LabelingProgress = createSelector(
  [
    (state: RootState) => state.labeling.totalClusters,
    (state: RootState) => state.labeling.assignments,
  ],
  (total, assignments) => {
    if (assignments.size === 0) {
      return { labeled: 0, total, percentage: 0 };
    }
    // Count only assignments whose IDs are present in the dataset.
    // This guards against stale restored sessions or dataset-switch races where
    // assignments.size can exceed the cluster count (causing >100% progress).
    const inDataset = getLabelingClusterIdSet();
    let labeled = 0;
    for (const id of assignments.keys()) {
      if (inDataset.has(id)) labeled++;
    }

    return {
      labeled,
      total,
      percentage: total > 0 ? (labeled / total) * 100 : 0,
    };
  }
);

/**
 * Get label for a specific cluster (or undefined if not labeled)
 */
export const selectClusterLabel =
  (clusterId: ClusterId) => (state: RootState) =>
    state.labeling.assignments.get(clusterId);

/**
 * Check if a cluster is selected
 */
export const selectIsClusterSelected =
  (clusterId: ClusterId) => (state: RootState) =>
    state.labeling.selectedIds.has(clusterId);

/**
 * Get all labeled cluster IDs
 */
export const selectLabeledClusterIds: (state: RootState) => ClusterId[] = createSelector(
  [(state: RootState) => state.labeling.assignments],
  (assignments) => Array.from(assignments.keys())
);

/**
 * Get clusters grouped by label (for stats)
 */
export const selectLabelCounts: (state: RootState) => Record<string, number> = createSelector(
  [(state: RootState) => state.labeling.assignments],
  (assignments) => {
    const counts = new Map<string, number>();
    assignments.forEach((label) => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    });
    return Object.fromEntries(counts);
  }
);
