// Shared payload codec for the metrics worker (issue #315 R1a, census A5):
// on a column-backed canonical array the main thread ships COPIES of the
// x/y columns (transferable buffers, ~16 MB at 1M) instead of materializing
// 1M {x,y} objects and structured-cloning them; the worker rebuilds its
// point view off-thread. Same doubles either way, so the computed defaults
// are bit-identical. Must stay rbush/DOM-free (worker + jest graphs).

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";

export type MetricsPt = { x: number; y: number };
export type MetricsPayload = MetricsPt[] | { x: Float64Array; y: Float64Array };

/** Payload + transfer list for the metrics worker postMessage. */
export function buildMetricsPayload(points: DataPoint[]): {
  payload: MetricsPayload;
  transfer: Transferable[];
} {
  const cols = columnsOf(points);
  if (cols) {
    // Copies, not the live views — transferring the canonical column
    // buffers would detach them under the whole app.
    const x = cols.x.slice();
    const y = cols.y.slice();
    return { payload: { x, y }, transfer: [x.buffer, y.buffer] };
  }
  return { payload: points.map((p) => ({ x: p.x, y: p.y })), transfer: [] };
}

/** Worker-side decode: either shape yields the same point view. */
export function payloadToPoints(payload: MetricsPayload): MetricsPt[] {
  if (Array.isArray(payload)) return payload;
  const { x, y } = payload;
  const n = Math.min(x.length, y.length);
  const pts: MetricsPt[] = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { x: x[i], y: y[i] };
  return pts;
}
