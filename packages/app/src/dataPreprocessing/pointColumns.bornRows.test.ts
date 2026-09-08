/**
 * Born-column-backed rows (issue #315 B2): sidecar materialization builds
 * rows through createColumnBackedRowFactory — a shared prototype carries the
 * DoI accessor + columns link, each row stores only its own index — and
 * attachPointColumns short-circuits on such arrays instead of running its
 * per-point install loop. Pinned here:
 *   (1) value parity with the classic materialize-then-attach lane,
 *   (2) the DoI accessor contract (reads/writes hit the column) via the proto,
 *   (3) enumeration semantics: for-in still sees DoI; Object.keys and
 *       JSON.stringify expose ONLY the data columns (no internals, no DoI —
 *       every scan/export consumer either uses for-in or excludes DoI),
 *   (4) attachPointColumns first-attach short-circuit returns the SAME
 *       columns object; columnsOf/canonicalIndexOf/rawDoiReader all work,
 *   (5) a RE-attach still rebuilds through the classic loop, reading live
 *       DoI back (never clobbered to 1),
 *   (6) materializeRecords with a rowFactory yields the same field values as
 *       the plain path.
 */

import type { DataPoint } from "./dataPreprocessing";
import {
  attachPointColumns,
  canonicalIndexOf,
  columnsFromSidecar,
  columnsOf,
  createColumnBackedRowFactory,
  rawDoiReader,
  type SidecarColumnSource,
} from "./pointColumns";
import { materializeRecords, type PointColumns as SidecarPointColumns } from "./columnSidecar";

function sidecar(): SidecarColumnSource & SidecarPointColumns {
  return {
    count: 4,
    byName: {
      x: new Float64Array([0.1, 0.5, 0.9, 0.3]),
      y: new Float64Array([0.2, 0.4, 0.8, 0.6]),
      line: new Uint16Array([0, 0, 1, 1]),
      id: new Uint32Array([10, 11, 12, 13]),
      reward: new Float64Array([5, 6, 7, 8]),
    },
  };
}

/** Rows born column-backed, exactly like the loader's sidecar lane. */
async function bornRows(): Promise<{ rows: DataPoint[]; cols: NonNullable<ReturnType<typeof columnsFromSidecar>> }> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  const rows = (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
    sliceSize: 2,
  })) as unknown as DataPoint[];
  return { rows, cols };
}

describe("createColumnBackedRowFactory", () => {
  it("rows carry the DoI accessor via the prototype, backed by the column", async () => {
    const { rows, cols } = await bornRows();
    expect(rows.map((r) => r.DoI)).toEqual([1, 1, 1, 1]);
    rows[2].DoI = 0.25;
    expect(cols.doi[2]).toBe(0.25);
    cols.doi[0] = 0.5;
    expect(rows[0].DoI).toBe(0.5);
  });

  it("keeps DoI and internals out of Object.keys/JSON but DoI in for-in", async () => {
    const { rows } = await bornRows();
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "line", "reward", "x", "y"]);
    expect(Object.keys(JSON.parse(JSON.stringify(rows[0]))).sort()).toEqual([
      "id", "line", "reward", "x", "y",
    ]);
    const forInKeys: string[] = [];
    for (const k in rows[0]) forInKeys.push(k);
    expect(forInKeys).toContain("DoI");
    expect(forInKeys).not.toContain("__cols");
    expect(forInKeys).not.toContain("__ci");
  });

  it("materializes the same field values as the plain path", async () => {
    const sc = sidecar();
    const plain = await materializeRecords(sc, { sliceSize: 3 });
    const { rows } = await bornRows();
    for (let i = 0; i < sc.count; i++) {
      for (const key of ["x", "y", "line", "id", "reward"] as const) {
        expect((rows[i] as unknown as Record<string, number>)[key]).toBe(plain[i][key]);
      }
    }
  });
});

describe("attachPointColumns on born rows", () => {
  it("short-circuits to the born columns on first attach", async () => {
    const { rows, cols } = await bornRows();
    const attached = attachPointColumns(rows);
    expect(attached).toBe(cols);
    expect(columnsOf(rows)).toBe(cols);
    expect(rows.map((r) => canonicalIndexOf(r))).toEqual([0, 1, 2, 3]);
    const read = rawDoiReader(rows);
    cols.doi[3] = 0.75;
    expect(read(rows[3])).toBe(0.75);
  });

  it("adopts the sidecar x/y views by reference through columnsFromSidecar", async () => {
    const sc = sidecar();
    const cols = columnsFromSidecar(sc);
    expect(cols?.x).toBe(sc.byName.x);
    expect(cols?.y).toBe(sc.byName.y);
    expect(Array.from(cols?.line ?? [])).toEqual([0, 0, 1, 1]);
    expect(Array.from(cols?.id ?? [])).toEqual([10, 11, 12, 13]);
  });

  it("re-attach rebuilds via the classic loop and preserves live DoI", async () => {
    const { rows, cols } = await bornRows();
    attachPointColumns(rows);
    rows[1].DoI = 0.125;

    const recols = attachPointColumns(rows);
    expect(recols).not.toBe(cols);
    expect(Array.from(recols.doi)).toEqual([1, 0.125, 1, 1]);
    // Writes after the re-attach land in the NEW columns.
    rows[1].DoI = 0.5;
    expect(recols.doi[1]).toBe(0.5);
    expect(cols.doi[1]).toBe(0.125);
  });

  it("returns null from columnsFromSidecar for sidecars missing id/line", () => {
    const sc = sidecar();
    delete sc.byName.id;
    expect(columnsFromSidecar(sc)).toBeNull();
  });
});
