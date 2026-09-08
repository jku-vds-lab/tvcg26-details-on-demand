/**
 * IN-DRAG TRUTH LANE invariants (issue #315, CS 2026-07-26).
 *
 * The lane exists to shrink the proximity-slider RELEASE STEP: it periodically
 * re-freezes the drag preview on the TRUE field at the value being held, so the
 * commit has only the last update's drift left to paint. Everything that could
 * make that helpful mechanism harmful is a hard invariant, pinned here:
 *
 *   1. AT MOST ONE request in flight, ever — a slider fires 100+ events/s and an
 *      unbounded lane would queue a hundred O(n) worker jobs per drag.
 *   2. LAST VALUE WINS — the follow-up dispatched on completion is for the NEWEST
 *      value seen, never for an intermediate one the user has left behind.
 *   3. A STALE RESPONSE CANNOT OVERWRITE A NEWER APPLIED ONE — out-of-order
 *      arrivals (or arrivals after a reset / dataset swap) must not paint.
 *   4. THE GATE IS ADAPTIVE, NOT PER-DATASET — a measured round-trip above the
 *      threshold disarms the lane and the drag stays pure-preview.
 */

import { describe, expect, it } from "@jest/globals";
import {
  TRUTH_LANE_MAX_ROUNDTRIP_MS,
  TRUTH_LANE_MIN_INTERVAL_MS,
  truthLaneArmed,
  truthLaneComplete,
  truthLaneInitial,
  truthLaneObserve,
  truthLaneRequest,
  truthLaneReset,
  type TruthLaneState,
} from "./inDragTruth";

/** Fast round-trip: keeps the gate open across a whole scenario. */
const FAST = 20;
const SLOW = TRUTH_LANE_MAX_ROUNDTRIP_MS + 200;
/** A clock step guaranteed to clear the minimum interval. */
const STEP = TRUTH_LANE_MIN_INTERVAL_MS + 1;

describe("invariant 1+2: single flight, last value wins", () => {
  it("dispatches once for 10 rapid ticks and then once more, for the LAST value", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    const dispatched: number[] = [];
    // Ten pointermove ticks inside one animation frame (same timestamp).
    const values = [0.60, 0.57, 0.54, 0.51, 0.48, 0.45, 0.42, 0.39, 0.36, 0.33];
    for (const v of values) {
      const d = truthLaneRequest(state, v, 1000);
      state = d.state;
      if (d.dispatch) dispatched.push(d.dispatch.value);
      // The whole point: never more than one outstanding request.
      expect(state.inFlight === null ? 0 : 1).toBeLessThanOrEqual(1);
    }
    expect(dispatched).toEqual([0.6]); // only the first went out
    expect(state.pending).toBe(0.33); // the newest is the only one remembered

    // The completion drains exactly ONE follow-up, for the newest value.
    const done = truthLaneComplete(state, 1, 1000 + STEP, FAST);
    state = done.state;
    expect(done.apply).toBe(true);
    expect(done.dispatch?.value).toBe(0.33);
    expect(state.pending).toBeNull();
    expect(state.inFlight?.seq).toBe(2);
  });

  it("never issues a second request while one is outstanding", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    let now = 0;
    const first = truthLaneRequest(state, 0.5, now);
    state = first.state;
    expect(first.dispatch).not.toBeNull();
    for (let i = 0; i < 20; i++) {
      now += 1000; // even with plenty of time elapsed
      const d = truthLaneRequest(state, 0.5 - i * 0.01, now);
      state = d.state;
      expect(d.dispatch).toBeNull();
      expect(state.inFlight?.seq).toBe(1);
    }
  });

  it("throttles to the minimum interval when the round-trip is ~free", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), 0);
    const a = truthLaneRequest(state, 0.5, 0);
    state = a.state;
    expect(a.dispatch).not.toBeNull();
    // Instant completion, then a tick right away: too early to re-dispatch.
    const done = truthLaneComplete(state, 1, 1, 0);
    state = done.state;
    expect(done.dispatch).toBeNull();
    const early = truthLaneRequest(state, 0.49, 2);
    state = early.state;
    expect(early.dispatch).toBeNull();
    // Past the interval, it goes out.
    const late = truthLaneRequest(state, 0.48, STEP);
    expect(late.dispatch?.value).toBe(0.48);
  });
});

describe("invariant 3: stale responses are discarded", () => {
  it("rejects a response whose seq is not the one in flight", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    state = truthLaneRequest(state, 0.5, 0).state; // seq 1
    const late = truthLaneComplete(state, 99, 10, FAST);
    expect(late.apply).toBe(false);
    // The genuine in-flight request is untouched and can still land.
    expect(late.state.inFlight?.seq).toBe(1);
    expect(truthLaneComplete(late.state, 1, 10, FAST).apply).toBe(true);
  });

  it("cannot overwrite a newer applied response with an older one", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    state = truthLaneRequest(state, 0.6, 0).state; // seq 1
    state = truthLaneRequest(state, 0.3, 0).state; // pending 0.3
    const first = truthLaneComplete(state, 1, STEP, FAST); // applies, dispatches seq 2
    state = first.state;
    expect(first.dispatch?.seq).toBe(2);
    const second = truthLaneComplete(state, 2, 2 * STEP, FAST); // applies (newer)
    state = second.state;
    expect(second.apply).toBe(true);
    expect(state.appliedSeq).toBe(2);
    // seq 1 arriving late (a slow transfer, a re-delivered message) must not paint.
    expect(truthLaneComplete(state, 1, 3 * STEP, FAST).apply).toBe(false);
  });

  it("invalidates every outstanding seq on reset (release / dataset swap)", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    const sent = truthLaneRequest(state, 0.4, 0);
    state = truthLaneReset(sent.state);
    expect(state.inFlight).toBeNull();
    expect(state.pending).toBeNull();
    expect(truthLaneComplete(state, sent.dispatch!.seq, 10, FAST).apply).toBe(false);
    // A NEW request after the reset gets a fresh seq and does apply.
    const again = truthLaneRequest(state, 0.4, STEP);
    expect(again.dispatch!.seq).toBeGreaterThan(sent.dispatch!.seq);
    expect(truthLaneComplete(again.state, again.dispatch!.seq, 2 * STEP, FAST).apply).toBe(true);
  });

  it("keeps the measured round-trip across a reset (it describes the dataset)", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), 123);
    state = truthLaneReset(state);
    expect(state.roundTripMs).toBe(123);
  });
});

describe("invariant 4: the gate is adaptive", () => {
  it("is armed with no samples so the first drag probes once", () => {
    const state = truthLaneInitial<number>();
    expect(state.roundTripMs).toBeNull();
    expect(truthLaneArmed(state)).toBe(true);
    expect(truthLaneRequest(state, 0.5, 0).dispatch).not.toBeNull();
  });

  it("disarms after a slow round-trip and issues nothing more", () => {
    let state: TruthLaneState<number> = truthLaneInitial<number>();
    const probe = truthLaneRequest(state, 0.5, 0);
    state = probe.state;
    const done = truthLaneComplete(state, probe.dispatch!.seq, STEP, SLOW);
    state = done.state;
    expect(done.apply).toBe(true); // the probe itself still lands
    expect(truthLaneArmed(state)).toBe(false);
    // And nothing further goes out, however long the drag continues.
    for (let i = 1; i <= 10; i++) {
      const d = truthLaneRequest(state, 0.5 - i * 0.02, i * STEP);
      state = d.state;
      expect(d.dispatch).toBeNull();
      expect(state.pending).toBeNull(); // not even remembered
    }
  });

  it("re-arms once the measured round-trip comes back down (EWMA, not a latch)", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), SLOW);
    expect(truthLaneArmed(state)).toBe(false);
    for (let i = 0; i < 6; i++) state = truthLaneObserve(state, FAST);
    expect(state.roundTripMs).toBeLessThan(TRUTH_LANE_MAX_ROUNDTRIP_MS);
    expect(truthLaneArmed(state)).toBe(true);
  });

  it("does not dispatch a follow-up that the newest sample just disarmed", () => {
    let state: TruthLaneState<number> = truthLaneObserve(truthLaneInitial<number>(), FAST);
    state = truthLaneRequest(state, 0.6, 0).state;
    state = truthLaneRequest(state, 0.3, 0).state; // pending
    const done = truthLaneComplete(state, 1, STEP, SLOW * 4); // this one was slow
    expect(done.apply).toBe(true);
    expect(done.dispatch).toBeNull();
    expect(truthLaneArmed(done.state)).toBe(false);
  });

  it("ignores a NaN round-trip sample instead of poisoning the gate", () => {
    const state = truthLaneObserve(truthLaneInitial<number>(), Number.NaN);
    expect(state.roundTripMs).toBeNull();
    expect(state.samples).toBe(0);
  });
});
