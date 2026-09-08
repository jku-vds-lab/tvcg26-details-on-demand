import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "./dataPreprocessing";
import {
  attachPointColumns,
  columnsOf,
  indexOfId,
  prebuildIdIndex,
  rawDoiReader,
  refreshPositionColumns,
} from "./pointColumns";

function makePoints(n: number): DataPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    x: i * 2,
    y: i * 3,
    line: i % 4,
    id: 100 + i,
    DoI: 0.5,
  })) as unknown as DataPoint[];
}

describe("pointColumns", () => {
  it("mirrors values and routes DoI reads/writes through the column", () => {
    const pts = makePoints(5);
    const cols = attachPointColumns(pts);

    expect(Array.from(cols.x)).toEqual([0, 2, 4, 6, 8]);
    expect(Array.from(cols.id)).toEqual([100, 101, 102, 103, 104]);
    expect(Array.from(cols.doi)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5]);

    pts[2].DoI = 0.9;
    expect(cols.doi[2]).toBe(0.9);
    cols.doi[3] = 0.1;
    expect(pts[3].DoI).toBe(0.1);
  });

  it("re-attach preserves current DoI values (idempotent load pass)", () => {
    const pts = makePoints(3);
    attachPointColumns(pts);
    pts[1].DoI = 0.25;
    const cols2 = attachPointColumns(pts);
    expect(cols2.doi[1]).toBe(0.25);
    expect(pts[1].DoI).toBe(0.25);
    expect(columnsOf(pts)).toBe(cols2);
  });

  it("columnsOf returns null for subset arrays; subset writes still land", () => {
    const pts = makePoints(4);
    const cols = attachPointColumns(pts);
    const subset = [pts[2], pts[3]];
    expect(columnsOf(subset)).toBeNull();
    subset[0].DoI = 0.7;
    expect(cols.doi[2]).toBe(0.7);
  });

  it("DoI stays enumerable: JSON export and spread carry the value", () => {
    const pts = makePoints(2);
    attachPointColumns(pts);
    pts[0].DoI = 0.42;
    expect(JSON.parse(JSON.stringify(pts[0])).DoI).toBe(0.42);
    const copy = { ...pts[0] };
    expect(copy.DoI).toBe(0.42);
    // The spread copy is detached: writing it must NOT touch the column.
    copy.DoI = 0.99;
    expect(pts[0].DoI).toBe(0.42);
  });

  it("refreshPositionColumns re-mirrors in-place x/y rewrites", () => {
    const pts = makePoints(3);
    const cols = attachPointColumns(pts);
    pts[1].x = 123;
    pts[1].y = 456;
    expect(cols.x[1]).toBe(2); // stale until refreshed
    refreshPositionColumns(pts);
    expect(cols.x[1]).toBe(123);
    expect(cols.y[1]).toBe(456);
  });
});

describe("indexOfId", () => {
  it("maps id → canonical index (ids offset from indices)", () => {
    const pts = makePoints(5); // ids 100..104
    attachPointColumns(pts);
    expect(indexOfId(pts, 100)).toBe(0);
    expect(indexOfId(pts, 104)).toBe(4);
    expect(indexOfId(pts, 102)).toBe(2);
  });

  it("returns undefined for absent ids", () => {
    const pts = makePoints(3);
    attachPointColumns(pts);
    expect(indexOfId(pts, 999)).toBeUndefined();
  });

  it("returns undefined when the array is not column-backed", () => {
    const pts = makePoints(3); // never attached
    expect(indexOfId(pts, 100)).toBeUndefined();
  });

  it("caches the lazily-built map on the columns object", () => {
    const pts = makePoints(4);
    const cols = attachPointColumns(pts);
    expect(cols.idIndex).toBeUndefined();
    indexOfId(pts, 100);
    expect(cols.idIndex).toBeInstanceOf(Map);
    const built = cols.idIndex;
    indexOfId(pts, 101);
    expect(cols.idIndex).toBe(built); // reused, not rebuilt
  });

  it("prebuildIdIndex warms the map without a lookup", () => {
    const pts = makePoints(3);
    const cols = attachPointColumns(pts);
    expect(cols.idIndex).toBeUndefined();
    prebuildIdIndex(pts);
    expect(cols.idIndex).toBeInstanceOf(Map);
    expect(indexOfId(pts, 102)).toBe(2);
  });
});

describe("rawDoiReader", () => {
  it("reads the backing column directly on the canonical array", () => {
    const pts = makePoints(3);
    const cols = attachPointColumns(pts);
    cols.doi[1] = 0.33;
    const read = rawDoiReader(pts);
    expect(read(pts[0])).toBe(0.5);
    expect(read(pts[1])).toBe(0.33);
  });

  it("falls back to the accessor for a non-column-backed array", () => {
    const pts = makePoints(2); // not attached: plain DoI field
    const read = rawDoiReader(pts);
    expect(read(pts[0])).toBe(0.5);
  });

  it("falls back to p.DoI ?? 0 for a synthetic non-column-backed point", () => {
    const pts = makePoints(2);
    attachPointColumns(pts); // canonical → column path chosen
    const read = rawDoiReader(pts);
    // A synthetic point (no __cols/__ci) still resolves via the accessor guard.
    const synthetic = { id: -1, x: 0, y: 0, line: 0, DoI: 0.8 } as unknown as DataPoint;
    expect(read(synthetic)).toBe(0.8);
    const noDoi = { id: -2, x: 0, y: 0, line: 0 } as unknown as DataPoint;
    expect(read(noDoi)).toBe(0);
  });
});
