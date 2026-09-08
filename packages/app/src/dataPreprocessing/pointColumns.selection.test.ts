/**
 * The `selected` column (issue #315 R1a step 4, row contract §3.1): selection
 * stops being a per-row field and becomes a Uint8 column plus a maintained
 * index list, so the server-propagation seed discovery reads O(selection)
 * instead of walking every row.
 *
 * Pinned here:
 *   (1) the accessor contract — every existing `p.selected` read/write site
 *       keeps working and lands in the column,
 *   (2) the own-property enumeration shape (for-in still sees `selected`, so
 *       the feature micro-scan's key set is unchanged),
 *   (3) writeSelectionByIds ≡ the row loop it replaces, including repeat
 *       writes (ctrl-chain, deselect) and ids absent from the dataset,
 *   (4) the index list is invalidated by a per-row write and rebuilt to
 *       exactly what a full scan would produce,
 *   (5) a re-attach reads live selection back instead of clobbering it.
 */

import type { DataPoint } from "./dataPreprocessing";
import { materializeRecords, type PointColumns as SidecarPointColumns } from "./columnSidecar";
import {
  attachPointColumns,
  columnsFromSidecar,
  columnsOf,
  createColumnBackedRowFactory,
  hasAnySelected,
  selectedIndicesOf,
  writeSelectionByIds,
  type SidecarColumnSource,
} from "./pointColumns";

const IDS = [10, 11, 12, 13, 14];

function sidecar(): SidecarColumnSource & SidecarPointColumns {
  return {
    count: IDS.length,
    byName: {
      x: new Float64Array([0.1, 0.5, 0.9, 0.3, 0.7]),
      y: new Float64Array([0.2, 0.4, 0.8, 0.6, 0.1]),
      line: new Uint16Array([0, 0, 1, 1, 1]),
      id: new Uint32Array(IDS),
      reward: new Float64Array([5, 6, 7, 8, 9]),
    },
  };
}

async function bornRows(): Promise<DataPoint[]> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
  })) as unknown as DataPoint[];
}

/** What the row loop this change replaces would have produced. */
function scanSelected(rows: readonly DataPoint[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].selected) out.push(i);
  return out;
}

describe("selected accessor", () => {
  it("reads false at boot and routes row writes into the column", async () => {
    const rows = await bornRows();
    const cols = columnsOf(rows)!;

    expect(rows.map((r) => r.selected)).toEqual([false, false, false, false, false]);

    rows[2].selected = true;
    expect(cols.selected[2]).toBe(1);
    expect(rows[2].selected).toBe(true);

    cols.selected[0] = 1;
    expect(rows[0].selected).toBe(true);

    rows[2].selected = false;
    expect(cols.selected[2]).toBe(0);
  });

  it("keeps the enumeration shape the feature micro-scan depends on", async () => {
    const rows = await bornRows();
    const forInKeys: string[] = [];
    for (const k in rows[0]) forInKeys.push(k);
    expect(forInKeys).toContain("selected");
    expect(forInKeys).toContain("DoI");
    // Internals stay invisible, exactly as before.
    expect(Object.keys(rows[0]).sort()).toEqual(["id", "line", "reward", "x", "y"]);
  });

  it("survives a re-attach with live values instead of being cleared", async () => {
    const rows = await bornRows();
    rows[1].selected = true;
    rows[3].selected = true;

    // A re-attach (the classic install loop) must read the current values back.
    const cols = attachPointColumns(rows);
    expect(Array.from(cols.selected)).toEqual([0, 1, 0, 1, 0]);
    expect(rows.map((r) => r.selected)).toEqual([false, true, false, true, false]);
  });
});

describe("writeSelectionByIds", () => {
  it("matches the row loop it replaces, for selection, ctrl-chain and deselect", async () => {
    const byColumn = await bornRows();
    const byRows = await bornRows();

    const apply = (rows: DataPoint[], ids: number[]) => {
      const set = new Set(ids);
      const cols = columnsOf(rows)!;
      for (let i = 0; i < rows.length; i++) rows[i].selected = set.has(cols.id[i]);
    };

    for (const ids of [[11, 13], [11, 13, 14], [], [10]]) {
      expect(writeSelectionByIds(byColumn, ids)).toBe(true);
      apply(byRows, ids);
      expect(byColumn.map((r) => r.selected)).toEqual(byRows.map((r) => r.selected));
      expect(Array.from(selectedIndicesOf(byColumn)!)).toEqual(scanSelected(byRows));
    }
  });

  it("ignores ids the dataset does not contain", async () => {
    const rows = await bornRows();
    writeSelectionByIds(rows, [12, 9999]);
    expect(Array.from(selectedIndicesOf(rows)!)).toEqual([2]);
  });

  it("returns false without writing when the array is not column-backed", async () => {
    const plain = (await materializeRecords(sidecar())) as unknown as DataPoint[];
    expect(writeSelectionByIds(plain, [10])).toBe(false);
    expect(plain.some((p) => p.selected)).toBe(false);
  });
});

describe("selectedIndicesOf / hasAnySelected", () => {
  it("rebuilds the list after a per-row write invalidates it", async () => {
    const rows = await bornRows();
    writeSelectionByIds(rows, [11, 13]);
    expect(Array.from(selectedIndicesOf(rows)!)).toEqual([1, 3]);

    rows[4].selected = true;
    expect(columnsOf(rows)!.selectedIndices).toBeUndefined();
    expect(Array.from(selectedIndicesOf(rows)!)).toEqual(scanSelected(rows));
    expect(Array.from(selectedIndicesOf(rows)!)).toEqual([1, 3, 4]);

    rows[1].selected = false;
    expect(Array.from(selectedIndicesOf(rows)!)).toEqual([3, 4]);
  });

  it("answers 'is anything selected' from the column", async () => {
    const rows = await bornRows();
    expect(hasAnySelected(rows)).toBe(false);
    rows[3].selected = true;
    expect(hasAnySelected(rows)).toBe(true);
    writeSelectionByIds(rows, []);
    expect(hasAnySelected(rows)).toBe(false);
  });

  it("returns null for arrays that are not column-backed", async () => {
    const plain = (await materializeRecords(sidecar())) as unknown as DataPoint[];
    expect(selectedIndicesOf(plain)).toBeNull();
    expect(hasAnySelected(plain)).toBeNull();
  });
});
