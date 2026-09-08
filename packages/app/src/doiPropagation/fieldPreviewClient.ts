// packages/app/src/doiPropagation/fieldPreviewClient.ts
//
// Main-thread driver for the field drag-preview worker (issue #315). Owns the
// worker handle, the per-commit init, latest-wins scheduling, and the
// ping-pong output buffer. The hook calls `tick(init, params)` on every slider
// move and gets results via the `onResult` callback.
//
// This module statically imports the worker factory (which uses
// `import.meta.url`), so — like propagateDoiWorker.ts — it must only ever be
// LAZILY imported (`await import(...)`), never parsed by ts-jest.

import { makeFieldPreviewWorker } from "../workers/workerFactories";
import {
  latestWinsInitial,
  latestWinsRequest,
  latestWinsComplete,
  type FieldPreviewShape,
  type FrozenChainLayers,
  type LatestWinsState,
} from "./fieldPreviewCore";
import type { FieldPreviewWorkerResponse } from "../workers/fieldPreview.worker";

/** Buffers seeding the worker (copied + transferred once per field commit).
 * `revision`+`length` are the init identity: a change triggers re-init. */
export interface FieldPreviewInitData {
  revision: number;
  length: number;
  recordDist: Float32Array;
  predIndex: Int32Array;
  succIndex: Int32Array;
  seedIdx: Int32Array;
  /** Point coords for the worker's lazy re-spread raster (converged
   * previews). A THUNK so the O(n) snapshot copy runs only on an actual
   * re-init, never on the per-tick calls that hit the identity check; the
   * returned arrays are fresh copies and are transferred outright. */
  coords: () => { x: Float64Array; y: Float64Array };
}

export interface FieldPreviewTickParams {
  shape: FieldPreviewShape;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
  /** Ask the worker to RE-FREEZE the chain at these params and return its
   * layers alongside the field (in-drag truth lane, doiPropagation/inDragTruth).
   * A freeze allocates fresh buffers, so it never consumes the ping-pong spare. */
  freeze?: boolean;
}

/** Everything the result carries besides the field itself. */
export interface FieldPreviewResultMeta {
  /** Echo of the worker tick id — the caller's staleness token. */
  tickId: number;
  /** Present iff the tick asked to freeze. */
  frozen?: FrozenChainLayers;
  /** Measured post-to-receive round-trip (ms) — the in-drag lane's adaptive
   * gate input. Includes worker compute + both transfers, i.e. everything but
   * the caller's own upload. */
  elapsedMs: number;
  /** The params the result was computed AT (client-side echo — the send's
   * params, keyed back by tickId). The GPU motion lane's truth blend uses it
   * to apply an exact field only while the thumb still holds those values. */
  params: FieldPreviewTickParams;
}

export class FieldPreviewClient {
  private worker: Worker | null = null;
  private revision = -1;
  private length = 0;
  private tickCounter = 0;
  private inFlightId = 0;
  private latest: LatestWinsState<FieldPreviewTickParams> = latestWinsInitial();
  /** The last result buffer, returned from the worker and free to reuse: the
   * renderer's setOpacityField copies it synchronously into its texture
   * scratch (OpacityFieldSystem.uploadOpacityTexture → texScratch.set), so
   * handing this same buffer back to the worker on the next tick cannot race
   * the upload — ping-pong allocates nothing after the first tick. */
  private spare: Float32Array | null = null;
  /** performance.now() at the last send — the round-trip the lane's gate reads. */
  private sentAtMs = 0;
  /** Params of the in-flight tick (echoed back in the result meta). */
  private inFlightParams: FieldPreviewTickParams | null = null;

  constructor(
    private onResult: (out: Float32Array, meta: FieldPreviewResultMeta) => void
  ) {}

  /**
   * Schedule a preview tick. (Re-)inits the worker when the field revision or
   * length changed. Returns false if the worker could not be created — the
   * caller then permanently falls back to the synchronous path.
   */
  tick(init: FieldPreviewInitData, params: FieldPreviewTickParams): boolean {
    if (!this.ensureWorker(init)) return false;
    const decision = latestWinsRequest(this.latest, params);
    this.latest = decision.state;
    if (decision.send) this.send(decision.send);
    return true;
  }

  /**
   * IN-DRAG TRUTH dispatch: send a freeze tick IMMEDIATELY and hand back its
   * tick id so the caller can reject stale responses itself. Returns null when
   * the worker is unavailable or a tick is already outstanding — the lane owns
   * the single-flight rule and must not have its bookkeeping coalesced away by
   * the latest-wins queue underneath it.
   */
  freezeTick(
    init: FieldPreviewInitData,
    params: FieldPreviewTickParams
  ): number | null {
    if (!this.ensureWorker(init)) return null;
    if (this.latest.inFlight) return null;
    const decision = latestWinsRequest(this.latest, { ...params, freeze: true });
    this.latest = decision.state;
    if (!decision.send) return null;
    this.send(decision.send);
    return this.inFlightId;
  }

  /** Terminate the worker and clear all in-flight/ping-pong state. Idempotent;
   * the client stays reusable — the next tick recreates the worker. */
  reset(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.revision = -1;
    this.length = 0;
    this.latest = latestWinsInitial();
    this.spare = null;
    this.inFlightId = 0;
    this.inFlightParams = null;
  }

  private ensureWorker(init: FieldPreviewInitData): boolean {
    if (
      this.worker &&
      this.revision === init.revision &&
      this.length === init.length
    ) {
      return true;
    }
    // Revision/length changed (new commit) — start fresh so no stale in-flight
    // tick or ping-pong buffer from the previous field leaks through.
    this.reset();
    try {
      this.worker = makeFieldPreviewWorker();
    } catch {
      this.worker = null;
      return false;
    }
    this.worker.onmessage = (e: MessageEvent<FieldPreviewWorkerResponse>) =>
      this.onMessage(e.data);
    this.worker.onerror = () => this.reset();
    this.revision = init.revision;
    this.length = init.length;
    // Transfer COPIES: recordDist/pred/succ are shared (resident field +
    // per-dataset precomputation cache) and must survive the neutering.
    // `coords()` already returns fresh copies — transferred as-is.
    const recordDist = new Float32Array(init.recordDist);
    const predIndex = new Int32Array(init.predIndex);
    const succIndex = new Int32Array(init.succIndex);
    const seedIdx = new Int32Array(init.seedIdx);
    const { x, y } = init.coords();
    this.worker.postMessage(
      { type: "init", recordDist, predIndex, succIndex, seedIdx, x, y },
      [recordDist.buffer, predIndex.buffer, succIndex.buffer, seedIdx.buffer, x.buffer, y.buffer]
    );
    return true;
  }

  private send(params: FieldPreviewTickParams): void {
    const worker = this.worker;
    if (!worker) return;
    const tickId = ++this.tickCounter;
    this.inFlightId = tickId;
    this.sentAtMs = performance.now();
    this.inFlightParams = params;
    // A freeze allocates its own output, so keep the ping-pong spare here
    // instead of transferring (and losing) it.
    const out = params.freeze ? null : this.spare;
    if (out) this.spare = null; // transferred away below
    worker.postMessage(
      { type: "tick", tickId, ...params, out: out ?? undefined },
      out ? [out.buffer] : []
    );
  }

  private onMessage(msg: FieldPreviewWorkerResponse): void {
    if (msg.type !== "result") return;
    const fresh =
      msg.tickId === this.inFlightId &&
      msg.out.length === this.length &&
      this.inFlightParams !== null;
    if (fresh) {
      this.onResult(msg.out, {
        tickId: msg.tickId,
        frozen: msg.frozen,
        elapsedMs: performance.now() - this.sentAtMs,
        params: this.inFlightParams!,
      });
      this.spare = msg.out; // safe to reuse — setOpacityField already copied it
    }
    // else: stale tickId or wrong length — drop (do not paint, do not reuse).
    const decision = latestWinsComplete(this.latest);
    this.latest = decision.state;
    if (decision.send) this.send(decision.send);
  }
}
