// packages/app/src/workers/hdbscan.worker.ts
//
// Runs the HDBSCAN hierarchy build entirely off the main thread.
//
// Uses buildHdbscanHierarchy (the scalable single-linkage implementation from
// the simple-format loading path) instead of ExtendedHDBSCAN.fit():
// hdbscan-ts materializes a full n×n distance matrix and rebuilds membership
// arrays per hierarchy split, which takes ~9 minutes and ~1 GB at 10k points;
// buildHdbscanHierarchy computes the equivalent full single-linkage tree in
// O(n) memory / O(n²) time (~2 s at 10k) and reports fit progress.
//
// The produced tree is "lightweight" (leaves carry leafIndex, internal nodes
// no materialized children) — the receiving side attaches the DFS leaf-order
// index exactly like useRehydrateHdbscan does for precomputed trees.
//
// Note: options.minClusterSize/alpha/group are accepted for wire compatibility
// but ignored — every caller fits with minClusterSize 1 (the full tree), which
// is what buildHdbscanHierarchy produces; hdbscan-ts ignored alpha/group too.
//
// Wire types are kept local to avoid cross-context import issues; they must
// stay in sync with HdbscanWorkerRequest / HdbscanWorkerResponse in hdbscanWorkerProxy.ts.

import { buildHdbscanHierarchy } from "../dataPreprocessing/hdbscanHierarchy";
import {
  flattenHdbscanTree,
  type HdbscanTreeWire,
} from "../dataPreprocessing/hdbscanTreeWire";
import type { ExtendedHDBSCANOptions } from "../clustering/ExtendedHDBSCAN";

interface WorkerRequest {
  jobId: number;
  coords: number[][];
  options: Pick<ExtendedHDBSCANOptions, "minClusterSize" | "minSamples" | "alpha" | "group">;
}

interface WorkerResponse {
  jobId: number;
  /** 0..1 fit fraction; progress-only messages carry neither tree nor error. */
  progress?: number;
  /** Flat wire form of the hierarchy (hdbscanTreeWire.ts): the nested tree
   * must NEVER cross postMessage — structured clone recurses and a long
   * merge chain blows the stack (2026-08-21 inset-freeze bug). */
  treeWire?: HdbscanTreeWire;
  error?: string;
}

const post = (msg: WorkerResponse) => {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore web worker global
  self.postMessage(msg);
};

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { jobId, coords, options } = ev.data;

  try {
    const points = coords.map(([x, y]) => ({ x, y }));
    const tree = buildHdbscanHierarchy(points, {
      minSamples: options.minSamples ?? 1,
      onProgress: (fraction) => post({ jobId, progress: fraction }),
    });

    if (!tree) {
      // Should not happen for a non-empty coords array — surface as an error.
      post({ jobId, error: "HDBSCAN produced no hierarchy tree" });
      return;
    }

    post({ jobId, treeWire: flattenHdbscanTree(tree) });
  } catch (err) {
    post({ jobId, error: err instanceof Error ? err.message : String(err) });
  }
};
