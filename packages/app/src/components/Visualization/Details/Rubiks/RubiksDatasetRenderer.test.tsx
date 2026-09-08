// Guard for issue #256: Rubik's node insets label clusters from the solve-phase
// column ("phase", e.g. "solving yellow cross") instead of the coarse "cp"
// column whose majority vote collapsed to "intermediate +" on nearly every
// cluster. The runtime AnnotationLabelSettings override still applies on top.
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import { RubiksDatasetRenderer } from './RubiksDatasetRenderer';

const makeSample = (id: number, phase: string, cp: string): DataPoint =>
  ({
    x: 0,
    y: 0,
    line: 0,
    algo: 'beginner',
    id,
    action: 'F',
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    phase,
    cp,
  }) as unknown as DataPoint;

describe('RubiksDatasetRenderer node labels', () => {
  it('majority-votes the phase column, not cp', () => {
    const renderer = new RubiksDatasetRenderer();
    const samples = [
      makeSample(1, 'solving yellow cross', ' intermediate'),
      makeSample(2, 'solving yellow cross', ' checkpoint'),
      makeSample(3, 'solving first two layers', ' intermediate'),
    ];
    const { container } = render(renderer.renderGroupNodeAnnotation(samples));
    expect(container.textContent).toContain('solving yellow cross +');
    expect(container.textContent).not.toContain('intermediate');
  });

  it('renders a homogeneous phase without the "+" suffix', () => {
    const renderer = new RubiksDatasetRenderer();
    const samples = [
      makeSample(1, 'orienting last layer (OLL)', ' intermediate'),
      makeSample(2, 'orienting last layer (OLL)', ' intermediate'),
    ];
    const { container } = render(renderer.renderGroupNodeAnnotation(samples));
    expect(container.textContent).toContain('orienting last layer (OLL)');
    expect(container.textContent).not.toContain('+');
  });
});
