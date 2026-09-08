/**
 * REGRESSION GUARD (issue #289): node-inset hover must fire onHoverCluster —
 * the D1 hover reveal (diff insets + leader lines) and the whileHover enlarge
 * depend on it — even while labeling is active.
 *
 * Bug history: hover handlers were gated on `!isLabeling && hoverEnabled`
 * (from #223, when labeling was an explicit Ctrl+L mode). PR #279 (#182) made
 * `labeling.isEnabled` permanently true, so the gate silenced hover for good.
 * Hover and click-to-label must coexist on the same inset.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as d3 from 'd3';
import React from 'react';
import { Provider } from 'react-redux';
import type { ClusterItem } from 'src/hooks/reconcileClusterItems';
import type { VisualElement } from 'src/models/VisualElement';
import { endInlineLabeling } from 'src/slices/labelingSlice';
import store from 'src/store';
import AnimatedInsetClusterItems from './AnimatedInsetClusterItems';

function makeItem(id: string): ClusterItem {
  const element = {
    id,
    samples: [
      { id: 0, x: 0, y: 0, line: 0 },
      { id: 1, x: 1, y: 1, line: 0 },
    ],
    center: { x: 0.5, y: 0.5 },
    renderer: {
      renderSingleNodeInset: () => <div data-testid={`single-${id}`} />,
      renderGroupNodeInset: () => <div data-testid={`group-${id}`} />,
    },
  } as unknown as VisualElement;
  return { element, hull: null };
}

const scales = {
  xScale: d3.scaleLinear().domain([0, 1]).range([0, 100]),
  yScale: d3.scaleLinear().domain([0, 1]).range([100, 0]),
};

/** The motion.div carrying the pointer handlers wraps the renderer output. */
function insetDivOf(id: string): HTMLElement {
  const el = screen.getByTestId(`group-${id}`).parentElement;
  if (!el) throw new Error('inset motion.div not found');
  return el;
}

describe('REGRESSION GUARD — inset hover fires while labeling is active (#289)', () => {
  it('labeling is always active by default (#182) — precondition for this guard', () => {
    expect(store.getState().labeling.isEnabled).toBe(true);
  });

  it('mouse over/out fires onHoverCluster(uid) / onHoverCluster(null)', () => {
    const onHoverCluster = jest.fn();
    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems
          insetItems={[makeItem('node-inset-a')]}
          scales={scales}
          version={1}
          onHoverCluster={onHoverCluster}
          hoverEnabled={true}
        />
      </Provider>
    );

    fireEvent.mouseOver(insetDivOf('node-inset-a'));
    expect(onHoverCluster).toHaveBeenLastCalledWith('a');
    fireEvent.mouseOut(insetDivOf('node-inset-a'));
    expect(onHoverCluster).toHaveBeenLastCalledWith(null);
  });

  it('click-to-label (#182) still works alongside hover', () => {
    const onHoverCluster = jest.fn();
    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems
          insetItems={[makeItem('node-inset-b')]}
          scales={scales}
          version={1}
          onHoverCluster={onHoverCluster}
          hoverEnabled={true}
        />
      </Provider>
    );

    try {
      fireEvent.click(insetDivOf('node-inset-b'));
      expect(store.getState().labeling.activeInlineClusterUid).toBe('b');
    } finally {
      act(() => {
        store.dispatch(endInlineLabeling());
      });
    }
  });

  it('hoverEnabled=false attaches no hover handlers', () => {
    const onHoverCluster = jest.fn();
    render(
      <Provider store={store}>
        <AnimatedInsetClusterItems
          insetItems={[makeItem('node-inset-c')]}
          scales={scales}
          version={1}
          onHoverCluster={onHoverCluster}
          hoverEnabled={false}
        />
      </Provider>
    );

    fireEvent.mouseOver(insetDivOf('node-inset-c'));
    fireEvent.mouseOut(insetDivOf('node-inset-c'));
    expect(onHoverCluster).not.toHaveBeenCalled();
  });
});
