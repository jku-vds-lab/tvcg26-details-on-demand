// packages/app/src/workers/spline.worker.ts
//
// Derives trajectory spline geometry (issue #315): thin wrapper over the pure
// computeSplineColumns. Input point columns arrive with buffer transfer, the
// result columns go back the same way — both directions are memcpys, no
// structured clone of per-segment objects.

import {
  computeEdgeList,
  computeSplineColumns,
  SAMPLES_PER_EDGE,
  type SplineColumns,
} from "../dataPreprocessing/splineColumns";

export interface SplineWorkerRequest {
  x: ArrayBuffer;
  y: ArrayBuffer;
  line: ArrayBuffer;
  samplesPerEdge?: number;
  /** Skip the O(edges × samples) knot sampling and return edge enumeration
   * only (curveX/curveY empty) — the compact/instanced pipeline derives
   * geometry on demand (issue #315 phase B2). */
  edgesOnly?: boolean;
}

export type SplineWorkerResponse =
  | { ok: true; columns: SplineColumns }
  | { ok: false; error: string };

self.onmessage = (ev: MessageEvent<SplineWorkerRequest>) => {
  const post = (msg: SplineWorkerResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  try {
    const columns: SplineColumns = ev.data.edgesOnly
      ? {
          curveX: new Float64Array(0),
          curveY: new Float64Array(0),
          ...computeEdgeList(new Float64Array(ev.data.line)),
          samplesPerEdge: ev.data.samplesPerEdge ?? SAMPLES_PER_EDGE,
        }
      : computeSplineColumns(
          new Float64Array(ev.data.x),
          new Float64Array(ev.data.y),
          new Float64Array(ev.data.line),
          ev.data.samplesPerEdge
        );
    post({ ok: true, columns }, [
      columns.curveX.buffer,
      columns.curveY.buffer,
      columns.edgeStart.buffer,
      columns.edgeEnd.buffer,
    ]);
  } catch (e) {
    post({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
