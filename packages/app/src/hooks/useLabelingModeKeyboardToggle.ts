import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { setLabelingClusterIdProvider } from "../slices/labelingClusterIds";
import {
    clearAllAssignments,
    initializeLabelingSession,
    setSelectedClusters,
    setTotalClusters,
} from "../slices/labelingSlice";
import type { RootState } from "../store";
import type { ClusterId } from "../types/labeling";
import { createClusterId } from "../types/labeling";

const UNKNOWN_DATASET_KEY = "unknown";

/** Lazy node-id source: the labeling session needs the COUNT eagerly, the
 * ids themselves only on the rare select-all / labeled-session paths. */
export interface LabelingNodeIdSource {
  count: number;
  get: () => number[];
}

/**
 * Build the id source for the labeling session (issue #315 R1a, census
 * A17): on a column-backed canonical array the count comes from the id
 * column and the 1M-element id array is never built eagerly — the previous
 * eager `map().filter()` walked every row object once per boot. Plain
 * arrays (uploads, legacy JSON) keep the eager filtered copy, which their
 * sizes afford.
 */
export function labelingNodeIdSourceFor(
  data: readonly { id?: number | null }[] | null | undefined,
  columnIds: ArrayLike<number> | null
): LabelingNodeIdSource {
  if (columnIds) {
    return { count: columnIds.length, get: () => Array.from(columnIds) };
  }
  const ids = (data ?? [])
    .map((node) => node.id)
    .filter((id): id is number => id != null);
  return { count: ids.length, get: () => ids };
}

function deriveDatasetKey(datasetType: string, datasetPath: string): string {
  const path = datasetPath.trim();
  if (path.length > 0) return `path:${path}`;
  const type = datasetType.trim().toLowerCase();
  if (type.length > 0) return `type:${type}`;
  return UNKNOWN_DATASET_KEY;
}

function deriveDatasetName(datasetType: string, datasetPath: string): string {
  const path = datasetPath.trim();
  if (path.length > 0) {
    const normalized = path.replace(/\\/g, "/");
    const basename = normalized.split("/").pop();
    if (basename && basename.trim().length > 0) return basename;
    return normalized;
  }
  const type = datasetType.trim();
  return type.length > 0 ? type : "Unknown";
}

/**
 * Hook that keeps the always-on labeling session in sync with the current
 * dataset: it (re)initializes cluster IDs and clears stale assignments when
 * the dataset changes, and tracks cluster-count changes.
 *
 * Labeling is always active (see #182); there is no longer a Ctrl+L toggle
 * and no associated visual-encoding "focus" mode. Call this once in a
 * top-level component (e.g., App.tsx).
 */
export const useLabelingModeKeyboardToggle = (nodeIds: LabelingNodeIdSource) => {
  const dispatch = useDispatch();
  const isEnabled = useSelector((state: RootState) => state.labeling.isEnabled);
  const datasetType = useSelector((state: RootState) => state.dataset.datasetType);
  const datasetPath = useSelector((state: RootState) => state.dataset.datasetPath);
  const labelingDatasetKey = useSelector((state: RootState) => state.labeling.metadata.datasetKey);
  const totalClusters = nodeIds.count;
  const previousTotalClustersRef = useRef(totalClusters);
  const previousDatasetKeyRef = useRef<string | null>(null);

  const currentDatasetKey = deriveDatasetKey(datasetType, datasetPath);
  const currentDatasetName = deriveDatasetName(datasetType, datasetPath);
  // Lazy: the ids never enter Redux — only the count does. The registry
  // provider materializes up to 1M strings ON DEMAND (rare select-all /
  // labeled-session paths); building them eagerly and storing them through
  // Immer cost ~0.3 s on the 1M boot critical path (issue #315 D2 + I2).
  const makeClusterIds = (): ClusterId[] => nodeIds.get().map((id) => createClusterId(String(id)));

  useEffect(() => {
    if (!isEnabled) {
      previousTotalClustersRef.current = totalClusters;
      return;
    }

    setLabelingClusterIdProvider(makeClusterIds);
    const datasetChanged = previousDatasetKeyRef.current !== currentDatasetKey;

    if (datasetChanged) {
      dispatch(clearAllAssignments());
      dispatch(
        initializeLabelingSession({
          datasetKey: currentDatasetKey,
          datasetName: currentDatasetName,
          totalClusters,
        })
      );
      dispatch(setSelectedClusters([]));
      previousDatasetKeyRef.current = currentDatasetKey;
      previousTotalClustersRef.current = totalClusters;
      return;
    }

    if (previousTotalClustersRef.current !== totalClusters) {
      dispatch(setTotalClusters(totalClusters));
      dispatch(setSelectedClusters([]));
      previousTotalClustersRef.current = totalClusters;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- makeClusterIds is derived from nodeIds; totalClusters/currentDatasetKey are its content proxies
  }, [
    currentDatasetKey,
    currentDatasetName,
    dispatch,
    isEnabled,
    totalClusters,
  ]);

  useEffect(() => {
    if (!isEnabled) return;
    previousDatasetKeyRef.current = labelingDatasetKey;
  }, [isEnabled, labelingDatasetKey]);
};
