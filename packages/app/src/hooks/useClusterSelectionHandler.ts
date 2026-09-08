import { useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
    selectLabelingIsEnabled,
    selectSelectedClusterIds,
} from "../slices/labelingSelectors";
import {
    addToSelection,
    setSelectedClusters,
    toggleClusterSelection,
} from "../slices/labelingSlice";
import type { AppDispatch } from "../store";
import type { ClusterId } from "../types/labeling";

/**
 * Hook for handling cluster selection in labeling mode.
 * 
 * Usage (in your visualization click handler):
 * ```tsx
 * const { handleClusterClick } = useClusterSelectionHandler();
 * 
 * const onVisualizationClick = (event: MouseEvent, clusterId: ClusterId) => {
 *   handleClusterClick(clusterId, event);
 * };
 * ```
 */
export const useClusterSelectionHandler = () => {
  const dispatch = useDispatch<AppDispatch>();
  const isLabelingEnabled = useSelector(selectLabelingIsEnabled);
  const selectedIds = useSelector(selectSelectedClusterIds);

  /**
   * Handle cluster click with modifier key support:
   * - Plain click: toggle single cluster
   * - Ctrl/Cmd + click: add to selection
   * - Shift + click: extend range (not implemented yet)
   */
  const handleClusterClick = useCallback(
    (clusterId: ClusterId, mouseEvent: React.MouseEvent) => {
      if (!isLabelingEnabled) return;

      mouseEvent.stopPropagation();

      if (mouseEvent.ctrlKey || mouseEvent.metaKey) {
        // Ctrl/Cmd + click: toggle in current selection
        dispatch(toggleClusterSelection(clusterId));
      } else if (mouseEvent.shiftKey) {
        // Shift + click: add to selection
        dispatch(addToSelection([clusterId]));
      } else {
        // Plain click: replace selection with this cluster
        dispatch(setSelectedClusters([clusterId]));
      }
    },
    [isLabelingEnabled, dispatch]
  );

  /**
   * Handle right-click context menu (optional)
   */
  const handleClusterContextMenu = useCallback(
    (clusterId: ClusterId, mouseEvent: React.MouseEvent) => {
      if (!isLabelingEnabled) return;

      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();

      // Add to selection on right-click (don't replace)
      if (!selectedIds.includes(clusterId)) {
        dispatch(addToSelection([clusterId]));
      }
    },
    [isLabelingEnabled, selectedIds, dispatch]
  );

  /**
   * Hover effect (optional - for visual feedback)
   */
  const handleClusterHover = useCallback(
    (_clusterId: ClusterId, _isHovering: boolean) => {
      if (!isLabelingEnabled) return;
      // Could dispatch a "hoveredClusterId" state for visual feedback
      // dispatch(setHoveredCluster(_isHovering ? _clusterId : null));
    },
    [isLabelingEnabled]
  );

  /**
   * Check if a cluster is currently selected
   */
  const isSelected = useCallback(
    (clusterId: ClusterId) => selectedIds.includes(clusterId),
    [selectedIds]
  );

  /**
   * Get current selection count
   */
  const getSelectionCount = useCallback(
    () => selectedIds.length,
    [selectedIds]
  );

  return {
    handleClusterClick,
    handleClusterContextMenu,
    handleClusterHover,
    isSelected,
    getSelectionCount,
    isLabelingEnabled,
  };
};

/**
 * Helper hook to render visual selection feedback on clusters.
 * Returns CSS class or style object based on selection state.
 */
export const useClusterSelectionVisuals = (clusterId: ClusterId) => {
  const selectedIds = useSelector(selectSelectedClusterIds);
  const isLabelingEnabled = useSelector(selectLabelingIsEnabled);

  const isSelected = selectedIds.includes(clusterId);

  return {
    isSelected,
    className: isSelected && isLabelingEnabled ? "cluster-selected" : "",
    style: isSelected && isLabelingEnabled
      ? {
          outline: "2px solid #007dad",
          outlineOffset: "2px",
          opacity: 1,
        }
      : {},
  };
};
