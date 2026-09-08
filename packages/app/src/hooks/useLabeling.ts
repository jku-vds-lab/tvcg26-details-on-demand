import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
    ASSIGNED_LABEL_OVERRIDE_FEATURE,
    invalidateGroupLabelCache,
} from "../components/Visualization/Details/BaseInsetRenderer";
import { useDataRef } from "../contexts/DataContext";
import { areRowsResident } from "../dataPreprocessing/lazyRows";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import { ensureResidentRowsWithChip } from "../utils/rowResidency";
import { collectClusterUidMemberIds } from "./labelingMemberIds";
import { useRendererApi } from "../contexts/RendererApiContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";
import { useSelectionWorkflow } from "../contexts/SelectionWorkflowContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { updateTrajectoryMidpointDoIs } from "../dataPreprocessing/dataPreprocessing";
import { updateEdgeColumnDois } from "../dataPreprocessing/splineColumns";
import { LabelingService } from "../services/LabelingService";
import { getLabelingClusterIds } from "../slices/labelingClusterIds";
import {
    selectExistingLabels,
    selectInputError,
    selectInputLabel,
    selectLabelAssignments,
    selectLabeledClusterIds,
    selectLabelFeatureName,
    selectLabelingMetadata,
    selectLabelingProgress,
    selectSelectedCount,
    selectUnlabeledOnlyMode,
} from "../slices/labelingSelectors";
import {
    assignLabelToSelected,
    clearAllAssignments,
    importLabels,
    removeLabelFromCluster,
    setInputError,
    setInputLabel,
    setSelectedClusters,
    toggleClusterSelection,
} from "../slices/labelingSlice";
import store, {
    type AppDispatch,
    setAnnotationLabelFeature,
    setSelectedNodes,
    updateAnnotationActiveClusters,
    updateInsetActiveClusters,
} from "../store";
import type { ClusterId } from "../types/labeling";

/**
 * Reads labelFeatureName from each data point and populates the Redux
 * assignments map. Called on labeling-mode enable and on feature-name change.
 * Exported so useLabelingAutoSync can call it at app level.
 *
 * The features bag wins over the top-level field: the write-back
 * (`syncAssignmentsIntoVisualizationImpl`) persists session edits into
 * `features[column]`, while columnar rows keep the raw column top-level — the
 * same precedence `getAnnotationValue` uses, so edits survive a column
 * round-trip instead of being shadowed by the raw value (issue #352).
 */
export function syncAssignmentsFromFeaturesImpl(
  data: DataPoint[],
  dispatch: AppDispatch,
  labelFeatureName: string,
): void {
  const record: Record<string, string> = {};
  data.forEach((node) => {
    const recordNode = node as unknown as Record<string, unknown>;
    const edited = node.features?.[labelFeatureName];
    const raw = edited !== undefined ? edited : recordNode[labelFeatureName];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      record[String(node.id)] = String(raw);
    }
  });
  dispatch(clearAllAssignments());
  if (Object.keys(record).length > 0) {
    dispatch(importLabels(record));
  }
}

/**
 * Writes the Redux assignments back onto the rows (`__assignedLabel` override
 * + the label column) and re-renders the clusters. Exported so
 * useLabelingAutoSync can rewrite the overrides when the label column changes.
 */
export function syncAssignmentsIntoVisualizationImpl(
  data: DataPoint[],
  dispatch: AppDispatch,
  labelFeatureName: string,
): void {
  const state = store.getState();
  const assignmentMap = state.labeling.assignments;

  data.forEach((node) => {
    const label = assignmentMap.get(String(node.id) as ClusterId);

    if (label) {
      node.features = node.features ?? {};
      node.features[ASSIGNED_LABEL_OVERRIDE_FEATURE] = String(label);
      node.features[labelFeatureName] = String(label);
    } else if (node.features) {
      delete node.features[ASSIGNED_LABEL_OVERRIDE_FEATURE];
    }
  });
  // Cached majority votes read the overrides just rewritten (issue #352).
  invalidateGroupLabelCache();

  const annotationActive = state.clustering.annotationClusteringResults?.activeClusters;
  if (annotationActive) {
    dispatch(updateAnnotationActiveClusters(annotationActive));
  }
  const insetActive = state.clustering.insetClusteringResults?.activeClusters;
  if (insetActive) {
    dispatch(updateInsetActiveClusters(insetActive));
  }
}

/**
 * Main hook for labeling workflows.
 * Provides a clean interface for components to interact with the labeling system.
 */
export const useLabeling = () => {
  const dispatch = useDispatch<AppDispatch>();
  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();
  const renderer = useRendererApi();
  const runSelectionWorkflow = useSelectionWorkflow();
  const [isHoverPreviewActive, setIsHoverPreviewActive] = useState(false);
  const [isPreviewPinned, setIsPreviewPinned] = useState(false);
  const originalDoiByIdRef = useRef<Map<number, number> | null>(null);
  const previousSelectionRef = useRef<number[] | null>(null);

  // Selectors
  const selectedCount = useSelector(selectSelectedCount);
  const assignments = useSelector(selectLabelAssignments);
  const unlabeledOnlyMode = useSelector(selectUnlabeledOnlyMode);
  const inputLabel = useSelector(selectInputLabel);
  const inputError = useSelector(selectInputError);
  const existingLabels = useSelector(selectExistingLabels);
  const progress = useSelector(selectLabelingProgress);
  const labeledIds = useSelector(selectLabeledClusterIds);
  const metadata = useSelector(selectLabelingMetadata);
  const labelFeatureName = useSelector(selectLabelFeatureName);
  const selectedNodeIds = useSelector((state: ReturnType<typeof store.getState>) =>
    state.selection.selectedNodeIds
  );
  const insetDoiThreshold = useSelector((state: ReturnType<typeof store.getState>) =>
    state.visualizationSettings.insetDoiThreshold
  );
  const getTopDoiBucketClusterIds = useCallback((): ClusterId[] => {
    return dataRef.current
      .filter((node) => (node.DoI ?? 0) >= insetDoiThreshold)
      .filter((node) => !unlabeledOnlyMode || assignments[String(node.id)] === undefined)
      .map((node) => String(node.id) as ClusterId);
  }, [dataRef, insetDoiThreshold, unlabeledOnlyMode, assignments]);

  // Count WITHOUT materializing arrays. This runs on every render of the
  // labeling host — which re-renders on every clustering dispatch, i.e.
  // every settled zoom tick — and the previous
  // `getTopDoiBucketClusterIds().length` (two filter passes + a 39k-string
  // map) was the single largest frame cost in the #315 S4 zoom profile
  // (5.3 s self time over one gesture sweep). Not memoized on purpose:
  // node.DoI mutates in place, so a dependency-keyed memo would go stale.
  let assignableCount = 0;
  {
    const points = dataRef.current;
    // Columnar fast path (issue #315 D2): the accessor-backed DoI made this
    // per-render object walk expensive; the typed-array pass is faster than
    // the original field reads ever were.
    const cols = columnsOf(points);
    if (cols) {
      const doi = cols.doi;
      const ids = cols.id;
      for (let i = 0; i < cols.count; i++) {
        if (doi[i] < insetDoiThreshold) continue;
        if (unlabeledOnlyMode && assignments[String(ids[i])] !== undefined) continue;
        assignableCount++;
      }
    } else {
      for (let i = 0; i < points.length; i++) {
        const node = points[i];
        if ((node.DoI ?? 0) < insetDoiThreshold) continue;
        if (unlabeledOnlyMode && assignments[String(node.id)] !== undefined) continue;
        assignableCount++;
      }
    }
  }

  const getLabeledPointIds = useCallback(() => {
    return dataRef.current
      .filter((node) => Object.prototype.hasOwnProperty.call(assignments, `${node.id}`))
      .map((node) => node.id);
  }, [assignments, dataRef]);

  const pushOpacityFromData = useCallback(() => {
    if (!renderer || !dataRef.current.length) return;

    const state = store.getState();
    renderer.setOpacityParams({
      threshold: state.visualizationSettings.grayOutDoiThreshold,
      minAlpha: state.visualizationSettings.minimumOpacityClamping,
      maxAlpha: state.visualizationSettings.maximumOpacityClamping,
    });

    // In unlabeled-only mode, labeled nodes must render at zero opacity even
    // after the preview is dismissed (same rule applied in runSelectionWorkflow).
    const labelingState = state.labeling;
    const labeledIds = labelingState.unlabeledOnlyMode
      ? labelingState.assignments
      : null;

    const opacityValues = new Float32Array(dataRef.current.length);
    for (let i = 0; i < dataRef.current.length; i++) {
      const node = dataRef.current[i];
      opacityValues[i] = labeledIds?.has(String(node.id) as ClusterId) ? 0 : (node.DoI ?? 1);
    }

    renderer.setOpacityField(opacityValues);
    renderer.render?.();
  }, [dataRef, renderer]);

  const areNodeIdListsEqual = useCallback((left: number[], right: number[]) => {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }, []);

  const applyPinnedPreview = useCallback(() => {
    const labeledPointIds = getLabeledPointIds();

    if (!originalDoiByIdRef.current) {
      const snapshot = new Map<number, number>();
      dataRef.current.forEach((node) => {
        snapshot.set(node.id, node.DoI ?? 1);
      });
      originalDoiByIdRef.current = snapshot;
    }

    dataRef.current.forEach((node) => {
      node.DoI = Object.prototype.hasOwnProperty.call(assignments, `${node.id}`) ? 1 : 0;
    });
    updateEdgeColumnDois(segmentsRef.current, dataRef.current);
    updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
    pushOpacityFromData();

    const currentSelection = store.getState().selection.selectedNodeIds;
    if (!areNodeIdListsEqual(currentSelection, labeledPointIds)) {
      dispatch(setSelectedNodes(labeledPointIds));
      void runSelectionWorkflow(labeledPointIds, {
        clearFeatureSearch: false,
        propagationOverride: {
          proximitySlider: 0,
          pastSlider: 0,
          futureSlider: 0,
        },
      });
    }

    setIsPreviewPinned(true);
    setIsHoverPreviewActive(false);
  }, [
    areNodeIdListsEqual,
    assignments,
    dataRef,
    dispatch,
    getLabeledPointIds,
    pushOpacityFromData,
    runSelectionWorkflow,
    segmentsRef,
    trajectoryMidpointsRef,
  ]);

  const getLabeledOpacityField = useCallback(() => {
    const state = store.getState();
    const assignmentMap = state.labeling.assignments;
    const field = new Float32Array(dataRef.current.length);
    for (let i = 0; i < dataRef.current.length; i++) {
      const node = dataRef.current[i];
      field[i] = assignmentMap.has(String(node.id) as ClusterId) ? 1 : 0;
    }
    return field;
  }, [dataRef]);

  const applyOpacityField = useCallback(
    (field: Float32Array) => {
      if (!renderer) return;
      const state = store.getState();
      renderer.setOpacityParams({
        threshold: state.visualizationSettings.grayOutDoiThreshold,
        minAlpha: state.visualizationSettings.minimumOpacityClamping,
        maxAlpha: state.visualizationSettings.maximumOpacityClamping,
      });
      renderer.setOpacityField(field);
      renderer.render?.();
    },
    [renderer]
  );

  const restoreDoiSnapshot = useCallback(() => {
    const snapshot = originalDoiByIdRef.current;
    if (!snapshot) return;

    dataRef.current.forEach((node) => {
      node.DoI = snapshot.get(node.id) ?? (node.DoI ?? 1);
    });
    updateEdgeColumnDois(segmentsRef.current, dataRef.current);
    updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
    originalDoiByIdRef.current = null;
    pushOpacityFromData();
  }, [dataRef, pushOpacityFromData, segmentsRef, trajectoryMidpointsRef]);

  const setHoverPreview = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (isPreviewPinned) {
          applyPinnedPreview();
          return;
        }
        applyOpacityField(getLabeledOpacityField());
        setIsHoverPreviewActive(true);
      } else if (isHoverPreviewActive) {
        pushOpacityFromData();
        setIsHoverPreviewActive(false);
      }
    },
    [applyOpacityField, applyPinnedPreview, getLabeledOpacityField, isHoverPreviewActive, isPreviewPinned, pushOpacityFromData]
  );

  const deactivatePreview = useCallback(() => {
    restoreDoiSnapshot();
    previousSelectionRef.current = null;
    setIsPreviewPinned(false);
    setIsHoverPreviewActive(false);
  }, [restoreDoiSnapshot]);

  const togglePinnedLabeledDoiMode = useCallback(() => {
    const labeledPointIds = getLabeledPointIds();

    if (isPreviewPinned) {
      const currentSelection = store.getState().selection.selectedNodeIds;
      if (!areNodeIdListsEqual(currentSelection, labeledPointIds)) {
        applyPinnedPreview();
        return;
      }

      const restoredSelection = previousSelectionRef.current ?? [];
      deactivatePreview();
      dispatch(setSelectedNodes(restoredSelection));
      void runSelectionWorkflow(restoredSelection, { clearFeatureSearch: false });
      return;
    }

    previousSelectionRef.current = selectedNodeIds.slice();
    applyPinnedPreview();
  }, [
    applyPinnedPreview,
    areNodeIdListsEqual,
    getLabeledPointIds,
    isPreviewPinned,
    previousSelectionRef,
    selectedNodeIds,
    deactivatePreview,
    dispatch,
    runSelectionWorkflow,
  ]);

  const syncAssignmentsIntoVisualization = useCallback(() => {
    syncAssignmentsIntoVisualizationImpl(dataRef.current, dispatch, selectLabelFeatureName(store.getState()));
  }, [dataRef, dispatch]);

  // Selection operations
  const selectCluster = useCallback(
    (clusterId: ClusterId) => {
      dispatch(toggleClusterSelection(clusterId));
    },
    [dispatch]
  );

  const setSelection = useCallback(
    (clusterIds: ClusterId[]) => {
      dispatch(setSelectedClusters(clusterIds));
    },
    [dispatch]
  );

  const clearSelection = useCallback(() => {
    dispatch(setSelectedClusters([]));
  }, [dispatch]
  );

  // Labeling operations
  const assignLabel = useCallback(
    (label: string) => {
      // Validate
      const validation = LabelingService.validateLabel(label);
      if (!validation.valid) {
        dispatch(setInputError(validation.error));
        return false;
      }

      // Preserve the user-entered label text as-is, minus surrounding whitespace.
      const normalized = LabelingService.normalizeLabel(label);

      const commit = () => {
        const topDoiClusterIds = getTopDoiBucketClusterIds();
        if (topDoiClusterIds.length === 0) {
          dispatch(setInputError("No nodes found in top DoI bucket (DoI >= inset threshold)."));
          return false;
        }

        // In labeling mode, Assign targets the top DoI bucket.
        dispatch(setSelectedClusters(topDoiClusterIds));

        // Assign
        dispatch(assignLabelToSelected(normalized));
        syncAssignmentsIntoVisualization();
        return true;
      };
      // Row contract (issue #315 R1b/R1c): the assign is the user action that
      // materializes a row-lazy dataset — the bucket filter and the features
      // write-back both need real rows, and the enable-transition hook cannot
      // be the cause because labeling is always enabled (#182). Chip at cause
      // time, then the unchanged commit.
      const points = dataRef.current;
      if (areRowsResident(points)) return commit();
      void ensureResidentRowsWithChip(points, "Preparing rows for labeling")
        .then(commit)
        .catch(() => undefined);
      return true;
    },
    [dataRef, dispatch, getTopDoiBucketClusterIds, syncAssignmentsIntoVisualization]
  );

  const assignLabelToClusterUid = useCallback(
    (clusterUid: string, label: string) => {
      const validation = LabelingService.validateLabel(label);
      if (!validation.valid) {
        dispatch(setInputError(validation.error));
        return false;
      }
      const normalized = LabelingService.normalizeLabel(label);
      const commit = () => {
        // Spec-aware membership (issue #315 R1c): index-backed groups keep
        // their slots as holes even once the canonical rows are resident —
        // the ids come from the member spec's columnar refs, never from a
        // slot walk. See labelingMemberIds.ts.
        const ids = collectClusterUidMemberIds(clusterUid, dataRef.current);
        if (ids.length === 0) {
          dispatch(setInputError("No nodes found in cluster."));
          return false;
        }
        dispatch(setSelectedClusters(ids));
        dispatch(assignLabelToSelected(normalized));
        syncAssignmentsIntoVisualization();
        if (isPreviewPinned) applyPinnedPreview();
        return true;
      };
      // Row contract: see assignLabel — the write-back needs real rows; chip
      // at cause time on the row-lazy lane, unchanged sync path elsewhere.
      const points = dataRef.current;
      if (areRowsResident(points)) return commit();
      void ensureResidentRowsWithChip(points, "Preparing rows for labeling")
        .then(commit)
        .catch(() => undefined);
      return true;
    },
    [dataRef, dispatch, syncAssignmentsIntoVisualization, isPreviewPinned, applyPinnedPreview]
  );

  const removeLabel = useCallback(
    (clusterId: ClusterId) => {
      dispatch(removeLabelFromCluster(clusterId));
      syncAssignmentsIntoVisualization();
    },
    [dispatch, syncAssignmentsIntoVisualization]
  );

  const updateInputLabel = useCallback(
    (label: string) => {
      dispatch(setInputLabel(label));
    },
    [dispatch]
  );

  const updateLabelFeatureName = useCallback(
    (featureName: string) => {
      // Shared with the Visual Encoding tab; empty = back to the dataset default.
      // The re-sync from the new column happens in useLabelingAutoSync, the
      // one subscriber to the resolved column for every input (issue #352).
      dispatch(setAnnotationLabelFeature(featureName.trim() || null));
    },
    [dispatch]
  );

  const resetAllLabels = useCallback(() => {
    if (window.confirm("Are you sure? This will clear all labels.")) {
      dispatch(clearAllAssignments());
      syncAssignmentsIntoVisualization();
    }
  }, [dispatch, syncAssignmentsIntoVisualization]
  );

  // Selection helpers. The full id list materializes lazily from the
  // registry only inside these rare actions — never on the boot/render path
  // (issue #315 I2).
  const selectUnlabeled = useCallback(() => {
    const labeled = new Set(labeledIds);
    dispatch(
      setSelectedClusters(
        getLabelingClusterIds().filter((id) => !labeled.has(id))
      )
    );
  }, [dispatch, labeledIds]
  );

  const selectLabeled = useCallback(() => {
    dispatch(setSelectedClusters(labeledIds as ClusterId[]));
  }, [dispatch, labeledIds]
  );

  const selectAll = useCallback(() => {
    // Duplicates (labeled ids also present in the dataset) collapse in the
    // selection Set; stale labeled ids from restored sessions stay included,
    // matching the previous unlabeledIds.concat(labeledIds) behavior.
    dispatch(
      setSelectedClusters(
        getLabelingClusterIds().concat(labeledIds as ClusterId[])
      )
    );
  }, [dispatch, labeledIds]
  );

  useEffect(() => {
    return () => {
      restoreDoiSnapshot();
    };
  }, [restoreDoiSnapshot]);

  return {
    // State
    selectedCount,
    assignableCount,
    assignments,
    inputLabel,
    inputError,
    existingLabels,
    progress,
    metadata,
    labelFeatureName,
    isLabeledOpacityPreviewActive: isHoverPreviewActive || isPreviewPinned,
    isLabeledOpacityPreviewPinned: isPreviewPinned,

    // Selection
    selectCluster,
    setSelection,
    clearSelection,
    selectUnlabeled,
    selectLabeled,
    selectAll,

    // Labeling
    assignLabel,
    assignLabelToClusterUid,
    removeLabel,
    updateInputLabel,
    updateLabelFeatureName,
    resetAllLabels,
    setLabeledOpacityPreview: setHoverPreview,
    togglePinnedLabeledDoiMode,

  };
};
