// packages/app/src/dataPreprocessing/loadSimpleDataset.ts
//
// Main-thread orchestrator for the simple-format loading path: spawns
// simplePreprocess.worker.ts (all heavy compute off the main thread, per
// issue #217), surfaces phase progress through the progress API, and feeds
// the resulting bespoke-JSON-shaped object through JSONLoader so simple
// datasets share the exact hydration path of JSON-loaded ones.

import type { Dataset } from "../types/datasetTypes";
import { completeTask, failTask, startTask, updateTask } from "../utils/progressApi";
import { makeSimplePreprocessWorker } from "../workers/makeSimplePreprocessWorker";
import type { SimplePreprocessResponse } from "../workers/simplePreprocess.worker";
import { JSONLoader } from "./JSONLoader";
import type {
  SimpleColumnMapping,
  SimpleDatasetObject,
  SimpleDatasetOptions,
  SimplePreprocessPhase,
} from "./simpleDataset";

const PHASE_LABELS: Record<SimplePreprocessPhase, string> = {
  normalize: "Preparing rows…",
  knn: "Computing neighbor graph…",
  geometry: "Computing trajectory splines…",
  clusterPoints: "Clustering points…",
  clusterMidpoints: "Clustering trajectory centers…",
};

// Overall-progress span per phase (percent). The two clustering phases
// dominate at scale and stream 0..1 fractions; the cheap phases just jump
// to their span start on entry.
const PHASE_SPAN: Record<SimplePreprocessPhase, [number, number]> = {
  normalize: [0, 3],
  knn: [3, 8],
  geometry: [8, 12],
  clusterPoints: [12, 56],
  clusterMidpoints: [56, 100],
};

/**
 * Enforced row cap for in-app preprocessing. The pipeline is measured to
 * ~37 s of worker compute at 100k rows (O(n²) mutual-reachability MST
 * dominates); beyond that load times and the worker→main transfer grow
 * quadratically, so larger files are rejected with a clear message instead
 * of appearing to hang.
 */
export const SIMPLE_MAX_ROWS = 100_000;

/** Thrown before any work starts when the row count exceeds SIMPLE_MAX_ROWS. */
export class DatasetTooLargeError extends Error {
  constructor(rowCount: number) {
    super(
      `This dataset has ${rowCount.toLocaleString()} rows; in-app preprocessing ` +
        `supports up to ${SIMPLE_MAX_ROWS.toLocaleString()}. Subsample the file and try again.`
    );
    this.name = "DatasetTooLargeError";
  }
}

export interface LoadSimpleDatasetOptions extends SimpleDatasetOptions {
  signal?: AbortSignal;
  parentTaskId?: string;
}

/**
 * Preprocess parsed tabular rows in a worker and resolve to a ready Dataset
 * (same shape and hydration as a bespoke-JSON load).
 */
export async function loadSimpleDataset(
  rows: Record<string, unknown>[],
  mapping: SimpleColumnMapping,
  options: LoadSimpleDatasetOptions = {}
): Promise<Dataset> {
  if (rows.length > SIMPLE_MAX_ROWS) throw new DatasetTooLargeError(rows.length);

  const { signal, parentTaskId, ...datasetOptions } = options;
  const taskId = `${parentTaskId ?? "dataset:simple"}:preprocess`;

  startTask({
    id: taskId,
    label: "Preparing dataset",
    parentId: parentTaskId,
    kind: "compute",
    phase: PHASE_LABELS.normalize,
    value: null,
    progressMode: "indeterminate",
  });

  let obj: SimpleDatasetObject;
  try {
    obj = await runPreprocessWorker(rows, mapping, datasetOptions, taskId, signal);
  } catch (err) {
    failTask(taskId, signal?.aborted ? "Cancelled" : "Dataset preprocessing failed");
    throw err;
  }

  try {
    const dataset = await new Promise<Dataset>((resolve, reject) => {
      new JSONLoader().resolveParsed(obj, resolve).catch(reject);
    });
    if (signal?.aborted) throw new DOMException("Dataset load aborted", "AbortError");
    completeTask(taskId);
    return dataset;
  } catch (err) {
    failTask(taskId, signal?.aborted ? "Cancelled" : "Dataset preparation failed");
    throw err;
  }
}

function runPreprocessWorker(
  rows: Record<string, unknown>[],
  mapping: SimpleColumnMapping,
  options: SimpleDatasetOptions,
  taskId: string,
  signal?: AbortSignal
): Promise<SimpleDatasetObject> {
  return new Promise<SimpleDatasetObject>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Dataset load aborted", "AbortError"));
      return;
    }

    const worker = makeSimplePreprocessWorker();
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Dataset load aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (ev: MessageEvent<SimplePreprocessResponse>) => {
      const msg = ev.data;
      if (msg.type === "phase") {
        updateTask({
          id: taskId,
          phase: PHASE_LABELS[msg.phase],
          value: PHASE_SPAN[msg.phase][0],
        });
        return;
      }
      if (msg.type === "progress") {
        const [from, to] = PHASE_SPAN[msg.phase];
        updateTask({ id: taskId, value: from + msg.fraction * (to - from) });
        return;
      }
      cleanup();
      if (msg.type === "done") resolve(msg.result);
      else reject(new Error(msg.error));
    };
    worker.onerror = (err) => {
      cleanup();
      reject(err);
    };

    worker.postMessage({ rows, mapping, options });
  });
}
