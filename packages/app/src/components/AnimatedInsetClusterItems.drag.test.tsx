/**
 * Drag-to-reposition node insets (issue #290).
 *
 * Contract under test:
 * - dragging past DRAG_THRESHOLD_PX writes the converted data-space position
 *   into the layout store and pins the element (pinned=true, temperature=0);
 * - the click after a drag is swallowed — it must NOT begin inline labeling;
 * - a sub-threshold press stays a labeling click and pins nothing;
 * - non-left buttons never start a drag.
 */

import { describe, expect, it } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as d3 from 'd3';
import React from 'react';
import { Provider } from 'react-redux';
import type { ClusterItem } from 'src/hooks/reconcileClusterItems';
import { getSnapshot as layoutGet } from 'src/layout/layoutStore';
import type { VisualElement } from 'src/models/VisualElement';
import { endInlineLabeling } from 'src/slices/labelingSlice';
import store from 'src/store';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import AnimatedInsetClusterItems from './AnimatedInsetClusterItems';
import { collectFeatureColumns, computeSummaryRows } from './Visualization/Details/Tabular/featureStats';
import { FeatureSummaryInset } from './Visualization/Details/Tabular/TabularFeatureInsets';

function makeItem(id: string): ClusterItem {
  const element = {
    id,
    samples: [
      { id: 0, x: 0, y: 0, line: 0 },
      { id: 1, x: 1, y: 1, line: 0 },
    ],
    center: { x: 0.5, y: 0.5 },
    pinned: false,
    temperature: 1,
    renderer: {
      renderSingleNodeInset: () => <div data-testid={`single-${id}`} />,
      renderGroupNodeInset: () => <div data-testid={`group-${id}`} />,
    },
  } as unknown as VisualElement;
  return { element, hull: null };
}

// pxPerDataX = 100, pxPerDataY = -100 (inverted y, like the app's scales).
const scales = {
  xScale: d3.scaleLinear().domain([0, 1]).range([0, 100]),
  yScale: d3.scaleLinear().domain([0, 1]).range([100, 0]),
};

function insetDivOf(id: string): HTMLElement {
  const el = screen.getByTestId(`group-${id}`).parentElement;
  if (!el) throw new Error('inset motion.div not found');
  return el;
}

/** jsdom has no PointerEvent; a MouseEvent with the pointer type carries the
 *  button/clientX/clientY fields the drag handlers read. */
function firePointer(
  el: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { button?: number; clientX: number; clientY: number }
) {
  fireEvent(
    el,
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: init.button ?? 0,
      clientX: init.clientX,
      clientY: init.clientY,
    })
  );
}

function renderItems(items: ClusterItem[]) {
  return render(
    <Provider store={store}>
      <AnimatedInsetClusterItems
        insetItems={items}
        scales={scales}
        version={1}
        hoverEnabled={true}
      />
    </Provider>
  );
}

describe('drag-to-reposition node insets (#290)', () => {
  it('drag past the threshold repositions via the layout store and pins the element', () => {
    const item = makeItem('node-inset-drag-a');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-a');

    firePointer(div, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      firePointer(div, 'pointermove', { clientX: 40, clientY: 40 });
    });

    const pos = layoutGet().positions.get('node-inset-drag-a');
    expect(pos).toBeDefined();
    // dx=+30px → +0.3 data; dy=+30px on an inverted y scale → −0.3 data.
    expect(pos!.x).toBeCloseTo(0.8, 6);
    expect(pos!.y).toBeCloseTo(0.2, 6);
    expect(item.element.pinned).toBe(true);
    expect(item.element.temperature).toBe(0);

    firePointer(div, 'pointerup', { clientX: 40, clientY: 40 });
  });

  it('the click after a drag does not begin inline labeling', () => {
    const item = makeItem('node-inset-drag-b');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-b');

    firePointer(div, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      firePointer(div, 'pointermove', { clientX: 60, clientY: 10 });
    });
    firePointer(div, 'pointerup', { clientX: 60, clientY: 10 });
    fireEvent.click(div);

    expect(store.getState().labeling.activeInlineClusterUid).toBeNull();
  });

  it('a sub-threshold press stays a labeling click and pins nothing', () => {
    const item = makeItem('node-inset-drag-c');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-c');

    firePointer(div, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      firePointer(div, 'pointermove', { clientX: 12, clientY: 11 });
    });
    firePointer(div, 'pointerup', { clientX: 12, clientY: 11 });

    expect(item.element.pinned).toBe(false);
    expect(layoutGet().positions.has('node-inset-drag-c')).toBe(false);

    try {
      fireEvent.click(div);
      expect(store.getState().labeling.activeInlineClusterUid).toBe('drag-c');
    } finally {
      act(() => {
        store.dispatch(endInlineLabeling());
      });
    }
  });

  it('hovering a pinned inset shows the unpin badge; clicking it unpins without labeling', () => {
    const item = makeItem('node-inset-drag-e');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-e');

    // Pin via drag.
    firePointer(div, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      firePointer(div, 'pointermove', { clientX: 50, clientY: 10 });
    });
    firePointer(div, 'pointerup', { clientX: 50, clientY: 10 });
    fireEvent.click(div); // drag's follow-up click, swallowed
    expect(item.element.pinned).toBe(true);

    // Badge only appears while hovered.
    expect(screen.queryByLabelText('Unpin inset')).toBeNull();
    fireEvent.mouseOver(div);
    const badge = screen.getByLabelText('Unpin inset');
    // The hovered inset lifts above sibling insets (each is a transform
    // stacking context in DOM order) so the overhanging badge is never hidden.
    expect(div.style.zIndex).toBe('10');

    fireEvent.click(badge);
    expect(item.element.pinned).toBe(false);
    // Unpin is not a labeling click, and the badge disappears.
    expect(store.getState().labeling.activeInlineClusterUid).toBeNull();
    expect(screen.queryByLabelText('Unpin inset')).toBeNull();
    // The dropped position itself is untouched — the annealer takes over only
    // if the selective-reheat loop finds a violation.
    expect(layoutGet().positions.get('node-inset-drag-e')!.x).toBeCloseTo(0.9, 6);
  });

  it('the unpin badge never shows on unpinned insets, hovered or not', () => {
    const item = makeItem('node-inset-drag-f');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-f');

    fireEvent.mouseOver(div);
    expect(item.element.pinned).toBe(false);
    expect(screen.queryByLabelText('Unpin inset')).toBeNull();
    // The hover z-lift applies regardless of pin state and clears on leave.
    expect(div.style.zIndex).toBe('10');
    fireEvent.mouseOut(div);
    expect(div.style.zIndex).toBe('');
  });

  it('dragging by the body of a tabular InsetCard repositions and pins (#303)', () => {
    // Real tabular card as renderer content: its pointer events must bubble
    // to the item root for the drag to engage (the old capture-phase shield
    // swallowed them — the regression this test guards).
    const samples = [
      { x: 0, y: 0, id: 0, line: 0, v: 1 },
      { x: 1, y: 1, id: 1, line: 0, v: 2 },
    ] as unknown as DataPoint[];
    const rows = computeSummaryRows(samples, collectFeatureColumns(samples), samples);
    const item = makeItem('node-inset-drag-tab');
    item.element.renderer = {
      renderSingleNodeInset: () => <div />,
      renderGroupNodeInset: () => (
        <FeatureSummaryInset rows={rows} pointCount={samples.length} widthPx={100} />
      ),
    } as unknown as VisualElement['renderer'];
    renderItems([item]);

    const row = screen.getAllByTestId('tabular-summary-row')[0];
    firePointer(row, 'pointerdown', { clientX: 10, clientY: 10 });
    act(() => {
      firePointer(row, 'pointermove', { clientX: 40, clientY: 40 });
    });

    const pos = layoutGet().positions.get('node-inset-drag-tab');
    expect(pos).toBeDefined();
    expect(pos!.x).toBeCloseTo(0.8, 6);
    expect(pos!.y).toBeCloseTo(0.2, 6);
    expect(item.element.pinned).toBe(true);

    firePointer(row, 'pointerup', { clientX: 40, clientY: 40 });
  });

  it('non-left buttons never start a drag', () => {
    const item = makeItem('node-inset-drag-d');
    renderItems([item]);
    const div = insetDivOf('node-inset-drag-d');

    firePointer(div, 'pointerdown', { button: 2, clientX: 10, clientY: 10 });
    act(() => {
      firePointer(div, 'pointermove', { clientX: 80, clientY: 80 });
    });
    firePointer(div, 'pointerup', { clientX: 80, clientY: 80 });

    expect(item.element.pinned).toBe(false);
    expect(layoutGet().positions.has('node-inset-drag-d')).toBe(false);
  });
});
