// packages/app/src/workers/hdbscanWorkerProxy.ts
//
// Singleton proxy for the HDBSCAN Web Worker.
//
// Design principles
// ─────────────────
// • One worker at a time. A new fit() call *terminates* any in-flight worker
//   immediately — there is no way to interrupt the synchronous hdbscan-ts
//   algorithm gracefully, so hard termination is the only real option.
// • AbortError is thrown when the promise is cancelled so callers can
//   distinguish "cancelled" from "real error".
// • cancel() is intentionally public so bumpClusteringEpoch() can hook into it
//   and free resources the moment a new clustering sequence starts.

import type { ClusterTreeNode, ExtendedHDBSCANOptions } from "../clustering/ExtendedHDBSCAN";
import {
  rebuildHdbscanTree,
  type HdbscanTreeWire,
} from "../dataPreprocessing/hdbscanTreeWire";
import { makeHdbscanWorker } from "./makeHdbscanWorker";

// ─── Shared wire types (imported as `type` from hdbscan.worker.ts) ───────────

export interface HdbscanWorkerRequest {
  jobId: number;
  coords: number[][];
  options: Pick<ExtendedHDBSCANOptions, "minClusterSize" | "minSamples" | "alpha" | "group">;
}

export interface HdbscanWorkerResponse {
  jobId: number;
  /** 0..1 fit fraction; progress-only messages carry neither tree nor error. */
  progress?: number;
  /** Flat wire form (hdbscanTreeWire.ts) — the nested tree must never cross
   * postMessage; structured clone recurses and deep merge chains blow the
   * stack (2026-08-21 inset-freeze bug). Rebuilt below before resolving. */
  treeWire?: HdbscanTreeWire;
  error?: string;
}

// ─── Public result type ───────────────────────────────────────────────────────

export interface HdbscanFitResult {
  tree: ClusterTreeNode;
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

class HdbscanWorkerProxy {
  private worker: Worker | null = null;
  private pendingReject: ((reason: unknown) => void) | null = null;
  private jobCounter = 0;

  /**
   * Terminate any in-flight worker and reject its pending promise with an
   * AbortError.  Safe to call when there is nothing in flight.
   */
  cancel(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.pendingReject) {
      this.pendingReject(new DOMException("HDBSCAN computation cancelled", "AbortError"));
      this.pendingReject = null;
    }
  }

  /**
   * Run HDBSCAN fit in a dedicated worker thread.
   *
   * Any previously running computation is terminated first (see cancel()).
   * The returned Promise resolves once the worker posts its result back.
   * It is rejected with a DOMException("AbortError") if cancel() is called
   * before the worker finishes.
   */
  fit(
    coords: number[][],
    options: HdbscanWorkerRequest["options"],
    onProgress?: (fraction: number) => void
  ): Promise<HdbscanFitResult> {
    // Terminate any previous job — no-op if idle.
    this.cancel();

    const jobId = ++this.jobCounter;

    return new Promise<HdbscanFitResult>((resolve, reject) => {
      // Keep the reject handle so cancel() can abort this promise.
      this.pendingReject = reject;

      const worker = makeHdbscanWorker();
      this.worker = worker;

      worker.onmessage = (ev: MessageEvent<HdbscanWorkerResponse>) => {
        // Guard against stale messages (should not happen with terminate, but be safe).
        if (ev.data.jobId !== jobId) return;

        if (ev.data.progress !== undefined && !ev.data.treeWire && !ev.data.error) {
          onProgress?.(ev.data.progress);
          return;
        }

        this.worker = null;
        this.pendingReject = null;

        if (ev.data.error || !ev.data.treeWire) {
          reject(new Error(ev.data.error ?? "HDBSCAN worker returned no tree"));
          return;
        }

        try {
          resolve({ tree: rebuildHdbscanTree(ev.data.treeWire) });
        } catch (e) {
          reject(e);
        }
      };

      worker.onerror = (e) => {
        this.worker = null;
        this.pendingReject = null;
        reject(e);
      };

      const request: HdbscanWorkerRequest = { jobId, coords, options };
      worker.postMessage(request);
    });
  }
}

/** Module-level singleton — one proxy for the entire application. */
export const hdbscanWorkerProxy = new HdbscanWorkerProxy();
