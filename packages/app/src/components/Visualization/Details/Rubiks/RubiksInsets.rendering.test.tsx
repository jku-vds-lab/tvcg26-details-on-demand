// Regression tests for issue #232: Rubik's insets flickered on weaker GPU/browser
// stacks. Round 1 removed duplicated-id SVG <filter> glows; round 2 replaced the
// SVG rendering entirely with a supersampled canvas bitmap (drawn once per data
// change) because per-frame vector re-rasterization of the sub-pixel sticker grid
// still shimmered under the animated fractional --invk transform. These tests pin
// the structural invariants: canvas output, supersampled internal resolution, no
// SVG filter primitives, no duplicate ids.
import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import RubiksCubeInset from './RubiksCubeInset';
import RubiksEdgeDiffInset from './RubiksEdgeDiffInset';
import RubiksEdgeSingleInset from './RubiksEdgeSingleInset';
import { RUBIKS_SUPERSAMPLE } from './rubiksCanvasDraw';
import { faces } from './rubiksUtils';

const FACE_COLORS: Record<string, string> = {
  up: 'W',
  left: 'O',
  front: 'G',
  right: 'R',
  down: 'Y',
  back: 'B',
};

const makeSample = (id: number): DataPoint => {
  const p: Record<string, unknown> = {
    x: 0,
    y: 0,
    line: 0,
    algo: 'test',
    id,
    action: 'F',
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
  };
  for (const face of faces) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        p[`${face}${i}${j}`] = FACE_COLORS[face];
      }
    }
  }
  return p as unknown as DataPoint;
};

const renderAllInsets = () =>
  render(
    <div>
      <RubiksCubeInset clusterSamples={[makeSample(1)]} scaleFactor={1} samplesSig="cube-a" />
      <RubiksCubeInset clusterSamples={[makeSample(2)]} scaleFactor={1} samplesSig="cube-b" />
      <RubiksEdgeDiffInset
        startSamples={[makeSample(3)]}
        endSamples={[makeSample(4)]}
        scaleFactor={1}
        samplesSig="diff-a::diff-b"
      />
      <RubiksEdgeSingleInset clusterSamples={[makeSample(5)]} scaleFactor={1} samplesSig="single-a" />
    </div>
  );

describe('Rubiks insets rendering (issue #232)', () => {
  it('renders a canvas per inset, no SVG at all', () => {
    const { container } = renderAllInsets();
    expect(container.querySelectorAll('canvas')).toHaveLength(4);
    expect(container.querySelectorAll('svg')).toHaveLength(0);
  });

  it('renders no SVG <filter> primitives', () => {
    const { container } = renderAllInsets();
    expect(
      container.querySelectorAll('defs, filter, feGaussianBlur, feFlood, feComposite, feMerge')
    ).toHaveLength(0);
  });

  it('renders no duplicate element ids across multiple instances', () => {
    const { container } = renderAllInsets();
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('supersamples the internal bitmap relative to the CSS size', () => {
    const { container } = renderAllInsets();
    for (const canvas of Array.from(container.querySelectorAll('canvas'))) {
      const cssWidth = parseFloat(canvas.style.width);
      expect(cssWidth).toBeGreaterThan(0);
      expect(canvas.width).toBe(Math.round(cssWidth * RUBIKS_SUPERSAMPLE));
    }
  });
});
