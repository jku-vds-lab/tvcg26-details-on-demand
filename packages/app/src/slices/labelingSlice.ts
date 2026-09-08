import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import type {
    ClusterId,
    LabelingState,
    SemanticLabel,
} from "../types/labeling";

const initialLabelingState: LabelingState = {
  // Labeling is always active: clicking an inset can (re)label it at any time,
  // without the former Ctrl+L visual-encoding "focus" mode (see #182).
  isEnabled: true,
  unlabeledOnlyMode: false,
  selectedIds: new Set(),
  assignments: new Map(),
  inputLabel: "",
  inputError: undefined,
  existingLabels: new Set(),
  totalClusters: 0,
  metadata: {
    datasetKey: "unknown",
    datasetName: "Unknown",
    startedAt: Date.now(),
    autosaveEnabled: true,
  },
  activeInlineClusterUid: null,
  activeInlineElementId: null,
  activeInlineDraft: "",
};

const labelingSlice = createSlice({
  name: "labeling",
  initialState: initialLabelingState,
  reducers: {
    /**
     * Enable/disable "unlabeled-only" mode.
     * When true, already-labeled nodes are capped below the annotation DoI
     * threshold and excluded from clustering, activation, and annotation.
     */
    setUnlabeledOnlyMode(state, action: PayloadAction<boolean>) {
      state.unlabeledOnlyMode = action.payload;
    },

    /**
     * Enable/disable labeling mode
     */
    setLabelingMode(state, action: PayloadAction<boolean>) {
      state.isEnabled = action.payload;
      if (action.payload) {
        state.metadata.startedAt = Date.now();
      } else {
        state.activeInlineClusterUid = null;
        state.activeInlineElementId = null;
        state.activeInlineDraft = "";
      }
    },

    /**
     * Initialize labeling session with dataset metadata
     */
    initializeLabelingSession(
      state,
      action: PayloadAction<{
        datasetKey: string;
        datasetName: string;
        totalClusters: number;
      }>
    ) {
      state.metadata.datasetKey = action.payload.datasetKey;
      state.metadata.datasetName = action.payload.datasetName;
      state.totalClusters = action.payload.totalClusters;
      state.isEnabled = true;
    },

    /**
     * Toggle selection of a single cluster
     */
    toggleClusterSelection(state, action: PayloadAction<ClusterId>) {
      const id = action.payload;
      if (state.selectedIds.has(id)) {
        state.selectedIds.delete(id);
      } else {
        state.selectedIds.add(id);
      }
    },

    /**
     * Replace the selection set entirely
     */
    setSelectedClusters(state, action: PayloadAction<ClusterId[]>) {
      state.selectedIds = new Set(action.payload);
    },

    /**
     * Add to the selection (multi-select without replacing)
     */
    addToSelection(state, action: PayloadAction<ClusterId[]>) {
      action.payload.forEach((id) => state.selectedIds.add(id));
    },

    /**
     * Clear the selection
     */
    clearSelection(state) {
      state.selectedIds.clear();
    },

    /**
     * Assign label to all selected clusters
     */
    assignLabelToSelected(
      state,
      action: PayloadAction<SemanticLabel>
    ) {
      const label = action.payload;
      state.selectedIds.forEach((id) => {
        state.assignments.set(id, label);
      });
      // Add label to existing labels set
      state.existingLabels.add(label);
      state.inputLabel = "";
      state.inputError = undefined;
    },

    /**
     * Remove label from a specific cluster
     */
    removeLabelFromCluster(state, action: PayloadAction<ClusterId>) {
      state.assignments.delete(action.payload);
    },

    /**
     * Bulk assign labels (import from file)
     */
    importLabels(
      state,
      action: PayloadAction<Record<string, string>>
    ) {
      const imported = action.payload;
      Object.entries(imported).forEach(([clusterId, label]) => {
        state.assignments.set(
          clusterId as ClusterId,
          label as SemanticLabel
        );
        state.existingLabels.add(label as SemanticLabel);
      });
      state.metadata.lastSavedAt = Date.now();
    },

    /**
     * Update input field (what user is typing)
     */
    setInputLabel(state, action: PayloadAction<string>) {
      state.inputLabel = action.payload;
      state.inputError = undefined;
    },

    /**
     * Set validation error on input
     */
    setInputError(state, action: PayloadAction<string | undefined>) {
      state.inputError = action.payload;
    },

    /**
     * Clear all assignments (reset labeling)
     */
    clearAllAssignments(state) {
      state.assignments.clear();
      state.existingLabels.clear();
      state.selectedIds.clear();
      state.inputLabel = "";
      state.inputError = undefined;
    },

    /**
     * Mark that labels were saved
     */
    markLabelsSaved(state) {
      state.metadata.lastSavedAt = Date.now();
    },

    /**
     * Set the total cluster count (for progress tracking); the ids stay in
     * the lazy registry (`labelingClusterIds.ts`).
     */
    setTotalClusters(state, action: PayloadAction<number>) {
      state.totalClusters = action.payload;
    },

    /**
     * Enable/disable autosave
     */
    setAutosaveEnabled(state, action: PayloadAction<boolean>) {
      state.metadata.autosaveEnabled = action.payload;
    },

    /**
     * Set current session ID (when loading from storage)
     */
    setCurrentSessionId(state, action: PayloadAction<string | undefined>) {
      state.metadata.currentSessionId = action.payload;
    },

    /**
     * Load labels from a previous session
     */
    loadSessionFromStorage(
      state,
      action: PayloadAction<{
        labels: Record<string, string>;
        sessionId: string;
        sessionName: string;
      }>
    ) {
      const { labels, sessionId } = action.payload;
      state.assignments.clear();
      state.existingLabels.clear();

      Object.entries(labels).forEach(([clusterId, label]) => {
        state.assignments.set(
          clusterId as ClusterId,
          label as SemanticLabel
        );
        state.existingLabels.add(label as SemanticLabel);
      });

      state.metadata.currentSessionId = sessionId;
      state.metadata.lastSavedAt = Date.now();
      state.inputLabel = "";
      state.inputError = undefined;
    },

    /**
     * Apply undo operation (restore previous state)
     */
    applyUndoAction(
      state,
      action: PayloadAction<Record<string, string | null>>
    ) {
      const previousState = action.payload;
      state.assignments.clear();
      state.existingLabels.clear();

      Object.entries(previousState).forEach(([clusterId, label]) => {
        if (label !== null) {
          state.assignments.set(clusterId as ClusterId, label as SemanticLabel);
          state.existingLabels.add(label as SemanticLabel);
        }
      });
    },

    /**
     * Begin inline click-to-label for a specific cluster
     */
    beginInlineLabeling(
      state,
      action: PayloadAction<{ clusterUid: string; elementId: string }>
    ) {
      state.activeInlineClusterUid = action.payload.clusterUid;
      state.activeInlineElementId = action.payload.elementId;
      state.activeInlineDraft = "";
    },

    /**
     * Update the draft text while user is typing in the inline input
     */
    updateInlineDraft(state, action: PayloadAction<string>) {
      state.activeInlineDraft = action.payload;
    },

    /**
     * End inline labeling (commit or cancel)
     */
    endInlineLabeling(state) {
      state.activeInlineClusterUid = null;
      state.activeInlineElementId = null;
      state.activeInlineDraft = "";
    },

    /**
     * Apply redo operation (restore forward state)
     */
    applyRedoAction(
      state,
      action: PayloadAction<Record<string, string | null>>
    ) {
      const nextState = action.payload;
      state.assignments.clear();
      state.existingLabels.clear();

      Object.entries(nextState).forEach(([clusterId, label]) => {
        if (label !== null) {
          state.assignments.set(clusterId as ClusterId, label as SemanticLabel);
          state.existingLabels.add(label as SemanticLabel);
        }
      });
    },
  },
});

export const {
  setUnlabeledOnlyMode,
  setLabelingMode,
  initializeLabelingSession,
  toggleClusterSelection,
  setSelectedClusters,
  addToSelection,
  clearSelection,
  assignLabelToSelected,
  removeLabelFromCluster,
  importLabels,
  setInputLabel,
  setInputError,
  clearAllAssignments,
  markLabelsSaved,
  setTotalClusters,
  setAutosaveEnabled,
  setCurrentSessionId,
  loadSessionFromStorage,
  applyUndoAction,
  applyRedoAction,
  beginInlineLabeling,
  updateInlineDraft,
  endInlineLabeling,
} = labelingSlice.actions;

export default labelingSlice.reducer;
