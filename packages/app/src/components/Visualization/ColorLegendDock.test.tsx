import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import ColorLegendDock from './ColorLegendDock';
import {
  clearOpacityClampingPreview,
  setOpacityClampingPreview,
} from '../../stores/opacityClampingPreviewStore';
import store, {
  clearFeatureMetadata,
  initialVisualizationSettings,
  setFeatureMetadata,
  updateSettings,
} from '../../store';
import { colorScale, resetColorScale } from '../../utils/colorScale';
import { recordAllCounts } from '../../utils/colorDiscoveryStore';
import { setLiveSliderSettings } from '../../stores/liveSliderSettingsStore';
import type { SliderSettings } from '../InterestTabSliders';

const sliderSettings: SliderSettings = {
  proximitySlider: 0.1,
  pastSlider: 0.75,
  futureSlider: 0.75,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

const renderLegend = () => {
  // The dock reads live values from the store (issue #330), not props.
  setLiveSliderSettings(sliderSettings);
  return render(
    <Provider store={store}>
      <ColorLegendDock />
    </Provider>
  );
};

describe('ColorLegendDock collapse toggle', () => {
  beforeEach(() => {
    clearOpacityClampingPreview();
    store.dispatch(
      updateSettings({
        colorEncoding: 'algo',
        colorPalette: ['#1b9e77', '#d95f02', '#7570b3'],
      })
    );
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['algo'],
        statsByKey: {
          algo: {
            key: 'algo',
            variableType: 'categorical',
            uniqueCount: 2,
            totalCount: 10,
            numericRatio: 0,
            confidence: 'high',
            categories: [
              { value: 'A', count: 6 },
              { value: 'B', count: 4 },
            ],
          },
        },
      })
    );
  });

  afterEach(() => {
    act(() => {
      clearOpacityClampingPreview();
      store.dispatch(updateSettings(initialVisualizationSettings));
      store.dispatch(clearFeatureMetadata());
    });
  });

  it('collapses and re-expands legend contents on toggle', () => {
    renderLegend();

    expect(screen.getByText('DoI')).toBeTruthy();

    const toggleButton = screen.getByLabelText(/hide legend/i);
    fireEvent.click(toggleButton);

    expect(screen.queryByText('DoI')).toBeNull();

    fireEvent.click(toggleButton);

    expect(screen.getByText('DoI')).toBeTruthy();
  });

  it('updates the opacity gradient while dragging without waiting for commit', () => {
    renderLegend();

    const gradient = screen.getAllByTestId('legend-opacity-gradient')[0];
    const initialGradient = gradient.getAttribute('data-gradient') ?? '';

    act(() => {
      setOpacityClampingPreview({ min: 0.72, max: 0.88 });
    });

    expect(gradient.getAttribute('data-gradient')).not.toBe(initialGradient);
  });
});

const FIVE_COLOR_PALETTE = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00'];

describe('ColorLegendDock category completeness', () => {
  const openingStats = (
    confidence: 'provisional' | 'preliminary' | 'high',
    categories: { value: string; count: number }[]
  ) => ({
    key: 'opening',
    variableType: 'categorical' as const,
    uniqueCount: categories.length,
    totalCount: categories.reduce((s, c) => s + c.count, 0),
    numericRatio: 0,
    confidence,
    categories,
  });

  afterEach(() => {
    clearOpacityClampingPreview();
    store.dispatch(updateSettings(initialVisualizationSettings));
    store.dispatch(clearFeatureMetadata());
    resetColorScale(initialVisualizationSettings.colorPalette);
  });

  it('shows all categories present in stats.categories', () => {
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['opening'],
        statsByKey: {
          opening: openingStats('high', [
            { value: 'Sicilian', count: 20 },
            { value: 'French', count: 20 },
            { value: 'English', count: 20 },
            { value: "King's Indian", count: 20 },
            { value: 'Caro-Kann', count: 20 },
          ]),
        },
      })
    );
    store.dispatch(updateSettings({ colorEncoding: 'opening', colorPalette: FIVE_COLOR_PALETTE }));
    renderLegend();

    expect(screen.getByText('Sicilian')).toBeTruthy();
    expect(screen.getByText('French')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText("King's Indian")).toBeTruthy();
    expect(screen.getByText('Caro-Kann')).toBeTruthy();
  });

  it('adds keys to legend when colorScale discovers them via fallback', () => {
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['opening'],
        statsByKey: {
          opening: openingStats('preliminary', [
            { value: 'Sicilian', count: 20 },
            { value: 'French', count: 20 },
            { value: 'English', count: 20 },
          ]),
        },
      })
    );
    store.dispatch(updateSettings({ colorEncoding: 'opening', colorPalette: FIVE_COLOR_PALETTE }));
    // Rebuild colorScale with current Redux state so mapping starts clean.
    resetColorScale(FIVE_COLOR_PALETTE);
    renderLegend();

    expect(screen.queryByText('Caro-Kann')).toBeNull();
    expect(screen.queryByText("King's Indian")).toBeNull();

    act(() => {
      colorScale('Caro-Kann');
      colorScale("King's Indian");
    });

    expect(screen.getByText('Caro-Kann')).toBeTruthy();
    expect(screen.getByText("King's Indian")).toBeTruthy();
  });

  it('never shows a scanning indicator regardless of confidence level', () => {
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['opening'],
        statsByKey: {
          opening: openingStats('preliminary', [{ value: 'Sicilian', count: 20 }]),
        },
      })
    );
    store.dispatch(updateSettings({ colorEncoding: 'opening', colorPalette: FIVE_COLOR_PALETTE }));
    renderLegend();

    expect(screen.queryByText(/scanning/i)).toBeNull();
  });

  it('displays WebGL-provided counts instead of scan counts when available', () => {
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['opening'],
        statsByKey: {
          opening: openingStats('high', [
            { value: 'Sicilian', count: 3 },
            { value: 'French', count: 5 },
          ]),
        },
      })
    );
    store.dispatch(updateSettings({ colorEncoding: 'opening', colorPalette: FIVE_COLOR_PALETTE }));
    renderLegend();

    // Scan counts shown before WebGL push
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();

    act(() => {
      recordAllCounts({ Sicilian: 120, French: 80 });
    });

    // WebGL counts replace scan counts
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('80')).toBeTruthy();
  });
});
