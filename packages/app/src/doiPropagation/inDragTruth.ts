// packages/app/src/doiPropagation/inDragTruth.ts
//
// IN-DRAG TRUTH LANE (issue #315, CS 2026-07-26): the scheduler that kills the
// step at proximity-slider release.
//
// WHY A LANE AT ALL
// -----------------
// The GPU drag preview remaps a chain FROZEN at the value the drag started from
// (`fieldPreviewCore.computeFrozenChain`), so it drifts away from the exact
// field as the thumb travels — and the release commit paints the exact field in
// one frame. That drift IS the release step. Measured on a 10k synthetic
// (200 trajectories, log shape, freeze p = 0.6, past = future = 0.75,
// bench/prox-release-jump.py): mean |Δ| 0.0017–0.0024, max 0.23, and 97–158 of
// 10 000 points (1.0–1.6 %) crossing the gray-out threshold — a visible pop on
// a long drag, exactly 0 if the freeze is refreshed at the value being held.
//
// So the lane periodically asks for the TRUE field at the value currently held
// and applies it live: the frozen chain is RE-FROZEN there (which makes the
// shader preview exact at that value again, contract 1 of
// fieldPreview.contract.test.ts) and the exact field goes into the opacity
// texture. The shader keeps rendering between arrivals, so the picture never
// stalls; by release there is only the LAST arrival's drift left to jump.
//
// WHY THE TRUTH SOURCE IS THE PREVIEW WORKER, NOT THE SERVER
// ----------------------------------------------------------
// The release commit does NOT paint server truth. A shape-3 field commit ships
// no distances (`nLeaves = 0`, "keep what you have") and the client re-derives
// the field locally with `applyResidentFieldLocally` = f(D) + seed clamp +
// chain — the very function `computeFieldPreview` is the typed-array twin of.
// Server truth reaches `doiMass` / `visibleRanges` (hence clusters and insets)
// and NOTHING on the opacity texture. Measured (same bench) the two differ by
// mean ≤ 0.001 / max 0.14 on the log shape and by EXACTLY 0 on exp, because the
// server's proximity↔topology re-spread is a no-op once the traversable mask has
// no barriers — which is the production case (`maxEmbeddingDistance` is the
// projection diameter, so the maxEmb/2 dilation covers the whole grid).
// Applying server truth mid-drag would therefore ADD a step at release rather
// than remove one, unless the commit adopted it too. The worker is the source
// that makes the release step provably ZERO.
//
// INVARIANTS (asserted in inDragTruth.test.ts)
// -------------------------------------------
//  - AT MOST ONE request in flight, ever. A tick arriving while one is in
//    flight overwrites a single `pending` slot; the completion dispatches at
//    most one follow-up, for the NEWEST value.
//  - STALE RESPONSES ARE DISCARDED. Every dispatch carries a monotonic seq; a
//    completion whose seq is not the in-flight one (or is not newer than the
//    last applied) never applies. `truthLaneReset` bumps the seq counter so a
//    response outliving a dataset swap / commit cannot land either.
//  - ADAPTIVE GATE, NOT DATASET GATE. The gate is an EWMA of the MEASURED
//    round-trip of the lane's own requests (worker compute + transfer + the
//    freeze upload). Above `TRUTH_LANE_MAX_ROUNDTRIP_MS` the lane disarms and
//    the drag stays pure-preview (the pre-lane behaviour). With no sample yet
//    the lane is armed so the first drag PROBES once and earns its sample.
//  - CADENCE IS SELF-LIMITING. Single-flight already caps the lane at one
//    update per round-trip; `TRUTH_LANE_MIN_INTERVAL_MS` additionally keeps a
//    tiny dataset (round-trip ≈ 0) from flooding the worker every pointermove.

/** Above this measured round-trip the lane disarms: correcting the picture would
 * cost more than the drift it removes (CS: 400–500 ms). */
export const TRUTH_LANE_MAX_ROUNDTRIP_MS = 450;

/** Floor on the gap between two dispatches — same 90 ms the throttled field
 * remap uses, so a chess-scale dataset updates ~11×/s instead of per event. */
export const TRUTH_LANE_MIN_INTERVAL_MS = 90;

/** EWMA weight on the newest round-trip sample. High enough that a dataset swap
 * or a selection growth is reflected within a couple of updates. */
export const TRUTH_LANE_EWMA_ALPHA = 0.4;

export interface TruthLaneDispatch<V> {
  seq: number;
  value: V;
}

export interface TruthLaneState<V> {
  /** The single outstanding request, or null when idle. */
  inFlight: TruthLaneDispatch<V> | null;
  /** Newest value seen while a request was in flight (older ones are dropped). */
  pending: V | null;
  /** Monotonic dispatch counter; also the staleness token. */
  nextSeq: number;
  /** Highest seq whose response was applied. */
  appliedSeq: number;
  /** EWMA of measured round-trips (ms); null until the first sample. */
  roundTripMs: number | null;
  samples: number;
  /** Timestamp of the last dispatch (ms, performance.now domain). */
  lastDispatchMs: number;
}

export function truthLaneInitial<V>(): TruthLaneState<V> {
  return {
    inFlight: null,
    pending: null,
    nextSeq: 1,
    appliedSeq: 0,
    roundTripMs: null,
    samples: 0,
    lastDispatchMs: Number.NEGATIVE_INFINITY,
  };
}

/** Armed = allowed to issue requests. Unsampled ⇒ armed (probe once). */
export function truthLaneArmed<V>(state: TruthLaneState<V>): boolean {
  return state.roundTripMs === null || state.roundTripMs <= TRUTH_LANE_MAX_ROUNDTRIP_MS;
}

/** Fold a round-trip sample into the EWMA without touching the flight state —
 * used both by `truthLaneComplete` and by any external measurement of the same
 * work (e.g. the main-thread freeze the first drag tick pays anyway). */
export function truthLaneObserve<V>(
  state: TruthLaneState<V>,
  roundTripMs: number
): TruthLaneState<V> {
  if (!(roundTripMs >= 0)) return state; // NaN-safe
  const prev = state.roundTripMs;
  return {
    ...state,
    roundTripMs:
      prev === null
        ? roundTripMs
        : prev + TRUTH_LANE_EWMA_ALPHA * (roundTripMs - prev),
    samples: state.samples + 1,
  };
}

/**
 * A drag tick at `value`. Dispatches immediately when the lane is armed, idle
 * and past its minimum interval; otherwise records `value` as the pending
 * latest (overwriting any older one). Returns the dispatch to send, if any.
 */
export function truthLaneRequest<V>(
  state: TruthLaneState<V>,
  value: V,
  nowMs: number
): { state: TruthLaneState<V>; dispatch: TruthLaneDispatch<V> | null } {
  if (!truthLaneArmed(state)) {
    // Disarmed: do not even remember the tick — re-arming must not fire a
    // request for a slider value the user has long left behind.
    return { state: { ...state, pending: null }, dispatch: null };
  }
  if (state.inFlight !== null) {
    return { state: { ...state, pending: value }, dispatch: null };
  }
  if (nowMs - state.lastDispatchMs < TRUTH_LANE_MIN_INTERVAL_MS) {
    return { state: { ...state, pending: value }, dispatch: null };
  }
  const dispatch: TruthLaneDispatch<V> = { seq: state.nextSeq, value };
  return {
    state: {
      ...state,
      inFlight: dispatch,
      pending: null,
      nextSeq: state.nextSeq + 1,
      lastDispatchMs: nowMs,
    },
    dispatch,
  };
}

/**
 * A response for `seq` arrived after `roundTripMs`. `apply` is false for a
 * stale response (superseded seq, or one from before a reset) — the caller must
 * NOT paint it. A pending latest is drained as the single follow-up dispatch,
 * subject to the minimum interval (a too-early follow-up stays pending and the
 * next drag tick releases it).
 */
export function truthLaneComplete<V>(
  state: TruthLaneState<V>,
  seq: number,
  nowMs: number,
  roundTripMs: number
): {
  state: TruthLaneState<V>;
  apply: boolean;
  dispatch: TruthLaneDispatch<V> | null;
} {
  const fresh = state.inFlight !== null && state.inFlight.seq === seq && seq > state.appliedSeq;
  if (!fresh) {
    // Not ours (reset, or already superseded): leave the flight state alone so
    // a genuinely in-flight request can still land.
    return { state, apply: false, dispatch: null };
  }
  let next: TruthLaneState<V> = truthLaneObserve(
    { ...state, inFlight: null, appliedSeq: seq },
    roundTripMs
  );
  if (next.pending === null || !truthLaneArmed(next)) {
    return { state: { ...next, pending: null }, apply: true, dispatch: null };
  }
  if (nowMs - next.lastDispatchMs < TRUTH_LANE_MIN_INTERVAL_MS) {
    return { state: next, apply: true, dispatch: null };
  }
  const dispatch: TruthLaneDispatch<V> = { seq: next.nextSeq, value: next.pending };
  next = {
    ...next,
    inFlight: dispatch,
    pending: null,
    nextSeq: next.nextSeq + 1,
    lastDispatchMs: nowMs,
  };
  return { state: next, apply: true, dispatch };
}

/**
 * Abandon the lane (release, dataset swap, chain-slider move): no request is in
 * flight afterwards and every outstanding response is stale. The measured
 * round-trip is KEPT — it is a property of the dataset + selection, not of one
 * drag, and re-earning it every drag would re-pay the probe each time.
 */
export function truthLaneReset<V>(state: TruthLaneState<V>): TruthLaneState<V> {
  return {
    ...state,
    inFlight: null,
    pending: null,
    // Nothing dispatched before the reset may apply afterwards.
    appliedSeq: state.nextSeq - 1,
    lastDispatchMs: Number.NEGATIVE_INFINITY,
  };
}
