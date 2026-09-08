// packages/app/src/workers/fieldDistance.worker.ts
//
// One-shot client distance-field compute (issue #315 field parity). On
// provider-less builds the selection commit produces `residentField.recordDist`
// here instead of receiving it from the server: rasterize → exact EDT from the
// seed cells → bilinear per-point sample (all in fieldDistanceCore — this file
// only marshals). One message in (coords + seeds as transferred copies), one
// message out (the Float32Array distances, transferred); the caller terminates
// the worker after the response.

import { computeRecordDistances } from "../doiPropagation/fieldDistanceCore";

export interface FieldDistanceWorkerRequest {
  x: Float64Array;
  y: Float64Array;
  seedIdx: Int32Array;
  gridResolution: number;
}

export type FieldDistanceWorkerResponse =
  | { ok: true; recordDist: Float32Array }
  | { ok: false; error: string };

self.onmessage = (ev: MessageEvent<FieldDistanceWorkerRequest>) => {
  try {
    const { x, y, seedIdx, gridResolution } = ev.data;
    const { recordDist } = computeRecordDistances({ x, y, seedIdx, gridResolution });
    const response: FieldDistanceWorkerResponse = { ok: true, recordDist };
    (self as unknown as Worker).postMessage(response, [recordDist.buffer]);
  } catch (error) {
    const response: FieldDistanceWorkerResponse = { ok: false, error: String(error) };
    (self as unknown as Worker).postMessage(response);
  }
};
