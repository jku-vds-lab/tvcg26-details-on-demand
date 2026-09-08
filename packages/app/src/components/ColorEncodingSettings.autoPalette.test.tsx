import { beforeEach, describe, expect, it } from '@jest/globals';
import { act, render } from '@testing-library/react';
import React from 'react';
import { Provider } from 'react-redux';

import store, {
    clearFeatureMetadata,
    initialVisualizationSettings,
    setFeatureMetadata,
    updateSettings,
} from '../store';
import ColorEncodingSettings from './ColorEncodingSettings';

describe('ColorEncodingSettings auto-palette behavior', () => {
  beforeEach(() => {
    store.dispatch(updateSettings(initialVisualizationSettings));
    store.dispatch(clearFeatureMetadata());
  });

  it('does not override externally-set dataset palette when feature metadata arrives', () => {
    const datasetPalette = ['#101010', '#202020', '#303030', '#404040'];

    store.dispatch(
      updateSettings({
        colorEncoding: 'line',
        colorPalette: datasetPalette,
      })
    );

    render(
      <Provider store={store}>
        <ColorEncodingSettings nested hideAccordion />
      </Provider>
    );

    expect(store.getState().visualizationSettings.colorPalette).toEqual(datasetPalette);

    act(() => {
      store.dispatch(
        setFeatureMetadata({
          availableKeys: ['line'],
          statsByKey: {
            line: {
              key: 'line',
              variableType: 'categorical',
              confidence: 'high',
              uniqueCount: 6,
              totalCount: 100,
              numericRatio: 0,
              categories: [
                { value: 'A', count: 20 },
                { value: 'B', count: 20 },
                { value: 'C', count: 20 },
                { value: 'D', count: 20 },
                { value: 'E', count: 10 },
                { value: 'F', count: 10 },
              ],
            },
          },
        })
      );
    });

    expect(store.getState().visualizationSettings.colorPalette).toEqual(datasetPalette);
  });
});
