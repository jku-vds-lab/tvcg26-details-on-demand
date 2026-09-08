/**
 * WorkflowTabPanel.test.tsx — the 90% surface carries exactly TWO budget
 * sliders (cluster budget with an inline unfold arrow for its sub-settings,
 * edge inset budget) plus the live readout. No accordions, no captions, no
 * visibility toggle — explanation lives in tooltips only (issue #261 part 4).
 */
import { describe, expect, it, jest } from '@jest/globals';

// The search + interest-propagation children are not under test — mock them
// to keep the smoke light (they pull worker/search machinery).
jest.mock('../FeatureSearchInput', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../InterestTabSliders', () => ({
  __esModule: true,
  default: () => null,
}));
import { fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { SelectionWorkflowProvider } from 'src/contexts/SelectionWorkflowContext';
import store, { initialClusterSettings, updateClusterSettings } from 'src/store';
import WorkflowTabPanel from './WorkflowTabPanel';

const sliderSettings = {
  proximitySlider: 0.5,
  pastSlider: 0.5,
  futureSlider: 0.5,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function renderPanel() {
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  return render(
    <Provider store={store}>
      {/* The panel hosts SelectionModeToggles, which reads the workflow context. */}
      <SelectionWorkflowProvider value={jest.fn() as never}>
        <WorkflowTabPanel
          sliderSettings={sliderSettings}
          handlePropagationSliderChange={jest.fn() as never}
          handlePropagationSliderFinalChange={jest.fn() as never}
          featureSearchDeps={{} as never}
        />
      </SelectionWorkflowProvider>
    </Provider>,
  );
}

describe('WorkflowTabPanel (issue #261 part 4)', () => {
  it('carries exactly the two budget sliders and the live readout', () => {
    const { container, queryByLabelText } = renderPanel();
    expect(container.textContent).toContain('Cluster budget');
    expect(container.textContent).toContain('Edge inset budget');
    expect(container.textContent).toContain('Showing');
    // Retired surface elements are gone: part-3 labels, the accordion
    // disclosure, the scope toggle, the edge visibility toggle, captions.
    expect(container.textContent).not.toContain('Visual entity budget');
    expect(container.textContent).not.toContain('Budget details');
    expect(container.textContent).not.toContain('Budget scope');
    expect(container.textContent).not.toContain('Cluster visibility');
    expect(container.textContent).not.toContain('Edge annotations');
    expect(container.textContent).not.toContain('reserved for chains during selection');
    // The falloff radio no longer stands alone here — it moved inside the
    // Proximity slider's unfold in InterestTabSliders (which is mocked out).
    expect(container.textContent).not.toContain('Falloff');
    expect(queryByLabelText('Falloff details')).toBeNull();
  });

  it('reveals the cluster-budget sub-sliders through the inline unfold arrow', () => {
    const { container, getByLabelText } = renderPanel();
    const arrow = getByLabelText('Cluster budget details');
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    // MUI Collapse keeps children mounted, so the labels exist either way —
    // the arrow drives the expanded state, not the mount.
    expect(container.textContent).toContain('Base split size (% of view)');
    expect(container.textContent).toContain('Chain slots (reserved)');

    fireEvent.click(arrow);
    expect(arrow.getAttribute('aria-expanded')).toBe('true');
  });

  it('gives the edge budget slider no unfold arrow', () => {
    const { queryByLabelText } = renderPanel();
    expect(queryByLabelText('Edge inset budget details')).toBeNull();
  });
});
