import { createSlice, PayloadAction } from "@reduxjs/toolkit";

/**
 * One freehand-created inset: membership is exactly the lassoed points.
 * Freehand insets bypass HDBSCAN clustering and the semantic-zoom
 * activation/budget pipeline entirely — they exist until replaced by the
 * next plain lasso, freehand mode is left, or the dataset changes.
 */
export interface FreehandInset {
  /** Stable id used as the visual-element cluster id (e.g. "fh-3"). */
  id: string;
  /** Ids of the DataPoints captured by the lasso. */
  memberIds: number[];
}

export interface FreehandState {
  /** When true, a lasso creates one inset from exactly the lassoed points. */
  isFreehandMode: boolean;
  /** When false, the automated cluster annotations/insets are hidden. */
  showAutoInsets: boolean;
  insets: FreehandInset[];
  /** Monotonic counter so element ids are never reused within a session. */
  nextInsetId: number;
}

const initialFreehandState: FreehandState = {
  isFreehandMode: false,
  showAutoInsets: true,
  insets: [],
  nextInsetId: 1,
};

const freehandSlice = createSlice({
  name: "freehand",
  initialState: initialFreehandState,
  reducers: {
    /** Leaving freehand mode clears its insets (they are mode-scoped). */
    setFreehandMode(state, action: PayloadAction<boolean>) {
      state.isFreehandMode = action.payload;
      if (!action.payload) {
        state.insets = [];
      }
    },

    setShowAutoInsets(state, action: PayloadAction<boolean>) {
      state.showAutoInsets = action.payload;
    },

    /** Plain lasso: the lassoed points become the single freehand inset. */
    replaceFreehandInsets(state, action: PayloadAction<number[]>) {
      state.insets = action.payload.length
        ? [{ id: `fh-${state.nextInsetId++}`, memberIds: action.payload }]
        : [];
    },

    /** Ctrl+lasso: each lasso adds its own separate inset (no union). */
    addFreehandInset(state, action: PayloadAction<number[]>) {
      if (!action.payload.length) return;
      state.insets.push({
        id: `fh-${state.nextInsetId++}`,
        memberIds: action.payload,
      });
    },
  },
  extraReducers: (builder) => {
    // Member ids are dataset-specific: drop freehand insets on dataset switch.
    // Matched by type string to avoid importing from store.ts (import cycle).
    builder.addCase("dataset/setDatasetMetadata", (state) => {
      state.insets = [];
    });
  },
});

export const {
  setFreehandMode,
  setShowAutoInsets,
  replaceFreehandInsets,
  addFreehandInset,
} = freehandSlice.actions;

/**
 * Union of all freehand-pinned point ids. These points are exempt from the
 * DoI propagation pipeline (they stay DoI = 1 — pass the result as
 * `pinnedNodeIds` into the field lane, #337) and from automated cluster
 * activation.
 */
export function freehandPinnedIds(state: FreehandState): Set<number> {
  const union = new Set<number>();
  for (const inset of state.insets) {
    for (const id of inset.memberIds) union.add(id);
  }
  return union;
}

export default freehandSlice.reducer;
