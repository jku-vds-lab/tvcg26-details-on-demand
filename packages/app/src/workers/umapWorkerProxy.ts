// packages/app/src/workers/umapWorkerProxy.ts
//
// Singleton proxy for the UMAP projection Web Worker.
//
// Same design as hdbscanWorkerProxy: one worker at a time, a new run()
// hard-terminates any in-flight job (umap-js steps synchronously inside the
// worker), and cancel() rejects the pending promise with an AbortError so
// callers can distinguish "cancelled" from "real error".

import type { KnnGraph } from "../types/graphTypes";
import type { UmapMetric } from "./umap.worker";
import { makeUmapWorker } from "./workerFactories";

export interface UmapParams {
  nNeighbors: number;
  minDist: number;
  spread: number;
  /** 0 = let umap-js pick automatically from the dataset size. */
  nEpochs: number;
  metric: UmapMetric;
  seed: number;
}

export interface UmapWorkerRequest {
  jobId: number;
  matrix: ArrayBuffer;
  nRows: number;
  nCols: number;
  params: UmapParams;
}

export interface UmapWorkerResponse {
  jobId: number;
  type: "progress" | "done" | "error";
  stage?: "neighbors" | "epochs" | "knn2d";
  epoch?: number;
  totalEpochs?: number;
  coords?: ArrayBuffer;
  knnGraph?: KnnGraph;
  error?: string;
}

/**
 * Run-stage progress. "neighbors" (high-dimensional kNN search inside
 * umap-js initializeFit) and "knn2d" (2D kNN over the final embedding) carry
 * no fraction — umap-js exposes no per-iteration hooks there; only the
 * optimization epochs are quantified.
 */
export type UmapProgress =
  | { stage: "neighbors" }
  | { stage: "epochs"; epoch: number; totalEpochs: number }
  | { stage: "knn2d" };

export interface UmapRunResult {
  /** Interleaved [x0, y0, x1, y1, ...] 2D embedding. */
  coords: Float32Array;
  /** k=5 kNN over the embedding, self first (same semantics as the offline graph). */
  knnGraph: KnnGraph;
}

class UmapWorkerProxy {
  private worker: Worker | null = null;
  private pendingReject: ((reason: unknown) => void) | null = null;
  private jobCounter = 0;

  /**
   * Terminate any in-flight worker and reject its pending promise with an
   * AbortError. Safe to call when there is nothing in flight.
   */
  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.pendingReject) {
      this.pendingReject(new DOMException("UMAP projection cancelled", "AbortError"));
      this.pendingReject = null;
    }
  }

  /**
   * Run a UMAP projection in a dedicated worker thread. The matrix buffer is
   * transferred (zero-copy) and unusable by the caller afterwards.
   *
   * Any previously running job is terminated first (see cancel()).
   */
  run(
    matrix: Float32Array,
    nRows: number,
    nCols: number,
    params: UmapParams,
    onProgress?: (progress: UmapProgress) => void
  ): Promise<UmapRunResult> {
    this.cancel();

    const jobId = ++this.jobCounter;

    return new Promise<UmapRunResult>((resolve, reject) => {
      this.pendingReject = reject;

      const worker = makeUmapWorker();
      this.worker = worker;

      worker.onmessage = (ev: MessageEvent<UmapWorkerResponse>) => {
        if (ev.data.jobId !== jobId) return;

        if (ev.data.type === "progress") {
          if (ev.data.stage === "neighbors" || ev.data.stage === "knn2d") {
            onProgress?.({ stage: ev.data.stage });
          } else {
            onProgress?.({
              stage: "epochs",
              epoch: ev.data.epoch ?? 0,
              totalEpochs: ev.data.totalEpochs ?? 0,
            });
          }
          return;
        }

        worker.terminate();
        this.worker = null;
        this.pendingReject = null;

        if (ev.data.type === "error" || !ev.data.coords || !ev.data.knnGraph) {
          reject(new Error(ev.data.error ?? "UMAP worker returned no result"));
          return;
        }

        resolve({ coords: new Float32Array(ev.data.coords), knnGraph: ev.data.knnGraph });
      };

      worker.onerror = (e) => {
        this.worker = null;
        this.pendingReject = null;
        reject(e);
      };

      const buffer = matrix.buffer as ArrayBuffer;
      const request: UmapWorkerRequest = { jobId, matrix: buffer, nRows, nCols, params };
      worker.postMessage(request, [buffer]);
    });
  }
}

/** Module-level singleton — one proxy for the entire application. */
export const umapWorkerProxy = new UmapWorkerProxy();
