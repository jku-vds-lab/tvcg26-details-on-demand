// __tests__/VisualElement.test.ts
import { beforeEach, describe, expect, it } from '@jest/globals';
import { scaleLinear } from 'd3-scale';
import { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import {
  LeaderLineGeometry,
  VisualElement,
  VisualElementType,
  makeElementId,
} from './VisualElement';

describe('VisualElement.getLeaderLineGeometry', () => {
  let xScale: d3.ScaleLinear<number, number>;
  let yScale: d3.ScaleLinear<number, number>;
  let el: VisualElement;

  // minimal DataPoint stub
  const makePoint = (x: number, y: number): DataPoint => ({
    x,
    y,
    line: 0,
    algo: 'test',
    id: 0,
    action: 'none',
    DoI: 1,
    nextEdgeCenter: { x, y },
  });

  beforeEach(() => {
    xScale = scaleLinear().domain([0, 1]).range([0, 100]);
    yScale = scaleLinear().domain([0, 1]).range([0, 100]);

    el = new VisualElement(
      makeElementId('node', VisualElementType.Annotation, 'test'),
      'node',
      VisualElementType.Annotation,
      1, // temperature
      0, // movement
      'dummy',
      [makePoint(0, 0), makePoint(1, 1)]
    );

    // fix positions for test
    el.sourcePosition = { x: 0.2, y: 0.3 };
    el.center = { x: 0.8, y: 0.7 };
  });

  it('maps sourcePosition and center through zoomed scales', () => {
    const geom: LeaderLineGeometry = el.getLeaderLineGeometry(xScale, yScale);

    expect(geom.x1).toBeCloseTo(20);
    expect(geom.y1).toBeCloseTo(30);
    expect(geom.x2).toBeCloseTo(80);
    expect(geom.y2).toBeCloseTo(70);
  });

  it('is unaffected by CSS scale (invk) changes', () => {
    el.setCssScale(0.5);
    const geom1 = el.getLeaderLineGeometry(xScale, yScale);

    el.setCssScale(2);
    const geom2 = el.getLeaderLineGeometry(xScale, yScale);

    expect(geom1).toEqual(geom2);
  });

  describe('getScreenVisualBoundingBoxFor', () => {
    const box = { x: 0, y: 0, width: 100, height: 50, minX: 0, minY: 0, maxX: 100, maxY: 50 };

    it('centers the visual bbox at the given position, scaled by invk', () => {
      el.renderer.setBoundingBox(box); // no overlay → visual bbox falls back to layout bbox
      el.setCssScale(2);
      const b = el.getScreenVisualBoundingBoxFor({ x: 0.5, y: 0.5 }, xScale, yScale);
      expect(b.width).toBeCloseTo(200);
      expect(b.height).toBeCloseTo(100);
      expect(b.x).toBeCloseTo(50 - 100); // centered at screen (50,50)
      expect(b.y).toBeCloseTo(50 - 50);
    });

    it('prefers an explicit cssScale over the stale stored field (issue #345)', () => {
      el.renderer.setBoundingBox(box);
      el.setCssScale(1); // stale: the corrective effect has not run for the new zoom yet
      const b = el.getScreenVisualBoundingBoxFor({ x: 0.5, y: 0.5 }, xScale, yScale, 1, 0.5);
      expect(b.width).toBeCloseTo(50);
      expect(b.height).toBeCloseTo(25);
      expect(b.x + b.width / 2).toBeCloseTo(50);
      expect(b.y + b.height / 2).toBeCloseTo(50);
    });

    it('applies extraScale (hover growth) around the same center', () => {
      el.renderer.setBoundingBox(box);
      el.setCssScale(1);
      const b = el.getScreenVisualBoundingBoxFor({ x: 0.5, y: 0.5 }, xScale, yScale, 1.5);
      expect(b.width).toBeCloseTo(150);
      expect(b.height).toBeCloseTo(75);
      expect(b.x + b.width / 2).toBeCloseTo(50);
      expect(b.y + b.height / 2).toBeCloseTo(50);
    });
  });
});
