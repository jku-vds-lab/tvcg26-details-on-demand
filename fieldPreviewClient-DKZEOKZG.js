import { l, a as o, b as u, c as d } from "./index-CfOxEoWC.js";
class k {
  constructor(t) {
    this.onResult = t, this.worker = null, this.revision = -1, this.length = 0, this.tickCounter = 0, this.inFlightId = 0, this.latest = l(), this.spare = null, this.sentAtMs = 0, this.inFlightParams = null;
  }
  /**
   * Schedule a preview tick. (Re-)inits the worker when the field revision or
   * length changed. Returns false if the worker could not be created — the
   * caller then permanently falls back to the synchronous path.
   */
  tick(t, s) {
    if (!this.ensureWorker(t)) return !1;
    const e = o(this.latest, s);
    return this.latest = e.state, e.send && this.send(e.send), !0;
  }
  /**
   * IN-DRAG TRUTH dispatch: send a freeze tick IMMEDIATELY and hand back its
   * tick id so the caller can reject stale responses itself. Returns null when
   * the worker is unavailable or a tick is already outstanding — the lane owns
   * the single-flight rule and must not have its bookkeeping coalesced away by
   * the latest-wins queue underneath it.
   */
  freezeTick(t, s) {
    if (!this.ensureWorker(t) || this.latest.inFlight) return null;
    const e = o(this.latest, { ...s, freeze: !0 });
    return this.latest = e.state, e.send ? (this.send(e.send), this.inFlightId) : null;
  }
  /** Terminate the worker and clear all in-flight/ping-pong state. Idempotent;
   * the client stays reusable — the next tick recreates the worker. */
  reset() {
    this.worker && (this.worker.terminate(), this.worker = null), this.revision = -1, this.length = 0, this.latest = l(), this.spare = null, this.inFlightId = 0, this.inFlightParams = null;
  }
  ensureWorker(t) {
    if (this.worker && this.revision === t.revision && this.length === t.length)
      return !0;
    this.reset();
    try {
      this.worker = u();
    } catch {
      return this.worker = null, !1;
    }
    this.worker.onmessage = (a) => this.onMessage(a.data), this.worker.onerror = () => this.reset(), this.revision = t.revision, this.length = t.length;
    const s = new Float32Array(t.recordDist), e = new Int32Array(t.predIndex), r = new Int32Array(t.succIndex), i = new Int32Array(t.seedIdx), { x: n, y: h } = t.coords();
    return this.worker.postMessage(
      { type: "init", recordDist: s, predIndex: e, succIndex: r, seedIdx: i, x: n, y: h },
      [s.buffer, e.buffer, r.buffer, i.buffer, n.buffer, h.buffer]
    ), !0;
  }
  send(t) {
    const s = this.worker;
    if (!s) return;
    const e = ++this.tickCounter;
    this.inFlightId = e, this.sentAtMs = performance.now(), this.inFlightParams = t;
    const r = t.freeze ? null : this.spare;
    r && (this.spare = null), s.postMessage(
      { type: "tick", tickId: e, ...t, out: r ?? void 0 },
      r ? [r.buffer] : []
    );
  }
  onMessage(t) {
    if (t.type !== "result") return;
    t.tickId === this.inFlightId && t.out.length === this.length && this.inFlightParams !== null && (this.onResult(t.out, {
      tickId: t.tickId,
      frozen: t.frozen,
      elapsedMs: performance.now() - this.sentAtMs,
      params: this.inFlightParams
    }), this.spare = t.out);
    const e = d(this.latest);
    this.latest = e.state, e.send && this.send(e.send);
  }
}
export {
  k as FieldPreviewClient
};
