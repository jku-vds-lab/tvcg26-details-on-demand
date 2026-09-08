import { describe, expect, it, jest } from '@jest/globals';
import { render, waitFor } from '@testing-library/react';
import * as d3 from 'd3';
import React, { createRef } from 'react';
import { Provider } from 'react-redux';
import store, { setAnnotationClusteringResults } from 'src/store';

// IMPORTANT: mock layoutStore to spy on applyPartial without changing other behavior
jest.mock('src/layout/layoutStore', () => {
  const actual = jest.requireActual<typeof import('src/layout/layoutStore')>('src/layout/layoutStore');
  return {
    ...actual,
    applyPartial: jest.fn(actual.applyPartial),
  };
});

// Mock rbush (ESM) to avoid transform issues in Jest and provide minimal API
jest.mock('rbush', () => ({
  __esModule: true,
  default: function RBushMock(this: Record<string, unknown>) {
    this.load = () => {};
    this.all = () => [];
    this.search = () => [];
  },
}));

import { applyPartial as mockApplyPartial } from 'src/layout/layoutStore';
// we'll mock hooks directly, so we don't need to render providers
import type { DataPoint, RTreeItem, TrajectoryMidpoint } from 'src/dataPreprocessing/dataPreprocessing';
import type { ClusterTreeNode } from 'src/clustering/ExtendedHDBSCAN';
import type RBushType from 'rbush';
import { DataProvider } from 'src/contexts/DataContext';
import { RendererApiProvider } from 'src/contexts/RendererApiContext';
import { SelectionWorkflowProvider } from 'src/contexts/SelectionWorkflowContext';
import * as RTreeContext from 'src/contexts/RTreeContext';
import { SegmentsProvider } from 'src/contexts/SegmentsContext';
import * as SegmentsRTreeContext from 'src/contexts/SegmentsRTreeContext';
import { TrajectoryMidpointRTreeProvider } from 'src/contexts/TrajectoryMidpointRTreeContext';
import * as TrajectoryMidpointRTreeContext from 'src/contexts/TrajectoryMidpointRTreeContext';
import { TrajectoryMidpointsProvider } from 'src/contexts/TrajectoryMidpointsContext';
import ClusterVisualizations from './ClusterVisualizations';

// Minimal RTree-like mock
function makeRTreeWith<T = DataPoint>(items: RTreeItem<T>[]) {
  return {
    all: () => items,
    search: () => items,
  } as unknown as RBushType<RTreeItem<T>>;
}

// Build a single visible DataPoint clustered under annotation uid 'A'
const point: DataPoint = {
  x: 0.5,
  y: 0.5,
  line: 0,
  algo: 'test',
  id: 1,
  action: 'none',
  DoI: 1,
  doiGroup: 'annotation',
  annotationClusterId: 'A',
  nextEdgeCenter: { x: 0.5, y: 0.5 },
};

const item: RTreeItem<DataPoint> = {
  minX: point.x,
  minY: point.y,
  maxX: point.x,
  maxY: point.y,
  data: point,
};

function setup() {
  // canvas container with a canvas child and non-zero client size
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 100 });
  Object.defineProperty(canvas, 'clientHeight', { value: 100 });
  container.appendChild(canvas);

  const xScale = d3.scaleLinear().domain([0, 1]).range([0, 100]);
  const yScale = d3.scaleLinear().domain([0, 1]).range([0, 100]);

  const annotationLayerRef = createRef<HTMLDivElement>();

  const isZoomingRef = { current: false } as React.MutableRefObject<boolean>;
  const reheatRef = { current: () => {} } as React.MutableRefObject<() => void>;

  // Mock the hooks used by the component to return our refs.
  jest.spyOn(RTreeContext, 'useRTreeRef').mockReturnValue({ current: makeRTreeWith([item]) });
  jest.spyOn(SegmentsRTreeContext, 'useSegmentsRTreeRef').mockReturnValue({ current: null });
  jest.spyOn(TrajectoryMidpointRTreeContext, 'useTrajectoryMidpointRTreeRef').mockReturnValue({ current: makeRTreeWith<TrajectoryMidpoint>([]) });

  // Context hooks the component gained since this test was written
  // (useRelationSpotlight → useDataRef etc.) resolve against the real
  // providers; the spied ref hooks above still win where a spy exists.
  const ui = (
    <Provider store={store}>
      <DataProvider>
        <SegmentsProvider>
          <TrajectoryMidpointsProvider>
            <TrajectoryMidpointRTreeProvider>
              <RendererApiProvider value={{ current: null }}>
              <SelectionWorkflowProvider value={() => {}}>
              <ClusterVisualizations
                scales={{ xScale, yScale }}
                zoomTransform={d3.zoomIdentity}
                canvasContainer={container as HTMLDivElement}
                annotationLayerRef={annotationLayerRef}
                isZoomingRef={isZoomingRef}
                reheatRef={reheatRef}
              />
              </SelectionWorkflowProvider>
              </RendererApiProvider>
            </TrajectoryMidpointRTreeProvider>
          </TrajectoryMidpointsProvider>
        </SegmentsProvider>
      </DataProvider>
    </Provider>
  );

  return { ui };
}

describe('ClusterVisualizations responds to clustering updates without zoom/pan', () => {
  it('applies a layout patch immediately when clustering version changes', async () => {
    const { ui } = setup();

    // Initial render: hooks will schedule a rAF-based seed; we do not advance timers, so no apply yet
    render(ui);

    // Ensure no patch has been applied yet (seed is rAF-batched via setTimeout fallback)
    expect((mockApplyPartial as jest.Mock).mock.calls.length).toBe(0);

    // Dispatch clustering results that activate uid 'A'
    const activeClusters = [{ id: 1, uid: 'A', size: 1, stability: 1, distance: 0, children: [0] } as ClusterTreeNode];
    store.dispatch(
      setAnnotationClusteringResults({ activeClusters, hierarchyId: 1 })
    );

    // Wait for the effect that snaps positions to source to run and call applyPartial
    await waitFor(() => {
      expect((mockApplyPartial as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    });
  });
});
