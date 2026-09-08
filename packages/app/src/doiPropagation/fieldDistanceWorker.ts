// packages/app/src/doiPropagation/fieldDistanceWorker.ts
//
// Async main-thread API for the one-shot distance-field worker (issue #315
// field parity). Spins the worker up, transfers the coord/seed copies,
// resolves with the record-order Float32Array distances, terminates.
// Aborting the signal terminates the worker and rejects with an AbortError —
// same contract as propagateDoiWorker. Imported ONLY lazily (the factory
// module uses `import.meta`, which ts-jest cannot parse; callers hold a
// `runner?` seam — the commitPropagation.ts precedent).

import { makeFieldDistanceWorker } from "../workers/workerFactories";
import type {
  FieldDistanceWorkerRequest,
  FieldDistanceWorkerResponse,
} from "../workers/fieldDistance.worker";

export type { FieldDistanceWorkerRequest } from "../workers/fieldDistance.worker";

/**
 * Compute record-order seed distances in a worker. The input buffers are
 * transferred (neutered) into the worker — pass copies, never the live
 * column arrays.
 */
export function computeRecordDistancesInWorker(
  input: FieldDistanceWorkerRequest,
  opts?: { signal?: AbortSignal }
): Promise<Float32Array> {
  const signal = opts?.signal;
  return new Promise<Float32Array>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Field distance aborted", "AbortError"));
      return;
    }
    const w = makeFieldDistanceWorker();
    const finish = (fn: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      w.terminate();
      fn();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException("Field distance aborted", "AbortError")));
    signal?.addEventListener("abort", onAbort);

    w.onmessage = (e: MessageEvent<FieldDistanceWorkerResponse>) => {
      const msg = e.data;
      if (msg.ok) {
        finish(() => resolve(msg.recordDist));
      } else {
        finish(() => reject(new Error(msg.error || "Field distance worker failed")));
      }
    };
    w.onerror = (err) => finish(() => reject(err));

    w.postMessage(input, [input.x.buffer, input.y.buffer, input.seedIdx.buffer]);
  });
}
