/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the component by design; dev HMR full-reloads this file (CS 2026-07-09) */
import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { toggleClusterSelection } from "../../slices/labelingSlice";
import type { RootState } from "../../store";
import type { ClusterId } from "../../types/labeling";
import styles from "./ClusterSelectionOverlay.module.css";

interface ClusterSelectionOverlayProps {
  /** Visible when labeling mode is enabled */
  isVisible: boolean;
  /** Called when user clicks on a cluster in the visualization */
  onClusterClick: (clusterId: ClusterId, event: React.MouseEvent) => void;
}

/**
 * Overlay that provides visual feedback for cluster selection during labeling.
 * Can be extended with hover effects, outlines, highlights, etc.
 * 
 * For now, this is a placeholder. Real integration would require:
 * 1. Access to cluster spatial positions from the renderer
 * 2. Canvas click handler that maps pixels to cluster IDs
 * 3. Redux dispatch for cluster selection on click
 */
export const ClusterSelectionOverlay: React.FC<ClusterSelectionOverlayProps> = ({
  isVisible,
}) => {
  if (!isVisible) return null;

  return (
    <div className={styles.overlay}>
      {/* Overlay is transparent; selection happens through click events */}
      {/* Visual feedback (highlights, outlines) would be rendered here */}
    </div>
  );
};

/**
 * Hook for toggling cluster selection via click.
 * To integrate: attach to canvas click handler in VisualizationContainer.
 */
export const useClusterSelectionClick = () => {
  const dispatch = useDispatch();
  const isEnabled = useSelector((state: RootState) => state.labeling.isEnabled);
  const selectedIds = useSelector((state: RootState) => state.labeling.selectedIds);

  const handleClusterClick = (clusterId: ClusterId, event: React.MouseEvent) => {
    if (!isEnabled) return;

    // Ctrl/Cmd + click = add to selection; otherwise toggle
    if (event.ctrlKey || event.metaKey) {
      dispatch(toggleClusterSelection(clusterId));
    } else {
      dispatch(toggleClusterSelection(clusterId));
    }
  };

  return {
    isEnabled,
    selectedIds,
    handleClusterClick,
  };
};
