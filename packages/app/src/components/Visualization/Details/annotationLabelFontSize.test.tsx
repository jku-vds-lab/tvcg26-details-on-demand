// Guard for the oversized low-DoI cluster labels (paper deep-link states):
// node annotation text must NOT scale with cluster member count. The
// count-driven power law (computeScaleFactor) sizes inset bodies only;
// annotation labels use the fixed 18px base × annotationLabelScale, matching
// the inset overlay and edge annotation conventions. Regression shape: large
// annotation-active clusters pinned the font to insetMaxScale (2× at default
// settings) and the stored renderer transform additionally inflated
// globalBoundingBox by scale².
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import store, { RootState } from 'src/store';
import { DefaultDatasetRenderer } from './DefaultDatasetRenderer';
import { RubiksDatasetRenderer } from './Rubiks/RubiksDatasetRenderer';
import type { BaseInsetRenderer } from './BaseInsetRenderer';

const makeSample = (id: number): DataPoint =>
  ({
    x: 0,
    y: 0,
    line: 0,
    id,
    action: 'F',
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    phase: 'solving yellow cross',
    label: 'some label',
  }) as unknown as DataPoint;

const many = (n: number): DataPoint[] =>
  Array.from({ length: n }, (_, i) => makeSample(i + 1));

const fontSizeOf = (jsx: JSX.Element): string => {
  const { container } = render(jsx);
  const text = container.querySelector('text');
  expect(text).not.toBeNull();
  return text!.getAttribute('font-size')!;
};

describe.each<[string, () => BaseInsetRenderer]>([
  ['DefaultDatasetRenderer', () => new DefaultDatasetRenderer()],
  ['RubiksDatasetRenderer', () => new RubiksDatasetRenderer()],
])('%s annotation label size', (_name, make) => {
  it('does not scale node annotation text with member count', () => {
    const renderer = make();
    const annotationLabelScale =
      (store.getState() as RootState).visualizationSettings.annotationLabelScale ?? 1;
    const expected = String(18 * annotationLabelScale);
    expect(fontSizeOf(renderer.renderSingleNodeAnnotation(many(1)))).toBe(expected);
    expect(fontSizeOf(renderer.renderGroupNodeAnnotation(many(100)))).toBe(expected);
  });

  it('stores a unit transform scale for annotation elements', () => {
    const renderer = make();
    renderer.renderGroupNodeAnnotation(many(100));
    expect(renderer.getTransform().scale).toBe(1);
  });
});
