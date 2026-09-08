import { describe, expect, it } from '@jest/globals';

import { getDatasetVisualPreset } from './datasetVisualPresets';

const SET2_8 = [
  '#66c2a5',
  '#fc8d62',
  '#8da0cb',
  '#e78ac3',
  '#a6d854',
  '#ffd92f',
  '#e5c494',
  '#b3b3b3',
];

const SET2_8_ROT_1 = [
  '#fc8d62',
  '#8da0cb',
  '#e78ac3',
  '#a6d854',
  '#ffd92f',
  '#e5c494',
  '#b3b3b3',
  '#66c2a5',
];

const SET3_10 = [
  '#8dd3c7',
  '#ffffb3',
  '#bebada',
  '#fb8072',
  '#80b1d3',
  '#fdb462',
  '#b3de69',
  '#fccde5',
  '#d9d9d9',
  '#bc80bd',
];

describe('dataset visual presets', () => {
  it('uses Set2(8) with rotation=1 for rubik', () => {
    const preset = getDatasetVisualPreset({ datasetType: 'rubik' });
    expect(preset.colorEncoding).toBe('algo');
    expect(preset.colorMapRotationOffset).toBe(1);
    expect(preset.colorPalette).toEqual(SET2_8_ROT_1);
  });

  it('uses Set3(10) with rotation=0 for mnist', () => {
    const preset = getDatasetVisualPreset({ datasetType: 'mnist' });
    expect(preset.colorEncoding).toBe('label');
    expect(preset.colorMapRotationOffset).toBe(0);
    expect(preset.colorPalette).toEqual(SET3_10);
  });

  it('uses Set2(8) with rotation=1 for default/paper datasets', () => {
    const preset = getDatasetVisualPreset({ datasetType: 'default' });
    expect(preset.colorEncoding).toBe('algo');
    expect(preset.colorMapRotationOffset).toBe(1);
    expect(preset.colorPalette).toEqual(SET2_8_ROT_1);
  });

  it('uses Set2(8) with rotation=0 and algo encoding for chess', () => {
    const preset = getDatasetVisualPreset({ datasetType: 'chess' });
    expect(preset.colorEncoding).toBe('algo');
    expect(preset.colorMapRotationOffset).toBe(0);
    expect(preset.colorPalette).toEqual(SET2_8);
  });

  it('applies the oversized default-type marks only to predefined catalog datasets', () => {
    // Toy catalog entries keep the big marks…
    const predefined = getDatasetVisualPreset({ datasetType: 'default', datasetPath: 'data/cube100x2.json.gz' });
    expect(predefined.nodeRadius).toBe(25);
    expect(predefined.edgeWidth).toBe(10);
    expect(predefined.arrowScale).toBe(20);
    // …but user data (widget bootstrap: no path; uploads: "upload:" paths)
    // keeps the base sizes.
    expect(getDatasetVisualPreset({ datasetType: 'default' }).nodeRadius).toBe(5);
    expect(getDatasetVisualPreset({ datasetType: 'default', datasetPath: 'upload:iris.csv' }).nodeRadius).toBe(5);
    // …and so do the default-typed synthetic scaling smoke tests (#315):
    // 250k–1M points must not inherit the toy edge/arrow sizes.
    const synth = getDatasetVisualPreset({ datasetType: 'default', datasetPath: 'data/synth1m/manifest.json' });
    expect(synth.nodeRadius).toBe(5);
    expect(synth.edgeWidth).toBe(1);
    expect(synth.arrowScale).toBe(6);
  });

  it('uses Set3(10) with rotation=0 for cctv', () => {
    const preset = getDatasetVisualPreset({ datasetType: 'cctv' });
    expect(preset.colorEncoding).toBe('line');
    expect(preset.colorMapRotationOffset).toBe(0);
    expect(preset.colorPalette).toEqual(SET3_10);
  });
});
