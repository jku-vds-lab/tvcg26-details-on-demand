// packages/app/src/workers/fieldPreview.worker.ts
//
// Off-main-thread field drag-preview compute (issue #315; CONVERGED since
// the CS 14.08 preview correction). The full converged tick — falloff +
// seed clamp + chain ↔ re-spread alternation to the fixed point — runs
// here so the main thread does upload-only during proximity/past/future
// drags and the slider thumb NEVER blocks on the compute.
//
// Protocol:
//   init  { recordDist, predIndex, succIndex, seedIdx, x, y }  — seeded once
//         per field commit; the buffers arrive as transferred COPIES and stay
//         resident in the worker. `x`/`y` are the point coords: the re-spread
//         raster is built lazily from them on the first tick whose chain
//         raises anything (chain-inert datasets never pay it), then cached.
//   tick  { tickId, shape, prox, past, future, maxEmb, out?, freeze? } — `out`
//         is the previous result buffer transferred back for ping-pong reuse
//         (absent on the first tick). The worker computes the CONVERGED field
//         into it (computeConvergedPreview — the same executor the commit and
//         the sync fallback run, so worker previews are value-identical to
//         both) and transfers the result back with the same tickId. Pins /
//         labeled exclusion are NOT carried (they can change without a field
//         revision bump — those drags stay on the synchronous lane, see
//         fieldPreviewExclusionsActive). With `freeze` the worker instead runs
//         `computeFrozenChain` (round-0 semantics — the parked shader lane's
//         in-drag truth path, unreachable in production since the correction).
//
// All compute lives in pure modules; this file only marshals.

import {
  computeConvergedPreview,
  type ConvergedScratch,
} from "../doiPropagation/convergedField";
import {
  rasterize,
  FIELD_GRID_RESOLUTION,
  type FieldRaster,
} from "../doiPropagation/fieldDistanceCore";
import {
  computeFrozenChain,
  type FieldPreviewShape,
} from "../doiPropagation/fieldPreviewCore";

interface InitMsg {
  type: "init";
  recordDist: Float32Array;
  predIndex: Int32Array;
  succIndex: Int32Array;
  seedIdx: Int32Array;
  x: Float64Array;
  y: Float64Array;
}

interface TickMsg {
  type: "tick";
  tickId: number;
  shape: FieldPreviewShape;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
  out?: Float32Array;
  /** Also freeze the chain at these params (in-drag truth lane). */
  freeze?: boolean;
}

export type FieldPreviewWorkerRequest = InitMsg | TickMsg;

export type FieldPreviewWorkerResponse = {
  type: "result";
  tickId: number;
  out: Float32Array;
  /** Present iff the tick asked to `freeze`: the re-anchoring layers for the
   * renderer's frozen-chain texture, valid at the tick's own `prox`. */
  frozen?: {
    srcDist: Float32Array;
    gain: Float32Array;
    seedChain: Float32Array;
  };
};

interface ResidentState {
  recordDist: Float32Array;
  predIndex: Int32Array;
  succIndex: Int32Array;
  seedIdx: Int32Array;
  x: Float64Array;
  y: Float64Array;
  /** Lazy re-spread raster (built on the first chain-raising tick). */
  raster: FieldRaster | null;
}

let state: ResidentState | null = null;
/** Round/grid buffers reused across ticks (see ConvergedScratch). */
const scratch: ConvergedScratch = {};

self.onmessage = (ev: MessageEvent<FieldPreviewWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    state = {
      recordDist: msg.recordDist,
      predIndex: msg.predIndex,
      succIndex: msg.succIndex,
      seedIdx: msg.seedIdx,
      x: msg.x,
      y: msg.y,
      raster: null,
    };
    scratch.before = undefined;
    scratch.grid = undefined;
    return;
  }

  // tick — drop if a tick somehow arrives before init (no state to compute on).
  const s = state;
  if (!s) return;
  const n = s.recordDist.length;
  const input = {
    recordDist: s.recordDist,
    predIndex: s.predIndex,
    succIndex: s.succIndex,
    seedIdx: s.seedIdx,
    shape: msg.shape,
    prox: msg.prox,
    past: msg.past,
    future: msg.future,
    maxEmb: msg.maxEmb,
  };
  if (msg.freeze) {
    // ONE pass yields both products: `values` is bit-identical to
    // computeFieldPreview (the release commit's field) and the three layers
    // re-anchor the shader preview at this prox.
    const { srcDist, gain, seedChain, values } = computeFrozenChain(input);
    const frozenResponse: FieldPreviewWorkerResponse = {
      type: "result",
      tickId: msg.tickId,
      out: values,
      frozen: { srcDist, gain, seedChain },
    };
    (self as unknown as Worker).postMessage(frozenResponse, [
      values.buffer,
      srcDist.buffer,
      gain.buffer,
      seedChain.buffer,
    ]);
    return;
  }
  const out = msg.out && msg.out.length === n ? msg.out : undefined;
  const result = computeConvergedPreview(
    {
      recordDist: s.recordDist,
      predIndex: s.predIndex,
      succIndex: s.succIndex,
      seedIdx: s.seedIdx,
      getRaster: () => {
        if (!s.raster) s.raster = rasterize(s.x, s.y, FIELD_GRID_RESOLUTION);
        return s.raster;
      },
      shape: msg.shape,
      prox: msg.prox,
      past: msg.past,
      future: msg.future,
      maxEmb: msg.maxEmb,
    },
    out,
    scratch
  );
  const response: FieldPreviewWorkerResponse = {
    type: "result",
    tickId: msg.tickId,
    out: result,
  };
  (self as unknown as Worker).postMessage(response, [result.buffer]);
};
