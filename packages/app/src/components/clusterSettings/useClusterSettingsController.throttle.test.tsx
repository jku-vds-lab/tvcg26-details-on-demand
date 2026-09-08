/**
 * REGRESSION GUARD: hot slider handlers must use local state + throttled dispatch.
 *
 * Bug history: `handleMaxActiveChange` and `handleSplitThresholdChange` called
 * `store.dispatch` on every pointermove event.  Each dispatch synchronously flushed
 * Redux subscribers and React-Redux useSelector hooks, blocking the main thread before
 * the browser could repaint.  The slider thumb visibly lagged behind the pointer.
 *
 * Fix: local React state is updated on every event (smooth thumb); Redux dispatch
 * uses a leading+trailing throttle (100 ms window).  `onChangeCommitted` flushes the
 * exact final value on mouseup regardless of whether the trailing timer has fired.
 *
 * DoI threshold snapback bug: `handlePropagationSliderChange` only wrote thresholds
 * to local state, not Redux.  An App.tsx sync-effect then overwrote local state with
 * the stale Redux value whenever propagation sliders changed → threshold snapped back.
 * Fix: dispatch `updateSettings(thresholds)` to Redux inside the change handler.
 * See useDoIPropagation.ts for the relevant change.
 *
 * If ANY test in this file fails:
 *   ██████████████████████████████████████████████████████████████████████
 *   ██  CRITICAL: slider thumbs will lag/block the main thread, OR the   ██
 *   ██  DoI threshold will snap back when the propagation slider moves.  ██
 *   ██  Check useClusterSettingsController.ts and useDoIPropagation.ts.  ██
 *   ██████████████████████████████████████████████████████████████████████
 */

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import store, { updateClusterSettings } from 'src/store';
import { useClusterSettingsController } from './useClusterSettingsController';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(store, 'dispatch');
});

afterEach(() => {
  jest.runAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ─── maxActiveClusters ────────────────────────────────────────────────────

describe('REGRESSION GUARD — handleMaxActiveChange: local state + leading+trailing throttle', () => {
  it('localMaxActive updates immediately on every event (thumb must never lag)', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 3);
    });
    expect(result.current.localMaxActive).toBe(3);

    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 7);
    });
    expect(result.current.localMaxActive).toBe(7);
  });

  it('dispatch fires immediately on the first event (leading edge)', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 5);
    });
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith(updateClusterSettings({ maxActiveClusters: 5 }));
  });

  it('rapid events within 100ms do NOT dispatch more than once (no per-event blocking)', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      // Simulate 10 rapid pointermove events
      for (let i = 0; i < 10; i++) {
        result.current.handleMaxActiveChange(new Event('change'), i);
      }
    });
    // Only the leading-edge dispatch should have fired
    expect(store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('trailing edge dispatches the latest value after 100ms', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 2); // leading → dispatches 2
      result.current.handleMaxActiveChange(new Event('change'), 8); // batched
      result.current.handleMaxActiveChange(new Event('change'), 15); // batched — latest
    });
    expect(store.dispatch).toHaveBeenCalledTimes(1); // only leading so far

    act(() => { jest.advanceTimersByTime(100); });
    // Trailing edge must dispatch the last value (15)
    expect(store.dispatch).toHaveBeenCalledTimes(2);
    expect(store.dispatch).toHaveBeenLastCalledWith(updateClusterSettings({ maxActiveClusters: 15 }));
  });

  it('trailing edge does NOT fire if the value did not change since leading edge', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 5); // leading
      // No further events — same value
    });
    act(() => { jest.advanceTimersByTime(100); });
    // Trailing must not fire when value is unchanged
    expect(store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('handleMaxActiveCommit dispatches immediately and cancels the pending trailing timer', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleMaxActiveChange(new Event('change'), 3); // leading
      result.current.handleMaxActiveChange(new Event('change'), 9); // batched
    });
    act(() => {
      result.current.handleMaxActiveCommit(new Event('change'), 12); // commit on mouseup
    });
    // Commit dispatches immediately
    const callsWith12 = (store.dispatch as jest.MockedFunction<typeof store.dispatch>)
      .mock.calls.some(([a]) => JSON.stringify(a) === JSON.stringify(updateClusterSettings({ maxActiveClusters: 12 })));
    expect(callsWith12).toBe(true);

    const dispatchCount = (store.dispatch as jest.Mock).mock.calls.length;
    act(() => { jest.advanceTimersByTime(200); }); // trailing timer should have been cancelled
    expect((store.dispatch as jest.Mock).mock.calls.length).toBe(dispatchCount); // no additional dispatch
  });
});

// ─── splitThresholdFraction ───────────────────────────────────────────────

describe('REGRESSION GUARD — handleSplitThresholdChange: local state + leading+trailing throttle', () => {
  it('localSplitThreshold updates immediately on every event', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleSplitThresholdChange(new Event('change'), 0.001);
    });
    expect(result.current.localSplitThreshold).toBe(0.001);
  });

  it('dispatch fires immediately on the first event (leading edge)', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleSplitThresholdChange(new Event('change'), 0.02);
    });
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenCalledWith(updateClusterSettings({ splitThresholdFraction: 0.02 }));
  });

  it('rapid events within 100ms do NOT dispatch more than once', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      for (let i = 0; i < 8; i++) {
        result.current.handleSplitThresholdChange(new Event('change'), i * 0.001);
      }
    });
    expect(store.dispatch).toHaveBeenCalledTimes(1);
  });

  it('trailing edge dispatches the latest value after 100ms', () => {
    const { result } = renderHook(() => useClusterSettingsController(), { wrapper });
    act(() => {
      result.current.handleSplitThresholdChange(new Event('change'), 0.01);
      result.current.handleSplitThresholdChange(new Event('change'), 0.05);
    });
    act(() => { jest.advanceTimersByTime(100); });
    expect(store.dispatch).toHaveBeenLastCalledWith(updateClusterSettings({ splitThresholdFraction: 0.05 }));
  });
});
