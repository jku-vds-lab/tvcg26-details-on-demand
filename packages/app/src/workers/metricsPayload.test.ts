/**
 * Metrics-worker payload codec (issue #315 R1a, census A5): column-backed
 * canonical arrays ship transferable x/y COPIES; plain arrays keep the
 * legacy {x,y}[] shape. Either payload must decode to the identical point
 * view, and the copies must be independent of the live columns.
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
import { buildMetricsPayload, payloadToPoints } from './metricsPayload';

const PTS = [
  { x: 0.1, y: 0.9 },
  { x: -2.4, y: 0.11 },
  { x: 7.25, y: -3.5 },
  { x: 0.5, y: 4.75 },
];

function makeNodes(): DataPoint[] {
  return PTS.map((p, i) => ({
    ...createEmptyDataPoint(),
    x: p.x,
    y: p.y,
    id: i + 1,
    line: 0,
    DoI: 1,
  }));
}

describe('metrics payload codec (issue #315 R1a A5)', () => {
  it('column-backed arrays ship typed copies that decode identically', () => {
    const nodes = makeNodes();
    attachPointColumns(nodes);
    const { payload, transfer } = buildMetricsPayload(nodes);

    expect(Array.isArray(payload)).toBe(false);
    const typed = payload as { x: Float64Array; y: Float64Array };
    expect(transfer).toEqual([typed.x.buffer, typed.y.buffer]);

    // Copies, not the live views — the canonical buffers must survive a
    // transfer of the payload buffers.
    const cols = columnsOf(nodes)!;
    expect(typed.x).not.toBe(cols.x);
    expect(typed.x.buffer).not.toBe(cols.x.buffer);

    const decoded = payloadToPoints(payload);
    expect(decoded).toEqual(PTS.map(({ x, y }) => ({ x, y })));
  });

  it('plain arrays keep the legacy object payload', () => {
    const nodes = makeNodes();
    const { payload, transfer } = buildMetricsPayload(nodes);
    expect(Array.isArray(payload)).toBe(true);
    expect(transfer).toEqual([]);
    expect(payloadToPoints(payload)).toEqual(PTS.map(({ x, y }) => ({ x, y })));
  });

  it('both payload shapes decode to the same point view', () => {
    const colNodes = makeNodes();
    attachPointColumns(colNodes);
    const viaColumns = payloadToPoints(buildMetricsPayload(colNodes).payload);
    const viaRows = payloadToPoints(buildMetricsPayload(makeNodes()).payload);
    expect(viaColumns).toEqual(viaRows);
  });
});
