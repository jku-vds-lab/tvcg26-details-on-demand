/**
 * Missing-feature UX (issue #315 color-by): when no color feature is
 * selected (the validated state for datasets lacking their preset's column,
 * e.g. "algo" on synth1m) the palette section is INERT — clicking a
 * recommended palette must not change the active palette, and the panel
 * says why. With a real feature selected everything stays clickable.
 */

import { beforeEach, describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { Provider } from 'react-redux';

import store, {
  clearFeatureMetadata,
  initialVisualizationSettings,
  setFeatureMetadata,
  updateSettings,
} from '../store';
import ColorEncodingSettings from './ColorEncodingSettings';

const renderPanel = () =>
  render(
    <Provider store={store}>
      <ColorEncodingSettings nested hideAccordion />
    </Provider>
  );

const rewardStats = () => ({
  availableKeys: ['reward'],
  statsByKey: {
    reward: {
      key: 'reward',
      variableType: 'sequential' as const,
      confidence: 'high' as const,
      uniqueCount: 100,
      totalCount: 1000,
      numericRatio: 1,
      min: 0,
      max: 10,
    },
  },
});

beforeEach(() => {
  store.dispatch(updateSettings(initialVisualizationSettings));
  store.dispatch(clearFeatureMetadata());
});

describe('ColorEncodingSettings — missing feature / no selection', () => {
  it('grays palettes out and blocks clicks when no feature is selected', () => {
    store.dispatch(updateSettings({ colorEncoding: '' }));
    store.dispatch(setFeatureMetadata(rewardStats()));
    renderPanel();

    expect(screen.getByText('Select a color feature above to enable palettes.')).toBeTruthy();
    expect(
      screen.getByText('No color feature selected — points use a single color.')
    ).toBeTruthy();

    const before = store.getState().visualizationSettings.colorPalette;
    fireEvent.click(screen.getByText(/Blues \(/));
    expect(store.getState().visualizationSettings.colorPalette).toEqual(before);
  });

  it('names a typed feature the dataset does not have', () => {
    store.dispatch(updateSettings({ colorEncoding: 'algo' }));
    store.dispatch(setFeatureMetadata(rewardStats()));
    renderPanel();

    expect(screen.getByText('"algo" is not a feature of this dataset.')).toBeTruthy();
  });

  it('keeps palettes clickable for a real feature', () => {
    store.dispatch(updateSettings({ colorEncoding: 'reward' }));
    store.dispatch(setFeatureMetadata(rewardStats()));
    renderPanel();

    const before = store.getState().visualizationSettings.colorPalette;
    fireEvent.click(screen.getByText(/Greens \(/));
    expect(store.getState().visualizationSettings.colorPalette).not.toEqual(before);
  });
});
