/**
 * REGRESSION GUARD: ClusterVisualizations must mount when rTreeReady becomes true.
 *
 * Bug history: `rTree` was stored as a React ref.  Assigning a ref never triggers
 * a re-render, so `VisualizationContainer` never re-evaluated its render gate after
 * the R-tree was built — `ClusterVisualizations` never mounted, and annotations were
 * invisible until the user zoomed/panned.
 *
 * Fix: added `RTreeReadyContext` with boolean React state; `VisualizationContainer`
 * gates on `rTreeReady` state (not the ref).
 *
 * If ANY test in this file fails:
 *   ██████████████████████████████████████████████████████████████
 *   ██  CRITICAL: annotations will NOT appear on initial load or  ██
 *   ██  after a dataset swap until the user zooms or pans.        ██
 *   ██  Check RTreeContext.tsx and VisualizationContainer.tsx.    ██
 *   ██████████████████████████████████████████████████████████████
 */

import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, jest } from '@jest/globals';
import { RTreeProvider, useRTreeReady } from './RTreeContext';

// ─── context state tests (no VisualizationContainer involved) ─────────────

const ReadyProbe: React.FC<{ onReady: (v: boolean) => void }> = ({ onReady }) => {
  const { ready, setReady } = useRTreeReady();
  React.useEffect(() => { onReady(ready); }, [ready, onReady]);
  return <button onClick={() => setReady(true)}>mark ready</button>;
};

describe('REGRESSION GUARD — RTreeReadyContext must use React state, not a ref', () => {
  it('ready is false on initial render', () => {
    const values: boolean[] = [];
    render(
      <RTreeProvider>
        <ReadyProbe onReady={(v) => values.push(v)} />
      </RTreeProvider>
    );
    expect(values[0]).toBe(false);
  });

  it('calling setReady(true) changes ready to true and triggers a re-render', () => {
    const values: boolean[] = [];
    render(
      <RTreeProvider>
        <ReadyProbe onReady={(v) => values.push(v)} />
      </RTreeProvider>
    );
    act(() => { screen.getByRole('button').click(); });
    expect(values.at(-1)).toBe(true);
  });

  it('setReady(false) after setReady(true) reverts to false (supports dataset swap)', () => {
    let ctrl!: ReturnType<typeof useRTreeReady>;
    const Capture: React.FC = () => { ctrl = useRTreeReady(); return null; };
    render(<RTreeProvider><Capture /></RTreeProvider>);

    act(() => { ctrl.setReady(true); });
    expect(ctrl.ready).toBe(true);

    act(() => { ctrl.setReady(false); });
    expect(ctrl.ready).toBe(false);
  });
});

// ─── VisualizationContainer render gate ──────────────────────────────────

jest.mock('src/components/ClusterVisualizations', () => ({
  __esModule: true,
  default: () => <div data-testid="cluster-visualizations" />,
}));

jest.mock(
  'src/components/Visualization/CanvasContainer',
  () => ({
    __esModule: true,
    default: React.forwardRef((_props: unknown, ref: React.ForwardedRef<HTMLDivElement>) => (
      <div ref={ref} data-testid="canvas-container" />
    )),
  }),
  { virtual: false }
);

// VisualizationContainer needs a Redux store for ClusterVisualizations (mocked above).
import { Provider } from 'react-redux';
import store from 'src/store';
import * as d3 from 'd3';
import VisualizationContainer from 'src/components/Visualization/VisualizationContainer';

const fakeScales = {
  xScale: d3.scaleLinear().domain([0, 1]).range([0, 100]),
  yScale: d3.scaleLinear().domain([0, 1]).range([0, 100]),
};

const noop = () => {};
const noopRef = { current: document.createElement('div') } as React.RefObject<HTMLDivElement>;
const boolRef = { current: false } as React.MutableRefObject<boolean>;
const fnRef = { current: () => {} } as React.MutableRefObject<() => void>;

function renderContainer(extraProps?: Partial<React.ComponentProps<typeof VisualizationContainer>>) {
  const canvasRef = { current: null } as React.RefObject<HTMLDivElement>;
  const { rerender } = render(
    <Provider store={store}>
      <RTreeProvider>
        <VisualizationContainer
          canvasContainerRef={canvasRef}
          scales={fakeScales}
          zoomTransform={d3.zoomIdentity}
          data={[]}
          handleLassoComplete={noop}
          annotationLayerRef={noopRef}
          isZoomingRef={boolRef}
          reheatRef={fnRef}
          {...extraProps}
        />
      </RTreeProvider>
    </Provider>
  );
  return { canvasRef, rerender };
}

describe('REGRESSION GUARD — VisualizationContainer must gate on rTreeReady state', () => {
  it('does NOT render ClusterVisualizations before rTree is ready', () => {
    renderContainer();
    expect(screen.queryByTestId('cluster-visualizations')).toBeNull();
  });

  it('renders ClusterVisualizations once setReady(true) is called', () => {
    let ctrl!: ReturnType<typeof useRTreeReady>;
    const Capture: React.FC = () => { ctrl = useRTreeReady(); return null; };

    const canvasRef = { current: document.createElement('div') } as React.RefObject<HTMLDivElement>;
    render(
      <Provider store={store}>
        <RTreeProvider>
          <Capture />
          <VisualizationContainer
            canvasContainerRef={canvasRef}
            scales={fakeScales}
            zoomTransform={d3.zoomIdentity}
            data={[]}
            handleLassoComplete={noop}
            annotationLayerRef={noopRef}
            isZoomingRef={boolRef}
            reheatRef={fnRef}
          />
        </RTreeProvider>
      </Provider>
    );

    expect(screen.queryByTestId('cluster-visualizations')).toBeNull();
    act(() => { ctrl.setReady(true); });
    expect(screen.getByTestId('cluster-visualizations')).toBeTruthy();
  });
});
