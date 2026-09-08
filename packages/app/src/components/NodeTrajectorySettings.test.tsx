/**
 * Integration test – NodeTrajectorySettings: node-radius slider double-click reset.
 *
 * Acceptance criterion:
 *   Dragging the Node Radius slider to a different position, then double-clicking
 *   the thumb, must reset both the local draft value AND the Redux store setting
 *   back to the default.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Provider } from 'react-redux';
import store, { initialVisualizationSettings, updateSettings } from '../store';
import { clearOpacityClampingPreview } from '../stores/opacityClampingPreviewStore';
import { cubicSliderToValue } from '../utils/sliderUtils';
import NodeTrajectorySettings, { clampOrder01 } from './NodeTrajectorySettings';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Provide a no-op renderer API ref so the component doesn't throw.
jest.mock('../contexts/RendererApiContext', () => ({
  useRendererApiRef: () => ({ current: null }),
  useRendererApi: () => null,
}));

// Suppress the "not implemented" rAF error in jsdom.
beforeEach(() => {
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  clearOpacityClampingPreview();
  // Restore nodeRadius so tests don't bleed into each other.
  act(() => {
    store.dispatch(updateSettings({ nodeRadius: initialVisualizationSettings.nodeRadius }));
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderComponent() {
  return render(
    React.createElement(
      Provider,
      {
        store,
        children: React.createElement(NodeTrajectorySettings, null),
      },
    ),
  );
}

/**
 * Returns the MUI Slider thumb (data-index="0") that belongs to the slider
 * labelled `labelText`.  MUI renders the Typography label and the Slider as
 * siblings inside the same Box, so we walk up from the label's parent element.
 */
function getThumbForSlider(labelText: string, thumbIndex = 0): HTMLElement {
  const label = screen.getByText(labelText);
  const box = label.parentElement;
  if (!box) throw new Error(`No slider container found for label "${labelText}"`);
  const thumb = box.querySelector(`[data-index="${thumbIndex}"]`);
  if (!thumb) throw new Error(`No thumb[${thumbIndex}] found under label "${labelText}"`);
  return thumb as HTMLElement;
}

// ─── Acceptance-criterion tests ───────────────────────────────────────────────

describe('NodeTrajectorySettings – node radius slider double-click reset', () => {
  it('resets nodeRadius to its default after the value has been changed (drag simulation)', () => {
    // 1. Simulate a drag by pre-loading the store with a non-default nodeRadius.
    //    The component initialises draftStyle from the store, so the slider will
    //    show value 20 on mount.
    store.dispatch(updateSettings({ nodeRadius: 20 }));

    renderComponent();

    // Sanity-check: the store must hold the dragged-to value before we reset.
    expect(store.getState().visualizationSettings.nodeRadius).toBe(20);

    // 2. Double-click the Node Radius thumb – this should trigger the reset.
    fireEvent.dblClick(getThumbForSlider('Node Radius'));

    // 3. The store must now hold the initial default value.
    expect(store.getState().visualizationSettings.nodeRadius).toBe(
      initialVisualizationSettings.nodeRadius,
    );
  });

  it('does not affect other style settings when resetting nodeRadius', () => {
    const originalEdgeWidth = initialVisualizationSettings.edgeWidth;
    store.dispatch(updateSettings({ nodeRadius: 20, edgeWidth: 7 }));

    renderComponent();
    fireEvent.dblClick(getThumbForSlider('Node Radius'));

    // nodeRadius is reset; edgeWidth should remain unchanged.
    expect(store.getState().visualizationSettings.nodeRadius).toBe(
      initialVisualizationSettings.nodeRadius,
    );
    expect(store.getState().visualizationSettings.edgeWidth).toBe(7);

    // Clean up edgeWidth too.
    act(() => {
      store.dispatch(updateSettings({ edgeWidth: originalEdgeWidth }));
    });
  });

  it('is idempotent: double-clicking at the default value leaves nodeRadius at its default', () => {
    // Store already at default (afterEach ensures this between tests).
    renderComponent();
    fireEvent.dblClick(getThumbForSlider('Node Radius'));

    expect(store.getState().visualizationSettings.nodeRadius).toBe(
      initialVisualizationSettings.nodeRadius,
    );
  });
});

// ─── Bonus: other sliders in NodeTrajectorySettings ───────────────────────────

describe('NodeTrajectorySettings – other sliders double-click reset', () => {
  afterEach(() => {
    act(() => {
      store.dispatch(
        updateSettings({
          edgeWidth: initialVisualizationSettings.edgeWidth,
          annotationLabelScale: initialVisualizationSettings.annotationLabelScale,
          minimumOpacityClamping: initialVisualizationSettings.minimumOpacityClamping,
          maximumOpacityClamping: initialVisualizationSettings.maximumOpacityClamping,
        }),
      );
    });
  });

  it('resets edgeWidth to its default on double-click', () => {
    store.dispatch(updateSettings({ edgeWidth: 15 }));
    renderComponent();
    fireEvent.dblClick(getThumbForSlider('Edge Width'));
    expect(store.getState().visualizationSettings.edgeWidth).toBe(
      initialVisualizationSettings.edgeWidth,
    );
  });

  it('resets the lower opacity clamp thumb to its default', () => {
    store.dispatch(updateSettings({ minimumOpacityClamping: 0.3 }));
    renderComponent();
    fireEvent.dblClick(getThumbForSlider('Opacity Clamping Range', 0));
    expect(store.getState().visualizationSettings.minimumOpacityClamping).toBe(
      initialVisualizationSettings.minimumOpacityClamping,
    );
    // Upper clamp must be untouched.
    expect(store.getState().visualizationSettings.maximumOpacityClamping).toBe(
      initialVisualizationSettings.maximumOpacityClamping,
    );
  });
});

// ─── Cubic-warped opacity-clamping range slider (issue #315) ──────────────────

/** Returns the two hidden range <input> elements of the opacity slider (index 0 = lower). */
function getOpacityInputs(): HTMLInputElement[] {
  const box = screen.getByText('Opacity Clamping Range').parentElement;
  if (!box) throw new Error('No opacity slider container found');
  return Array.from(box.querySelectorAll('input[type="range"]')) as HTMLInputElement[];
}

describe('clampOrder01 (opacity range clamp/order invariant)', () => {
  it('clamps to [0,1] and returns the pair in ascending order', () => {
    expect(clampOrder01(0.2, 0.8)).toEqual([0.2, 0.8]);
    expect(clampOrder01(0.8, 0.2)).toEqual([0.2, 0.8]); // crossed positions
    expect(clampOrder01(-0.5, 1.5)).toEqual([0, 1]); // out of range
    expect(clampOrder01(2, -1)).toEqual([0, 1]); // crossed AND out of range
    expect(clampOrder01(0.4, 0.4)).toEqual([0.4, 0.4]); // equal
  });

  it('cubed emitted values always satisfy 0 <= min <= max <= 1, even for crossed/out-of-range input', () => {
    const cases: Array<[number, number]> = [
      [0.9, 0.1],
      [-1, 2],
      [0.5, 0.5],
      [1.2, 0.3],
      [0, -0.2],
      [0.73, 0.05],
    ];
    for (const [a, b] of cases) {
      const [lo, hi] = clampOrder01(a, b);
      const min = cubicSliderToValue(lo);
      const max = cubicSliderToValue(hi);
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(max);
    }
  });
});

describe('NodeTrajectorySettings – opacity clamping range slider (cubic warp)', () => {
  afterEach(() => {
    act(() => {
      store.dispatch(
        updateSettings({
          minimumOpacityClamping: initialVisualizationSettings.minimumOpacityClamping,
          maximumOpacityClamping: initialVisualizationSettings.maximumOpacityClamping,
        }),
      );
    });
  });

  // (a) Fixpoint: onChange(position) -> emit cubed value -> reflect leaves the
  // thumb position unchanged. The reverted attempt oscillated here because the
  // controlled value round-tripped through cbrt(store) and re-snapped to the
  // step grid every render. Positions are now the source of truth, so feeding
  // the emitted value back must not move the thumb.
  it('is a stable fixpoint: emitting the cubed value and feeding it back does not move the thumb', () => {
    renderComponent();
    const lower = getOpacityInputs()[0];

    // Drive onChange+commit with a raw position of 0.3 (MUI's hidden input
    // change fires both preview and commit handlers in one event).
    act(() => {
      fireEvent.change(lower, { target: { value: '0.3' } });
    });

    // The committed (emitted) opacity value is the cube of the position.
    expect(store.getState().visualizationSettings.minimumOpacityClamping).toBeCloseTo(0.027, 10);
    // The thumb position must not have drifted.
    expect(lower.value).toBe('0.3');

    // Explicitly feed the emitted value back as the prop (store) again — the
    // epsilon-guarded reflect must NOT re-snap the position.
    act(() => {
      store.dispatch(updateSettings({ minimumOpacityClamping: 0.027 }));
    });
    expect(lower.value).toBe('0.3');
  });

  // (c) The value label shows the TRUE (cubed) value via `scale`, not the raw
  // thumb position, formatted to 2 significant figures.
  it('labels show the true cubed value, not the slider position', () => {
    act(() => {
      // position 0.2 -> value 0.008 ; position 0.5 -> value 0.125
      store.dispatch(updateSettings({ minimumOpacityClamping: 0.008, maximumOpacityClamping: 0.125 }));
    });
    renderComponent();

    // The lower thumb sits near position 0.2 (cbrt(0.008)) but its label reads
    // the TRUE cubed value 0.008 — proving the label uses `scale`, not position.
    expect(parseFloat(getOpacityInputs()[0].value)).toBeCloseTo(0.2, 6);
    expect(screen.getByText('0.008')).toBeTruthy();
    // Upper thumb: position ~0.5, true value 0.125 -> 2 sig figs "0.13".
    expect(parseFloat(getOpacityInputs()[1].value)).toBeCloseTo(0.5, 6);
    expect(screen.getByText('0.13')).toBeTruthy();
  });

  // (d, testable half) External store change while NOT dragging reflects into
  // the thumb positions.
  it('reflects an external store change into the thumb positions when not dragging', () => {
    renderComponent();
    // Default lower clamp is 0.05 -> position cbrt(0.05) ≈ 0.368, not 0.5.
    expect(parseFloat(getOpacityInputs()[0].value)).toBeCloseTo(Math.cbrt(0.05), 6);

    act(() => {
      // value 0.125 -> position 0.5
      store.dispatch(updateSettings({ minimumOpacityClamping: 0.125 }));
    });
    expect(parseFloat(getOpacityInputs()[0].value)).toBeCloseTo(0.5, 6);
  });

  // (d, untestable half) The mid-gesture "external change must not fight the
  // drag" path is gated by opacityDraggingRef, which is only set true during a
  // real pointer drag (mousedown -> mousemove -> mouseup). jsdom reports a
  // zero-size layout, so MUI's trackFinger() bails and no drag state is ever
  // entered — keyboard and hidden-input changes fire onChange AND
  // onChangeCommitted together, releasing the gate immediately. The reflect
  // effect's dragging gate is therefore not reachable from RTL; the fixpoint
  // test above exercises the epsilon guard that prevents self-echo loops.
  it.skip('does not fight an in-progress drag (requires a real pointer drag; untestable in jsdom)', () => {});
});
