/**
 * REGRESSION GUARD: ZoomBehavior.onStart must actually re-dispatch the
 * synthetic mousedown onto the canvas.
 *
 * Bug history (#290 follow-up): the MouseEvent was constructed with
 * `view: global.window` — `global` is undefined in the browser, so the
 * constructor threw into the silent catch on every call and the dispatch
 * never happened. Right-button pan still worked when the gesture started on
 * the canvas (the real compat mousedown reaches d3-zoom directly) but was
 * dead when it started on an inset div, where the synthetic dispatch is the
 * only path into d3-zoom.
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as d3 from 'd3';
import type { RendererAPI } from '../gl/api/RendererAPI';
import type { VisualizationSettings } from '../store';
import { createZoomBehavior } from './ZoomBehavior';

describe('ZoomBehavior synthetic mousedown dispatch', () => {
  it('onStart dispatches a mousedown carrying the gesture coordinates and button', () => {
    const canvas = document.createElement('canvas');
    const behavior = createZoomBehavior(
      canvas,
      () => null,
      () => {},
      { minZoom: 0.5, maxZoom: 10 } as VisualizationSettings,
      { render: jest.fn() } as unknown as RendererAPI
    );

    const dispatched: Event[] = [];
    const spy = jest.spyOn(canvas, 'dispatchEvent').mockImplementation((ev: Event) => {
      dispatched.push(ev);
      return true;
    });

    behavior.onStart({ clientX: 40, clientY: 60, button: 2 } as PointerEvent);
    spy.mockRestore();

    // With the broken `global.window` view this constructor threw before the
    // dispatch, so dispatched stayed empty.
    expect(dispatched).toHaveLength(1);
    const ev = dispatched[0] as MouseEvent;
    expect(ev.type).toBe('mousedown');
    expect(ev.button).toBe(2);
    expect(ev.clientX).toBe(40);
    expect(ev.clientY).toBe(60);
    expect(ev.view).toBe(window);
  });
});

/**
 * Animated wheel zoom (issue #315): discrete notches ease the transform via
 * a d3 transition instead of jumping; trackpad-scale deltas keep the raw
 * synthetic-dispatch path; a burst of notches surfaces as ONE gesture.
 */
describe('ZoomBehavior animated wheel notches', () => {
  function setup(opts?: { onStart?: () => void; onEnd?: () => void; nodeCount?: number }) {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const behavior = createZoomBehavior(
      canvas,
      () => null,
      () => {},
      { minZoom: 0.5, maxZoom: 10 } as VisualizationSettings,
      // Animated notches are gated to scale-edition datasets (the gesture
      // compositor absorbs the per-frame cost there): the mock reports a
      // huge nodeCount unless a test overrides it.
      {
        render: jest.fn(),
        getRaw: () => ({ nodeCount: opts?.nodeCount ?? 1_000_000, densityHint: null }),
      } as unknown as RendererAPI,
      opts
    );
    return { canvas, behavior };
  }

  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a discrete notch animates to the exact d3 per-notch scale (no raw dispatch)', async () => {
    const { canvas, behavior } = setup();
    const dispatched: Event[] = [];
    const spy = jest.spyOn(canvas, 'dispatchEvent').mockImplementation((ev) => {
      dispatched.push(ev);
      return true;
    });
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    spy.mockRestore();

    // The animated path never re-dispatches a synthetic wheel event.
    expect(dispatched.filter((e) => e.type === 'wheel')).toHaveLength(0);

    await settle(400); // transition is 150 ms
    // Same factor as d3's raw wheel path: 2^(120 * 0.002).
    expect(d3.zoomTransform(canvas).k).toBeCloseTo(Math.pow(2, 0.24), 3);
    document.body.removeChild(canvas);
  });

  it('fast successive notches compound the full per-notch factor', async () => {
    const { canvas, behavior } = setup();
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    await settle(40); // mid-animation — well before the 150 ms transition ends
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    await settle(500);
    // Two notches must yield exactly factor², not factor × (mid-animation k).
    expect(d3.zoomTransform(canvas).k).toBeCloseTo(Math.pow(2, 0.48), 3);
    document.body.removeChild(canvas);
  });

  it('a notch burst surfaces as ONE gesture (single onStart/onEnd)', async () => {
    const onStart = jest.fn();
    const onEnd = jest.fn();
    const { canvas, behavior } = setup({ onStart, onEnd });
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    await settle(40);
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    await settle(500);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    document.body.removeChild(canvas);
  });

  it('trackpad-scale deltas keep the raw synthetic-dispatch path with FULL event fidelity', () => {
    const { canvas, behavior } = setup();
    const dispatched: Event[] = [];
    const spy = jest.spyOn(canvas, 'dispatchEvent').mockImplementation((ev) => {
      dispatched.push(ev);
      return true;
    });
    // Pinch-zoom: ctrlKey MUST survive the re-dispatch (d3 applies a 10×
    // wheelDelta multiplier for it — dropping it was the touchpad
    // regression CS reported), as must deltaX and deltaMode.
    behavior.onWheel?.({ deltaY: -6, deltaX: 3, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: true } as WheelEvent);
    spy.mockRestore();
    const wheels = dispatched.filter((e) => e.type === 'wheel') as WheelEvent[];
    expect(wheels).toHaveLength(1);
    // The flag is what the zoom filter accepts — real wheels are rejected
    // there so they route through the animated dispatcher instead.
    expect((wheels[0] as unknown as Record<string, unknown>).__zoomBehaviorSynthetic).toBe(true);
    expect(wheels[0].ctrlKey).toBe(true);
    expect(wheels[0].deltaX).toBe(3);
    expect(wheels[0].deltaY).toBe(-6);
    expect(wheels[0].deltaMode).toBe(0);
    document.body.removeChild(canvas);
  });

  it('small (paper) datasets keep the raw instant notch — no eased animation', () => {
    // No gesture compositor below the scale gate: every eased frame would run
    // the full annotation pipeline and the 150 ms ease reads as stutter
    // (CS, rubik 10x2, 2026-07-20).
    const { canvas, behavior } = setup({ nodeCount: 2_000 });
    const dispatched: Event[] = [];
    const spy = jest.spyOn(canvas, 'dispatchEvent').mockImplementation((ev) => {
      dispatched.push(ev);
      return true;
    });
    behavior.onWheel?.({ deltaY: -120, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    spy.mockRestore();
    expect(dispatched.filter((e) => e.type === 'wheel')).toHaveLength(1); // raw path
    document.body.removeChild(canvas);
  });

  it('a big delta INSIDE a trackpad stream stays raw (no animation mid-flick)', () => {
    const { canvas, behavior } = setup();
    const dispatched: Event[] = [];
    const spy = jest.spyOn(canvas, 'dispatchEvent').mockImplementation((ev) => {
      dispatched.push(ev);
      return true;
    });
    // A fast two-finger flick ramps up: small delta, then a notch-sized one
    // ~10 ms later. The second event must NOT be misclassified as a mouse
    // notch — it is part of a continuous stream (gap < 50 ms, no active
    // animated burst).
    behavior.onWheel?.({ deltaY: -30, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    behavior.onWheel?.({ deltaY: -140, deltaMode: 0, clientX: 5, clientY: 5, ctrlKey: false } as WheelEvent);
    spy.mockRestore();
    // Both events took the raw synthetic path.
    expect(dispatched.filter((e) => e.type === 'wheel')).toHaveLength(2);
    document.body.removeChild(canvas);
  });
});
