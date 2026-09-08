/**
 * Sidecar-direct attachPointColumns (issue #315 B1): when the points were
 * materialized from a decoded binary sidecar, its typed views become the
 * canonical columns directly — x/y adopted by REFERENCE, line/id converted in
 * one typed-array pass, DoI starting at the uniform boot value — instead of
 * the per-object read-back loop. Pinned here:
 *   (1) full value parity with the classic path (x/y/line/id/doi),
 *   (2) x/y adoption by reference (the "identity on sidecar columns" contract),
 *   (3) accessor semantics unchanged (writes land in the column, columnsOf
 *       identity, adoptDoiColumn still works),
 *   (4) a RE-attach never takes the fast path — live DoI values must be read
 *       back through the old accessors, not clobbered to 1,
 *   (5) malformed sidecars (count mismatch, missing columns) fall back to the
 *       classic path silently.
 */

import type { DataPoint } from "./dataPreprocessing";
import {
  adoptDoiColumn,
  attachPointColumns,
  canonicalIndexOf,
  columnsOf,
  type SidecarColumnSource,
} from "./pointColumns";
import { registerSidecarColumns, sidecarColumnsFor, type PointColumns } from "./columnSidecar";

function sidecar(): SidecarColumnSource {
  return {
    count: 4,
    byName: {
      x: new Float64Array([0.1, 0.5, 0.9, 0.3]),
      y: new Float64Array([0.2, 0.4, 0.8, 0.6]),
      line: new Uint16Array([0, 0, 1, 1]),
      id: new Uint32Array([10, 11, 12, 13]),
      action: new Uint8Array([0, 1, 0, 2]),
    },
  };
}

/** Rows shaped exactly like materializeRecords output after the boot
 * normalize pass (selected/DoI written, ids valid). */
function bootRows(): DataPoint[] {
  const sc = sidecar().byName;
  return Array.from({ length: 4 }, (_, i) => ({
    x: (sc.x as Float64Array)[i],
    y: (sc.y as Float64Array)[i],
    line: (sc.line as Uint16Array)[i],
    id: (sc.id as Uint32Array)[i],
    action: (sc.action as Uint8Array)[i],
    selected: false,
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
  })) as unknown as DataPoint[];
}

describe("attachPointColumns sidecar-direct", () => {
  it("produces columns value-equal to the classic path", () => {
    const fast = bootRows();
    const classic = bootRows();
    const sc = sidecar();

    const colsFast = attachPointColumns(fast, sc);
    const colsClassic = attachPointColumns(classic);

    expect(Array.from(colsFast.x)).toEqual(Array.from(colsClassic.x));
    expect(Array.from(colsFast.y)).toEqual(Array.from(colsClassic.y));
    expect(Array.from(colsFast.line)).toEqual(Array.from(colsClassic.line));
    expect(Array.from(colsFast.id)).toEqual(Array.from(colsClassic.id));
    expect(Array.from(colsFast.doi)).toEqual(Array.from(colsClassic.doi));
  });

  it("adopts the sidecar x/y views by reference", () => {
    const points = bootRows();
    const sc = sidecar();
    const cols = attachPointColumns(points, sc);
    expect(cols.x).toBe(sc.byName.x);
    expect(cols.y).toBe(sc.byName.y);
  });

  it("keeps the DoI accessor contract on the fast path", () => {
    const points = bootRows();
    const cols = attachPointColumns(points, sidecar());

    expect(columnsOf(points)).toBe(cols);
    expect(canonicalIndexOf(points[2])).toBe(2);

    points[1].DoI = 0.25;
    expect(cols.doi[1]).toBe(0.25);
    expect(points[1].DoI).toBe(0.25);

    const field = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    expect(adoptDoiColumn(points, field)).toBe(true);
    expect(points[3].DoI).toBeCloseTo(0.4, 6);
  });

  it("never takes the fast path on a re-attach (live DoI survives)", () => {
    const points = bootRows();
    const sc = sidecar();
    attachPointColumns(points, sc);

    points[1].DoI = 0.25;
    const cols2 = attachPointColumns(points, sc);
    expect(cols2.doi[1]).toBe(0.25);
    expect(points[1].DoI).toBe(0.25);
  });

  it("falls back to the classic path on count mismatch or missing columns", () => {
    const points = bootRows();
    const wrongCount = sidecar();
    wrongCount.count = 5;
    const colsA = attachPointColumns(points, wrongCount);
    expect(colsA.x).not.toBe(wrongCount.byName.x);
    expect(Array.from(colsA.x)).toEqual(Array.from(wrongCount.byName.x as Float64Array).slice(0, 4));

    const points2 = bootRows();
    const noId = sidecar();
    noId.byName.id = undefined;
    const colsB = attachPointColumns(points2, noId);
    expect(colsB.x).not.toBe(noId.byName.x);
    expect(Array.from(colsB.id)).toEqual([10, 11, 12, 13]);
  });
});

describe("columnSidecar rows registry", () => {
  it("resolves the registered sidecar for a rows array, and only for it", () => {
    const rows: object = [];
    const cols: PointColumns = { count: 0, byName: {} };
    registerSidecarColumns(rows, cols);
    expect(sidecarColumnsFor(rows)).toBe(cols);
    expect(sidecarColumnsFor([])).toBeUndefined();
  });
});
