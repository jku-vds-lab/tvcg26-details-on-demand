/**
 * computeScales columnar fast path (issue #315 R1a, census A13): on a
 * column-backed canonical array the x/y extents come from the mirrored
 * typed columns — same comparisons in the same index order, so the scales
 * must be bit-identical to the row-walk path. The row path stays for
 * non-column-backed arrays (uploads, legacy JSON).
 */

import { describe, expect, it, jest } from '@jest/globals';

// Mock rbush (ESM) to avoid transform issues in Jest (pulled in via
// dataPreprocessing).
jest.mock('rbush', () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

import type { DataPoint } from '../dataPreprocessing/dataPreprocessing';
import { createEmptyDataPoint } from '../dataPreprocessing/dataPreprocessing';
import { attachPointColumns, columnsOf } from '../dataPreprocessing/pointColumns';
import { computeScales } from './computeScales';

const POINTS = [
  { x: 0.13, y: 0.91 },
  { x: -2.4, y: 0.11 },
  { x: 7.25, y: -3.5 },
  { x: 0.5, y: 4.75 },
  { x: -0.01, y: 0.0 },
];

function makeNodes(): DataPoint[] {
  return POINTS.map((p, i) => ({
    ...createEmptyDataPoint(),
    x: p.x,
    y: p.y,
    id: i + 1,
    line: 0,
    DoI: 1,
  }));
}

function scaleSignature(s: ReturnType<typeof computeScales>) {
  return {
    xDomain: s.xScale.domain(),
    xRange: s.xScale.range(),
    yDomain: s.yScale.domain(),
    yRange: s.yScale.range(),
  };
}

describe('computeScales columnar fast path (issue #315 R1a A13)', () => {
  it('is bit-identical between the column and row paths', () => {
    const rowNodes = makeNodes();
    const colNodes = makeNodes();
    attachPointColumns(colNodes);
    expect(columnsOf(colNodes)).not.toBeNull();
    expect(columnsOf(rowNodes)).toBeNull();

    const fromRows = computeScales(800, 600, rowNodes, 10);
    const fromCols = computeScales(800, 600, colNodes, 10);
    expect(scaleSignature(fromCols)).toEqual(scaleSignature(fromRows));
  });

  it('keeps the row path working for plain arrays', () => {
    const { xScale, yScale } = computeScales(800, 600, makeNodes(), 10);
    expect(xScale.domain()).toEqual([-2.4, 7.25]);
    expect(yScale.domain()).toEqual([-3.5, 4.75]);
    // y-range inverted for canvas coordinates.
    const [y0, y1] = yScale.range();
    expect(y0).toBeGreaterThan(y1);
  });
});
