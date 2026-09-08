/**
 * REGRESSION GUARD (perf overhaul phase 5): inset renderer JSX must be built
 * once per (element, samples, renderer-settings) — NOT once per layout patch
 * or parent re-render.
 *
 * Bug history: the animated cluster-item lists subscribed to the layout store
 * via useLayout() and re-invoked element.renderer.render*() for EVERY item on
 * EVERY annealer patch / settled zoom tick — the dominant zoom-time React cost
 * after phases 1-4+6 (renderer JSX + signatureForPoints + MUI sx recompute).
 *
 * Fix: per-item React.memo child with useMemo'd renderer output keyed on the
 * inputs the renderers actually read (samples identity, clusterSettings,
 * annotation-label settings, inline-label draft).
 */

import { describe, expect, it, jest } from '@jest/globals';
import { act, render } from '@testing-library/react';
import * as d3 from 'd3';
import React from 'react';
import { Provider } from 'react-redux';
import type { ClusterItem } from 'src/hooks/reconcileClusterItems';
import { applyPartial } from 'src/layout/layoutStore';
import type { VisualElement } from 'src/models/VisualElement';
import { clearAllAssignments, importLabels } from 'src/slices/labelingSlice';
import store, { initialClusterSettings, updateClusterSettings } from 'src/store';
import AnimatedInsetClusterItems from './AnimatedInsetClusterItems';

type MockedElement = {
  element: VisualElement;
  renderSingle: jest.Mock;
  renderGroup: jest.Mock;
};

function makeItem(id: string, sampleCount: number): MockedElement & { item: ClusterItem } {
  const renderSingle = jest.fn(() => <div data-testid={`single-${id}`} />);
  const renderGroup = jest.fn(() => <div data-testid={`group-${id}`} />);
  const samples = Array.from({ length: sampleCount }, (_, i) => ({ id: i, x: i, y: i, line: 0 }));
  const element = {
    id,
    samples,
    center: { x: 0.5, y: 0.5 },
    renderer: { renderSingleNodeInset: renderSingle, renderGroupNodeInset: renderGroup },
  } as unknown as VisualElement;
  return { element, renderSingle, renderGroup, item: { element, hull: null } };
}

const scales = {
  xScale: d3.scaleLinear().domain([0, 1]).range([0, 100]),
  yScale: d3.scaleLinear().domain([0, 1]).range([100, 0]),
};

function rendererCalls(m: MockedElement): number {
  return m.renderSingle.mock.calls.length + m.renderGroup.mock.calls.length;
}

describe('REGRESSION GUARD — inset renderer JSX is memoized per item', () => {
  it('does not re-invoke renderers while layout patches stream', () => {
    const a = makeItem('node-inset-a', 3);
    const b = makeItem('node-inset-b', 1);
    const c = makeItem('node-inset-c', 5);
    const items = [a.item, b.item, c.item];

    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems insetItems={items} scales={scales} version={1} />
      </Provider>
    );

    expect(rendererCalls(a)).toBe(1);
    expect(rendererCalls(b)).toBe(1);
    expect(rendererCalls(c)).toBe(1);
    expect(a.renderGroup).toHaveBeenCalledTimes(1); // 3 samples → group path
    expect(b.renderSingle).toHaveBeenCalledTimes(1); // 1 sample → single path

    // Stream 10 layout patches moving only element a — simulates annealer
    // steps / midpoint pinning while the engine is warm.
    for (let i = 1; i <= 10; i++) {
      act(() => {
        applyPartial(new Map([['node-inset-a', { x: 0.5 + i * 0.01, y: 0.5 }]]));
      });
    }

    // No renderer re-ran: moving items reposition via motion props only,
    // unmoved items skip re-render entirely (React.memo).
    expect(rendererCalls(a)).toBe(1);
    expect(rendererCalls(b)).toBe(1);
    expect(rendererCalls(c)).toBe(1);
  });

  it('re-invokes the renderer when samples identity changes (membership change)', () => {
    const a = makeItem('node-inset-a2', 2);
    const b = makeItem('node-inset-b2', 2);
    const items = [a.item, b.item];

    const { rerender } = render(
      <Provider store={store}>
        <AnimatedInsetClusterItems insetItems={items} scales={scales} version={1} />
      </Provider>
    );
    expect(rendererCalls(a)).toBe(1);

    // reconcileClusterItems assigns a new samples array on membership change.
    act(() => {
      (a.element as unknown as { samples: unknown }).samples = [
        { id: 0, x: 0, y: 0, line: 0 },
        { id: 1, x: 1, y: 1, line: 0 },
        { id: 2, x: 2, y: 2, line: 0 },
      ];
    });
    rerender(
      <Provider store={store}>
        <AnimatedInsetClusterItems insetItems={[...items]} scales={scales} version={2} />
      </Provider>
    );

    expect(rendererCalls(a)).toBe(2); // busted by samples identity
    expect(rendererCalls(b)).toBe(1); // untouched item stays memoized
  });

  it('re-invokes all renderers when clusterSettings change (bbox/scale inputs)', () => {
    const a = makeItem('node-inset-a3', 2);
    const items = [a.item];

    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems insetItems={items} scales={scales} version={1} />
      </Provider>
    );
    expect(rendererCalls(a)).toBe(1);

    try {
      act(() => {
        store.dispatch(updateClusterSettings({ insetMinScale: 1.31 }));
      });
      expect(rendererCalls(a)).toBe(2);
    } finally {
      act(() => {
        store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
      });
    }
  });

  it('re-invokes all renderers when label assignments change (issue #352)', () => {
    const a = makeItem('node-inset-a4', 2);
    const items = [a.item];

    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems insetItems={items} scales={scales} version={1} />
      </Provider>
    );
    expect(rendererCalls(a)).toBe(1);

    try {
      act(() => {
        store.dispatch(importLabels({ '0': 'walk' }));
      });
      expect(rendererCalls(a)).toBe(2);
    } finally {
      act(() => {
        store.dispatch(clearAllAssignments());
      });
    }
  });
});
