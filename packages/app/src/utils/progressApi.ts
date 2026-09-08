import {
    progressComplete,
    progressFail,
    progressStart,
    progressUpdate,
} from "../slices/progressSlice";
import store from "../store"; // adjust if store default export differs

export function startTask(args: {
  id: string;
  label: string;
  value?: number | null;
  phase?: string;
  kind?: "io" | "compute";
  parentId?: string;
  cancellable?: boolean;
  minShowMs?: number;
  stickyOnCompleteMs?: number;
  progressMode?: "predictive" | "indeterminate";
}) {
  store.dispatch(progressStart(args));
}

export function updateTask(args: {
  id: string;
  label?: string;
  value?: number | null;
  phase?: string;
  progressMode?: "predictive" | "indeterminate";
}) {
  store.dispatch(progressUpdate(args));
}

export function completeTask(id: string) {
  store.dispatch(progressComplete({ id }));
}

export function failTask(id: string, label?: string) {
  store.dispatch(progressFail({ id, label }));
}

// ── Boot-parent grouping (issue #315 Arc 1 Task 3b: ONE loading line) ──────
// Every boot/switch compute task ("Preparing interactions", "Analyzing
// features", "Clustering") attaches to ONE parent id per dataset load, so
// GlobalProgressDock renders them as a single grouped card instead of a
// stack. When a menu load is in flight its "Loading dataset" task id is
// adopted as the parent (the dock then folds that root card into the group);
// otherwise (deep-link/mount boot) a synthetic id groups the children.

let activeDatasetLoadId: string | null = null;

/** Set/clear by the dataset-load owner (DatasetTabPanel predefined loads). */
export function setActiveDatasetLoadTask(id: string | null) {
  activeDatasetLoadId = id;
}

const bootIds = new WeakMap<object, string>();
let bootSeq = 0;

/** Stable per-dataset-load parent id, keyed by the loaded data's identity. */
export function bootParentIdFor(key: object): string {
  let id = bootIds.get(key);
  if (!id) {
    id = activeDatasetLoadId ?? `task:dataset-boot:${++bootSeq}`;
    bootIds.set(key, id);
  }
  return id;
}

export function clearTaskTree(parentId: string, label = "Cancelled") {
  const tasks = store.getState().progress?.tasks ?? {};

  for (const [id, task] of Object.entries(tasks)) {
    const isRoot = id === parentId;
    const isChild = task?.parentId === parentId;
    if (isRoot || isChild) {
      store.dispatch(progressFail({ id, label }));
    }
  }
}
