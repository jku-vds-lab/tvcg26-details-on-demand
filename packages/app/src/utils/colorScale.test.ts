import { describe, expect, it, beforeEach } from '@jest/globals';
import store, {
  clearFeatureMetadata,
  initialVisualizationSettings,
  setFeatureMetadata,
  updateSettings,
} from '../store';
import { createColorScale } from './colorScale';

// Blues 9-stop from colorbrewer (light → dark)
const BLUES_9 = [
  '#f7fbff',
  '#deebf7',
  '#c6dbef',
  '#9ecae1',
  '#6baed6',
  '#4292c6',
  '#2171b5',
  '#08519c',
  '#08306b',
];

// Dark2 8-stop (qualitative)
const DARK2_8 = [
  '#1b9e77',
  '#d95f02',
  '#7570b3',
  '#e7298a',
  '#66a61e',
  '#e6ab02',
  '#a6761d',
  '#666666',
];

function setupSequentialEncoding(min: number, max: number) {
  store.dispatch(
    updateSettings({ colorEncoding: 'reward', colorPalette: BLUES_9, colorMapRotationOffset: 0 })
  );
  store.dispatch(
    setFeatureMetadata({
      availableKeys: ['reward'],
      statsByKey: {
        reward: {
          key: 'reward',
          variableType: 'sequential',
          uniqueCount: 100,
          totalCount: 1000,
          numericRatio: 1,
          min,
          max,
          hasNegative: false,
          hasPositive: true,
          confidence: 'high',
        },
      },
    })
  );
}

describe('createColorScale — sequential domain', () => {
  beforeEach(() => {
    store.dispatch(updateSettings(initialVisualizationSettings));
    store.dispatch(clearFeatureMetadata());
  });

  it('maps minimum value to the first palette color', () => {
    setupSequentialEncoding(0, 1);
    const scale = createColorScale(BLUES_9);
    expect(scale(0)).toBe(BLUES_9[0]);
  });

  it('maps maximum value to the last palette color', () => {
    setupSequentialEncoding(0, 1);
    const scale = createColorScale(BLUES_9);
    // Core regression for issue #188: value=1 must not wrap back to white.
    expect(scale(1)).toBe(BLUES_9[BLUES_9.length - 1]);
  });

  it('maps the midpoint to an intermediate color', () => {
    setupSequentialEncoding(0, 1);
    const scale = createColorScale(BLUES_9);
    const mid = scale(0.5);
    expect(mid).not.toBe(BLUES_9[0]);
    expect(mid).not.toBe(BLUES_9[BLUES_9.length - 1]);
  });

  it('maps maximum value to last color regardless of non-zero rotation offset', () => {
    // Regression: rotation offset must not affect sequential interpolation
    // when the palette has already been rotated (issue #188 root cause).
    const rotatedBlues = [...BLUES_9.slice(1), BLUES_9[0]]; // rotated by 1
    store.dispatch(
      updateSettings({ colorEncoding: 'reward', colorPalette: rotatedBlues, colorMapRotationOffset: 1 })
    );
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['reward'],
        statsByKey: {
          reward: {
            key: 'reward',
            variableType: 'sequential',
            uniqueCount: 100,
            totalCount: 1000,
            numericRatio: 1,
            min: 0,
            max: 1,
            hasNegative: false,
            hasPositive: true,
            confidence: 'high',
          },
        },
      })
    );
    const scale = createColorScale(rotatedBlues);
    // With a rotated palette the last element is the original first color (white).
    // The samplePalette guard ensures we explicitly return palette[length-1].
    expect(scale(1)).toBe(rotatedBlues[rotatedBlues.length - 1]);
  });

  it('values beyond max are clamped to the last color', () => {
    setupSequentialEncoding(0, 0.9);
    const scale = createColorScale(BLUES_9);
    expect(scale(1.0)).toBe(BLUES_9[BLUES_9.length - 1]);
  });

  it('values below min are clamped to the first color', () => {
    setupSequentialEncoding(0.1, 1);
    const scale = createColorScale(BLUES_9);
    expect(scale(0)).toBe(BLUES_9[0]);
  });

  it('falls back to modular index for categorical features', () => {
    store.dispatch(
      updateSettings({ colorEncoding: 'algo', colorPalette: DARK2_8, colorMapRotationOffset: 0 })
    );
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['algo'],
        statsByKey: {
          algo: {
            key: 'algo',
            variableType: 'categorical',
            uniqueCount: 3,
            totalCount: 100,
            numericRatio: 0,
            confidence: 'high',
          },
        },
      })
    );
    const scale = createColorScale(DARK2_8);
    expect(scale('A')).toBe(DARK2_8[0]);
    expect(scale('B')).toBe(DARK2_8[1]);
    expect(scale('A')).toBe(DARK2_8[0]); // stable second lookup
  });

  it('assigns colors in sorted category order to match the legend (issue #198)', () => {
    // " end" sorts before " start" (e < s), so legend assigns palette[0] to " end".
    // The renderer must use the same order regardless of data encounter order.
    store.dispatch(
      updateSettings({ colorEncoding: 'cp', colorPalette: DARK2_8, colorMapRotationOffset: 0 })
    );
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ['cp'],
        statsByKey: {
          cp: {
            key: 'cp',
            variableType: 'categorical',
            uniqueCount: 2,
            totalCount: 100,
            numericRatio: 0,
            confidence: 'high',
            categories: [
              { value: ' start', count: 50 },
              { value: ' end', count: 50 },
            ],
          },
        },
      })
    );
    const scale = createColorScale(DARK2_8);
    // Query " start" first (data-encounter order) — should still get palette[1]
    expect(scale(' start')).toBe(DARK2_8[1]);
    expect(scale(' end')).toBe(DARK2_8[0]);
  });
});
