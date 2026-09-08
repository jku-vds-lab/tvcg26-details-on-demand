import { describe, expect, it } from '@jest/globals';
import { CartPoleDatasetRenderer } from './CartPoleDatasetRenderer';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';

const makeSample = (): DataPoint => ({
  x: 0,
  y: 0,
  line: 0,
  algo: 'test',
  id: 0,
  action: 'none',
  DoI: 1,
  nextEdgeCenter: { x: 0, y: 0 },
  obs0: 0,
  obs1: 0,
  obs2: 0,
  obs3: 0,
} as unknown as DataPoint);

describe('computeInsetBoundingBox', () => {
  it('scales cartpole image by scaleFactor', () => {
    const renderer = new CartPoleDatasetRenderer();
    const bbox = renderer.computeInsetBoundingBox({
      mode: 'cartpole',
      scaleFactor: 1.5,
    });
    expect(bbox.width).toBeCloseTo(180);
    expect(bbox.height).toBeCloseTo(120);
    expect(bbox.maxX).toBeCloseTo(180);
    expect(bbox.maxY).toBeCloseTo(120);
  });
});

describe('renderSingleNodeInset', () => {
  it('wraps inset with bounding box using computed size', () => {
    const renderer = new CartPoleDatasetRenderer();
    const element = renderer.renderSingleNodeInset([makeSample()]);
    const bbox = renderer.getBoundingBox();
    expect(bbox.width).toBeCloseTo(120);
    expect((element.props as { style: { width: number } }).style.width).toBeCloseTo(bbox.width);
  });
});
