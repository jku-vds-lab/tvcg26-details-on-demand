/**
 * Color-scale rebuild notification (issue #315 dataset-switch recolor,
 * 2026-08-05): when stats land for the CURRENT encoding — the dataset-switch
 * case where both datasets share the encoding key ("algo") — the scale
 * rebuilds with a re-sorted category → palette-slot mapping, and every GPU
 * color buffer built before it is stale. The renderer recolors through
 * `onColorScaleRebuild`; without the notification the scatter keeps the
 * previous dataset's mapping while the legend shows the new one (the
 * "Set2 selected but way brighter" bug).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import store, { updateSettings } from '../store';
import { setFeatureMetadata, type FeatureStats } from '../slices/datasetFeatures';
import { colorScale, onColorScaleRebuild, resetColorScale } from './colorScale';

const catStats = (values: string[]): FeatureStats => ({
  key: 'algo',
  variableType: 'categorical',
  uniqueCount: values.length,
  totalCount: values.length,
  numericRatio: 0,
  confidence: 'high',
  categories: values.map((value) => ({ value, count: 1 })),
});

describe('onColorScaleRebuild', () => {
  beforeEach(() => {
    store.dispatch(updateSettings({ colorEncoding: 'algo' }));
    store.dispatch(setFeatureMetadata({ availableKeys: [], statsByKey: {} }));
  });

  it('notifies when stats for the current encoding change the mapping', () => {
    const listener = jest.fn();
    const off = onColorScaleRebuild(listener);
    try {
      store.dispatch(
        setFeatureMetadata({
          availableKeys: ['algo'],
          statsByKey: { algo: catStats(['A', 'B', 'C']) },
        })
      );
      expect(listener).toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('notifies on resetColorScale (dataset load)', () => {
    const listener = jest.fn();
    const off = onColorScaleRebuild(listener);
    try {
      resetColorScale(['#111111', '#222222']);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('rebuilt scale maps categories by the NEW stats, and unsubscribe works', () => {
    const listener = jest.fn();
    const off = onColorScaleRebuild(listener);
    const palette = ['#aa0000', '#00aa00', '#0000aa'];
    // Through the store, so the subscription's rebuilds use the same palette.
    store.dispatch(updateSettings({ colorPalette: palette }));
    listener.mockClear();

    // Old dataset's stats: two categories occupy slots 0/1.
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['algo'],
        statsByKey: { algo: catStats(['beginner', 'fridrich']) },
      })
    );
    expect(listener).toHaveBeenCalled();
    expect(colorScale('beginner')).toBe('#aa0000');

    // New dataset's stats land for the SAME encoding: mapping re-sorts from
    // scratch — 'A' takes slot 0 in the rebuilt scale.
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['algo'],
        statsByKey: { algo: catStats(['A', 'B']) },
      })
    );
    expect(colorScale('A')).toBe('#aa0000');

    off();
    listener.mockClear();
    resetColorScale(palette);
    expect(listener).not.toHaveBeenCalled();
  });
});
