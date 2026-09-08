import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type ProgressKind = "io" | "compute";
export type ProgressMode = "predictive" | "indeterminate";

export type ProgressTask = {
  id: string;
  label: string;
  value: number | null; // 0..100 or null
  startedAt: number;
  visible: boolean;

  // New metadata (optional)
  phase?: string;                 // "Downloading…", "Parsing…", "Clustering…"
  kind?: ProgressKind;            // "io" | "compute"
  parentId?: string;              // used for (1/3) grouping in the dock
  cancellable?: boolean;          // show cancel button if wired
  minShowMs?: number;             // do not render if task finishes faster than this
  stickyOnCompleteMs?: number;    // keep "Done" visible briefly
  progressMode?: ProgressMode;    // "predictive" | "indeterminate"
};

type ProgressState = {
  tasks: Record<string, ProgressTask>;
  lastOrder: string[]; // most-recent-first
  /** Completed-children count per parentId (issue #315 Task 3 round 2): the
   * dock's grouped card shows CUMULATIVE progress across a load's phases —
   * finished phases keep their share instead of vanishing from the average
   * (which made the single bar visibly reset per phase). Cleared when the
   * group's parent task and all children are gone. */
  groupDone: Record<string, number>;
};

const initialState: ProgressState = { tasks: {}, lastOrder: [], groupDone: {} };

/** Drop the done-counter once nothing of the group remains (parent task
 * included — it outlives most children on dataset loads). */
function cleanupGroupDone(state: ProgressState, parentId: string | undefined) {
  if (!parentId) return;
  if (state.tasks[parentId]) return;
  for (const t of Object.values(state.tasks)) {
    if (t.parentId === parentId) return;
  }
  delete state.groupDone[parentId];
}

const slice = createSlice({
  name: "progress",
  initialState,
  reducers: {
    progressStart: (
      state,
      action: PayloadAction<{
        id: string;
        label: string;
        value?: number | null;
        phase?: string;
        kind?: ProgressKind;
        parentId?: string;
        cancellable?: boolean;
        minShowMs?: number;
        stickyOnCompleteMs?: number;
        progressMode?: ProgressMode;
      }>
    ) => {
      const {
        id,
        label,
        value = null,
        phase,
        kind,
        parentId,
        cancellable,
        minShowMs,
        stickyOnCompleteMs,
        progressMode,
      } = action.payload;
      state.tasks[id] = {
        id,
        label,
        value,
        startedAt: performance.now(),
        visible: true,
        phase,
        kind,
        parentId,
        cancellable,
        minShowMs,
        stickyOnCompleteMs,
        progressMode,
      };
      state.lastOrder = [id, ...state.lastOrder.filter((x) => x !== id)];
    },

    progressUpdate: (
      state,
      action: PayloadAction<{
        id: string;
        label?: string;
        value?: number | null;
        phase?: string;
        progressMode?: ProgressMode;
      }>
    ) => {
      const t = state.tasks[action.payload.id];
      if (!t) return;
      if (action.payload.label !== undefined) t.label = action.payload.label;
      if (action.payload.value !== undefined) t.value = action.payload.value;
      if (action.payload.phase !== undefined) t.phase = action.payload.phase;
      if (action.payload.progressMode !== undefined)
        t.progressMode = action.payload.progressMode;
    },

    progressComplete: (state, action: PayloadAction<{ id: string }>) => {
      const t = state.tasks[action.payload.id];
      if (!t) return;
      t.value = 100;
      t.visible = false;
      delete state.tasks[action.payload.id];
      state.lastOrder = state.lastOrder.filter((x) => x !== action.payload.id);
      if (t.parentId) {
        state.groupDone[t.parentId] = (state.groupDone[t.parentId] ?? 0) + 1;
      }
      cleanupGroupDone(state, t.parentId);
    },

    progressFail: (
      state,
      action: PayloadAction<{ id: string; label?: string }>
    ) => {
      const t = state.tasks[action.payload.id];
      if (!t) return;
      t.label = action.payload.label ?? "Failed";
      t.value = null;
      t.visible = false;
      delete state.tasks[action.payload.id];
      state.lastOrder = state.lastOrder.filter((x) => x !== action.payload.id);
      // A failed/cancelled phase must not stall the group bar: count it done.
      if (t.parentId) {
        state.groupDone[t.parentId] = (state.groupDone[t.parentId] ?? 0) + 1;
      }
      cleanupGroupDone(state, t.parentId);
    },

    progressResetAll: (state) => {
      state.tasks = {};
      state.lastOrder = [];
      state.groupDone = {};
    },
  },
});

export const {
  progressStart,
  progressUpdate,
  progressComplete,
  progressFail,
  progressResetAll,
} = slice.actions;

export default slice.reducer;
