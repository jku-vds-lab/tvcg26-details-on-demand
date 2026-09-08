/**
 * Guards the colorScale ↔ colorDiscoveryStore reset interplay (chess40k
 * legend bug): a feature-signature-only stats refinement must NOT wipe
 * discovered keys or full-dataset counts, because nothing recolors after the
 * final idle-priority stats dispatch — a wipe there permanently drops legend
 * rows for category values that only occur past the 20k stats scan cap.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import store, {
  clearFeatureMetadata,
  initialVisualizationSettings,
  setFeatureMetadata,
  updateSettings,
} from '../store';
import { colorScale, resetColorScale } from './colorScale';
import { colorDiscoveryStore, recordAllCounts } from './colorDiscoveryStore';

const PALETTE = ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00'];
const OTHER_PALETTE = ['#1b9e77', '#d95f02', '#7570b3'];

/** Mirrors the chess40k `algo` stats as the 20k-capped scan sees them. */
const algoStats = (opts: {
  confidence: 'provisional' | 'preliminary' | 'high';
  categories: { value: string; count: number }[];
  min?: number;
  max?: number;
  hasPositive?: boolean;
}) => ({
  key: 'algo',
  variableType: 'categorical' as const,
  uniqueCount: opts.categories.length,
  totalCount: opts.categories.reduce((s, c) => s + c.count, 0),
  numericRatio: 1,
  hasNegative: false,
  hasPositive: opts.hasPositive ?? false,
  confidence: opts.confidence,
  categories: opts.categories,
  ...(opts.min !== undefined ? { min: opts.min } : {}),
  ...(opts.max !== undefined ? { max: opts.max } : {}),
});

const dispatchAlgoStats = (stats: ReturnType<typeof algoStats>) => {
  store.dispatch(
    setFeatureMetadata({ availableKeys: ['algo'], statsByKey: { algo: stats } })
  );
};

describe('colorScale discovery reset interplay', () => {
  beforeEach(() => {
    store.dispatch(updateSettings({ colorEncoding: 'algo', colorPalette: PALETTE }));
    dispatchAlgoStats(
      algoStats({ confidence: 'preliminary', categories: [{ value: '0', count: 200 }], min: 0, max: 0 })
    );
    // Clean slate equivalent to a fresh dataset load.
    resetColorScale(PALETTE);
  });

  afterEach(() => {
    store.dispatch(updateSettings(initialVisualizationSettings));
    store.dispatch(clearFeatureMetadata());
    resetColorScale(initialVisualizationSettings.colorPalette);
  });

  it('keeps discovered keys and counts across a feature-signature-only stats refinement', () => {
    // Renderer colors the full dataset during progressive load: values 1 and 2
    // are not in the capped stats.categories, so the fallback discovers them.
    colorScale(1);
    colorScale(2);
    recordAllCounts({ '0': 12823, '1': 13874, '2': 12540 });
    expect(colorDiscoveryStore.getKeys()).toEqual(['1', '2']);

    // The idle high-confidence dispatch refines min/max/hasPositive of the
    // same feature (the 20k scan finally saw value 1) — signature changes.
    dispatchAlgoStats(
      algoStats({
        confidence: 'high',
        categories: [
          { value: '0', count: 12823 },
          { value: '1', count: 7177 },
        ],
        min: 0,
        max: 1,
        hasPositive: true,
      })
    );

    expect(colorDiscoveryStore.getKeys()).toEqual(['1', '2']);
    expect(colorDiscoveryStore.getCounts()).toEqual({ '0': 12823, '1': 13874, '2': 12540 });
  });

  it('still rebuilds the scale mapping from refreshed categories on a signature-only change', () => {
    colorScale(2);
    dispatchAlgoStats(
      algoStats({
        confidence: 'high',
        categories: [
          { value: '0', count: 12823 },
          { value: '1', count: 7177 },
        ],
        min: 0,
        max: 1,
        hasPositive: true,
      })
    );

    // New scale is seeded from the refreshed categories: 0 and 1 take palette
    // slots 0 and 1, so a later re-discovery of 2 lands on slot 2.
    expect(colorScale(0)).toBe(PALETTE[0]);
    expect(colorScale(1)).toBe(PALETTE[1]);
    expect(colorScale(2)).toBe(PALETTE[2]);
  });

  it('wipes discovery when the color encoding changes', () => {
    colorScale(2);
    recordAllCounts({ '0': 1, '2': 1 });
    expect(colorDiscoveryStore.getKeys()).toEqual(['2']);

    store.dispatch(updateSettings({ colorEncoding: 'cp' }));

    expect(colorDiscoveryStore.getKeys()).toEqual([]);
    expect(colorDiscoveryStore.getCounts()).toEqual({});
  });

  it('wipes discovery when the palette changes', () => {
    colorScale(2);
    recordAllCounts({ '0': 1, '2': 1 });
    expect(colorDiscoveryStore.getKeys()).toEqual(['2']);

    store.dispatch(updateSettings({ colorPalette: OTHER_PALETTE }));

    expect(colorDiscoveryStore.getKeys()).toEqual([]);
    expect(colorDiscoveryStore.getCounts()).toEqual({});
  });

  it('recounting after an explicit reset restores full-data counts without fabricating keys', () => {
    colorScale(2);
    recordAllCounts({ '0': 12823, '1': 13874, '2': 12540 });

    // Explicit dataset-load reset wipes everything…
    resetColorScale(PALETTE);
    expect(colorDiscoveryStore.getKeys()).toEqual([]);
    expect(colorDiscoveryStore.getCounts()).toEqual({});

    // …then the renderer's count+color passes re-derive both.
    recordAllCounts({ '0': 12823, '1': 13874, '2': 12540 });
    colorScale(1);
    colorScale(2);
    expect(colorDiscoveryStore.getKeys()).toEqual(['1', '2']);
    expect(colorDiscoveryStore.getCounts()).toEqual({ '0': 12823, '1': 13874, '2': 12540 });
  });
});
