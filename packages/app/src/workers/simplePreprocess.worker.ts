// packages/app/src/workers/simplePreprocess.worker.ts
//
// Runs the entire simple-format preprocessing (normalize → kNN → splines →
// HDBSCAN ×2) off the main thread. Thin wrapper over the pure
// buildSimpleDatasetObject (pattern of hdbscan.worker.ts). The result tree
// is posted via structured clone — same precedent as hdbscan.worker.ts.

import {
  buildSimpleDatasetObject,
  type SimpleColumnMapping,
  type SimpleDatasetObject,
  type SimpleDatasetOptions,
  type SimplePreprocessPhase,
} from "../dataPreprocessing/simpleDataset";

export interface SimplePreprocessRequest {
  rows: Record<string, unknown>[];
  mapping: SimpleColumnMapping;
  options?: SimpleDatasetOptions;
}

export type SimplePreprocessResponse =
  | { type: "phase"; phase: SimplePreprocessPhase }
  | { type: "progress"; phase: SimplePreprocessPhase; fraction: number }
  | { type: "done"; result: SimpleDatasetObject }
  | { type: "error"; error: string };

self.onmessage = (ev: MessageEvent<SimplePreprocessRequest>) => {
  const { rows, mapping, options } = ev.data;
  const post = (msg: SimplePreprocessResponse) =>
    (self as unknown as Worker).postMessage(msg);
  try {
    const result = buildSimpleDatasetObject(
      rows,
      mapping,
      options,
      (phase) => post({ type: "phase", phase }),
      (phase, fraction) => post({ type: "progress", phase, fraction })
    );
    post({ type: "done", result });
  } catch (e) {
    post({ type: "error", error: e instanceof Error ? e.message : String(e) });
  }
};
