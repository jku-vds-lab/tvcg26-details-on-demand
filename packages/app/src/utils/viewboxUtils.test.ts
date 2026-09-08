// src/utils/viewboxUtils.test.ts
import { describe, expect, it } from '@jest/globals';
import * as d3 from 'd3';
import { zoomIdentity } from 'd3-zoom';
import { computeViewbox, viewboxToTransform } from './viewboxUtils';

function createCanvasContainer(width: number, height: number, includeCanvas = true): HTMLDivElement {
  const container = document.createElement('div');
  if (includeCanvas) {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: width });
    Object.defineProperty(canvas, 'clientHeight', { value: height });
    container.appendChild(canvas);
  }
  return container;
}

describe('computeViewbox', () => {
  it('returns correct data-space bounds for identity zoom', () => {
    const width = 200;
    const height = 100;
    const container = createCanvasContainer(width, height);

    const xScale = d3.scaleLinear().domain([0, 100]).range([0, width]);
    const yScale = d3.scaleLinear().domain([0, 50]).range([0, height]);
    const viewbox = computeViewbox(container, { xScale, yScale }, zoomIdentity);

    expect(viewbox.minX).toBeCloseTo(0);
    expect(viewbox.maxX).toBeCloseTo(100);
    expect(viewbox.minY).toBeCloseTo(50);
    expect(viewbox.maxY).toBeCloseTo(0);
  });

  it('handles reversed domains correctly', () => {
    const width = 100;
    const height = 50;
    const container = createCanvasContainer(width, height);

    // domain reversed: data 100->0 maps to [0,100] pixels
    const xScale = d3.scaleLinear().domain([100, 0]).range([0, width]);
    const yScale = d3.scaleLinear().domain([50, 0]).range([0, height]);
    const viewbox = computeViewbox(container, { xScale, yScale }, zoomIdentity);

    // invert(0) -> 100, invert(width) -> 0
    expect(viewbox.minX).toBeCloseTo(100);
    expect(viewbox.maxX).toBeCloseTo(0);
    expect(viewbox.minY).toBeCloseTo(0);
    expect(viewbox.maxY).toBeCloseTo(50);
  });

  it('throws when no canvas element is found', () => {
    const container = createCanvasContainer(100, 50, false);
    const xScale = d3.scaleLinear().domain([0, 1]).range([0, 1]);
    const yScale = d3.scaleLinear().domain([0, 1]).range([0, 1]);
    expect(() => computeViewbox(container, { xScale, yScale }, zoomIdentity))
      .toThrow('Canvas element not found');
  });

  it('applies non-uniform scale and translate combined', () => {
    const width = 300;
    const height = 150;
    const container = createCanvasContainer(width, height);

    const xScale = d3.scaleLinear().domain([0, 200]).range([0, width]);
    const yScale = d3.scaleLinear().domain([0, 100]).range([0, height]);
    // scaleX 1.5, scaleY 2, translate x=-50px, y=30px
    const zoomTransform = zoomIdentity
      .scale(1.5)
      .translate(-50, 30);

    const viewbox = computeViewbox(container, { xScale, yScale }, zoomTransform);
    // Compute expected manually:
    // k = 1.5; tx = –50 ⇒ xOffset = k*tx = –75px; ty = 30 ⇒ yOffset = k*ty = +45px
    // X:
    //  minX data = xScale.invert((0 – (–75)) / 1.5) = invert(50) = 50/300*200 ≈ 33.33
    //  maxX data = xScale.invert((300 – (–75)) / 1.5) = invert(250) = 250/300*200 ≈ 166.67
    expect(viewbox.minX).toBeCloseTo(33.33, 2);
    expect(viewbox.maxX).toBeCloseTo(166.67, 2);

    // Y:
    //  minY data = yScale.invert((150 – 45) / 1.5) = invert(70)  = 70/150*100 ≈ 46.67
    //  maxY data = yScale.invert((0 – 45)  / 1.5) = invert(–30) = –30/150*100 = –20
    expect(viewbox.minY).toBeCloseTo(46.67, 2);
    expect(viewbox.maxY).toBeCloseTo(-20,   2);

  });
});

describe('viewboxToTransform', () => {
  // App-style scales: y range is inverted ([height, 0]), matching computeScales.
  const makeScales = (width: number, height: number) => ({
    xScale: d3.scaleLinear().domain([-10, 10]).range([0, width]),
    yScale: d3.scaleLinear().domain([-5, 5]).range([height, 0]),
  });

  it.each([0.5, 1, 7, 100])('inverts computeViewbox for k=%p', (k) => {
    const width = 800;
    const height = 600;
    const container = createCanvasContainer(width, height);
    const scales = makeScales(width, height);
    const original = zoomIdentity.translate(37.5 * k, -12.25 * k).scale(k);

    const viewbox = computeViewbox(container, scales, original);
    const recovered = viewboxToTransform(viewbox, scales, width, height);

    expect(recovered).not.toBeNull();
    expect(recovered!.k).toBeCloseTo(original.k, 6);
    expect(recovered!.x).toBeCloseTo(original.x, 6);
    expect(recovered!.y).toBeCloseTo(original.y, 6);
  });

  it('produces minY < maxY orientation with the inverted yScale', () => {
    const width = 400;
    const height = 300;
    const container = createCanvasContainer(width, height);
    const scales = makeScales(width, height);

    const viewbox = computeViewbox(container, scales, zoomIdentity);
    expect(viewbox.minY).toBeLessThan(viewbox.maxY);

    const recovered = viewboxToTransform(viewbox, scales, width, height);
    expect(recovered!.k).toBeCloseTo(1, 6);
  });

  it('contains and centers the viewbox when the aspect ratio changes', () => {
    const scales = makeScales(800, 600);
    const target = { minX: -2, maxX: 2, minY: -1, maxY: 1 };

    // Decode on a wider canvas than the viewbox aspect: fit-min keeps the full
    // y-span visible and centers the x-span.
    const wide = viewboxToTransform(target, scales, 1200, 600);
    expect(wide).not.toBeNull();
    const container = createCanvasContainer(1200, 600);
    const shown = computeViewbox(container, scales, wide!);

    expect(shown.minX).toBeLessThanOrEqual(target.minX + 1e-9);
    expect(shown.maxX).toBeGreaterThanOrEqual(target.maxX - 1e-9);
    expect(shown.minY).toBeCloseTo(target.minY, 6);
    expect(shown.maxY).toBeCloseTo(target.maxY, 6);
    expect((shown.minX + shown.maxX) / 2).toBeCloseTo((target.minX + target.maxX) / 2, 6);
  });

  it('returns null for degenerate inputs', () => {
    const scales = makeScales(800, 600);
    expect(viewboxToTransform({ minX: 1, maxX: 1, minY: 0, maxY: 2 }, scales, 800, 600)).toBeNull();
    expect(viewboxToTransform({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, scales, 0, 600)).toBeNull();
    expect(viewboxToTransform({ minX: NaN, maxX: 1, minY: 0, maxY: 1 }, scales, 800, 600)).toBeNull();
  });
});
