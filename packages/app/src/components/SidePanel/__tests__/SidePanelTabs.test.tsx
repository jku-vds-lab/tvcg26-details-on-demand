/**
 * Unit tests for SidePanelTabs — chrome cleanup (issue #172).
 *
 * Verifies:
 *  1. All four standard tabs (Workflow, Dataset, Vis Encoding, Advanced) are rendered.
 *  2. The old "Appearance" label is NOT present; "Vis Encoding" IS present.
 *  3. Removed hint text strings ("Load and switch data",
 *     "Search, Propagation, Clusters", "Visual encoding tuning",
 *     "Expert cluster controls") are NOT rendered.
 *  4. The Labeling tab is shown when showLabelingTab=true and hidden when false.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { Provider } from 'react-redux';
import store from '../../../store';
import SidePanelTabs from '../SidePanelTabs';

// SidePanelTabs uses useSelector to read sidePanelBgColor; the real store is fine.

const DEFAULT_PROPS = {
  activeTab: 0,
  onTabChange: jest.fn(),
  tabButtonWidth: 92,
  showLabelingTab: false,
};

function renderTabs(overrides: Partial<typeof DEFAULT_PROPS> = {}) {
  const props = { ...DEFAULT_PROPS, ...overrides };
  return render(
    React.createElement(
      Provider,
      {
        store,
        children: React.createElement(SidePanelTabs, props),
      },
    ),
  );
}

// ─── 1. All four standard tabs are rendered ────────────────────────────────────

describe('SidePanelTabs – standard tabs', () => {
  it('renders the Workflow tab', () => {
    renderTabs();
    expect(screen.getByText('Workflow')).toBeTruthy();
  });

  it('renders the Dataset tab', () => {
    renderTabs();
    expect(screen.getByText('Dataset')).toBeTruthy();
  });

  it('renders the Vis Encoding tab', () => {
    renderTabs();
    expect(screen.getByText('Vis Encoding')).toBeTruthy();
  });

  it('renders the Advanced tab', () => {
    renderTabs();
    expect(screen.getByText('Advanced')).toBeTruthy();
  });

  it('renders the Projection tab', () => {
    renderTabs();
    expect(screen.getByText('Projection')).toBeTruthy();
  });

  it('renders exactly 5 tab buttons when showLabelingTab is false', () => {
    renderTabs({ showLabelingTab: false });
    // MUI Tab renders the label as accessible text in a button role.
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
  });
});

// ─── 2. "Appearance" removed; "Vis Encoding" present ─────────────────────────

describe('SidePanelTabs – renamed tab label', () => {
  it('does NOT render "Appearance"', () => {
    renderTabs();
    expect(screen.queryByText('Appearance')).toBeNull();
  });

  it('renders "Vis Encoding" in place of "Appearance"', () => {
    renderTabs();
    expect(screen.getByText('Vis Encoding')).toBeTruthy();
  });
});

// ─── 3. Hint text strings are NOT rendered ─────────────────────────────────────

describe('SidePanelTabs – hint text removed', () => {
  it('does not render "Load and switch data"', () => {
    renderTabs();
    expect(screen.queryByText('Load and switch data')).toBeNull();
  });

  it('does not render "Search, Propagation, Clusters"', () => {
    renderTabs();
    expect(screen.queryByText('Search, Propagation, Clusters')).toBeNull();
  });

  it('does not render "Visual encoding tuning"', () => {
    renderTabs();
    expect(screen.queryByText('Visual encoding tuning')).toBeNull();
  });

  it('does not render "Expert cluster controls"', () => {
    renderTabs();
    expect(screen.queryByText('Expert cluster controls')).toBeNull();
  });

  it('does not render "Assign and export labels"', () => {
    renderTabs({ showLabelingTab: true });
    expect(screen.queryByText('Assign and export labels')).toBeNull();
  });
});

// ─── 4. Labeling tab conditional rendering ────────────────────────────────────

describe('SidePanelTabs – labeling tab visibility', () => {
  it('shows the Labeling tab when showLabelingTab is true', () => {
    renderTabs({ showLabelingTab: true });
    expect(screen.getByText('Labeling')).toBeTruthy();
  });

  it('shows 6 tabs (including Labeling) when showLabelingTab is true', () => {
    renderTabs({ showLabelingTab: true });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
  });

  it('does NOT show the Labeling tab when showLabelingTab is false', () => {
    renderTabs({ showLabelingTab: false });
    expect(screen.queryByText('Labeling')).toBeNull();
  });

  it('shows 5 tabs (no Labeling) when showLabelingTab is false', () => {
    renderTabs({ showLabelingTab: false });
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
  });
});
