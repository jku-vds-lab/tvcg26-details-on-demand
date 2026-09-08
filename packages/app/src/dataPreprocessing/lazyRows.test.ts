/**
 * Row-lazy boot (issue #315 R1b, plan-315-server-first.md §3/§4): the server
 * lane's canonical array is created length-N with HOLES and rows are served on
 * demand. The invariants pinned here are the ones §2.4 says a lazy design must
 * honor — break any of them and the failure is silent, not loud.
 *
 *   (1) memoization — one row INSTANCE per canonical index, forever (reconcile
 *       keys Set<DataPoint>, `__memberHash` is written onto rows, HoverDiff
 *       prototypes them with Object.create),
 *   (2) the eager prefix + both endpoints exist, so `columnsOf` resolves and
 *       the 200-row feature micro-scan finds real rows,
 *   (3) holes are genuinely absent (`in`, array-method skipping) rather than
 *       undefined-valued slots,
 *   (4) a row built on demand has the SAME own-property/for-in shape as an
 *       eagerly built one — both come from one builder,
 *   (5) ensureResidentRows is idempotent, abortable, and leaves partial work
 *       in place,
 *   (6) the kill switch and the non-lazy pass-through.
 */

import type { DataPoint } from "./dataPreprocessing";
import { materializeRecords, type PointColumns as SidecarPointColumns } from "./columnSidecar";
import {
  areRowsResident,
  clearLazyRowArray,
  createLazyRowArray,
  ensureResidentRows,
  isLazyRowArray,
  materializeRowsBlocking,
  rowAt,
  rowLazyBootEnabled,
  subsetRowsByIndex,
} from "./lazyRows";
import {
  columnsFromSidecar,
  columnsOf,
  createColumnBackedRowFactory,
  type PointColumns,
} from "./pointColumns";

const N = 260; // > the 200-row eager prefix, so real holes exist

function sidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  const reward = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i * 0.5;
    y[i] = i * 0.25;
    line[i] = Math.floor(i / 10);
    id[i] = 1000 + i;
    reward[i] = i % 7;
  }
  return { count: N, byName: { x, y, line, id, reward } };
}

function lazyArray(): { rows: DataPoint[]; cols: PointColumns; sc: SidecarPointColumns } {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  const rows = createLazyRowArray([], sc, cols);
  return { rows, cols, sc };
}

/** The classic lane's rows, for shape comparison. */
async function eagerRows(): Promise<DataPoint[]> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc)!;
  return (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
  })) as unknown as DataPoint[];
}

describe("createLazyRowArray", () => {
  it("is length-N with an eager prefix and both endpoints, and holes between", () => {
    const { rows } = lazyArray();
    expect(rows.length).toBe(N);
    expect(isLazyRowArray(rows)).toBe(true);
    expect(areRowsResident(rows)).toBe(false);

    for (let i = 0; i < 200; i++) expect(i in rows).toBe(true);
    expect(N - 1 in rows).toBe(true);
    // Everything between the prefix and the last index is a genuine hole.
    for (let i = 200; i < N - 1; i++) expect(i in rows).toBe(false);
  });

  it("keeps columnsOf resolving — the endpoint probe is why the last row is eager", () => {
    const { rows, cols } = lazyArray();
    expect(columnsOf(rows)).toBe(cols);
  });

  it("holes are skipped by the array methods that skip holes", () => {
    const { rows } = lazyArray();
    // forEach/map/filter skip holes; this is what makes a stray full-array
    // walk degrade quietly instead of throwing — and why every real consumer
    // has to go through rowAt / ensureResidentRows.
    let seen = 0;
    rows.forEach(() => seen++);
    expect(seen).toBe(201);
  });
});

describe("rowAt", () => {
  it("builds a hole on first ask and returns the SAME instance afterwards", () => {
    const { rows } = lazyArray();
    const first = rowAt(rows, 240);
    const second = rowAt(rows, 240);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    // Memoized INTO the array: plain indexing now sees it too.
    expect(rows[240]).toBe(first);
    expect(240 in rows).toBe(true);
  });

  it("returns the resident instance for an eager index without rebuilding", () => {
    const { rows } = lazyArray();
    expect(rowAt(rows, 3)).toBe(rows[3]);
  });

  it("returns undefined outside the array instead of fabricating a row", () => {
    const { rows } = lazyArray();
    expect(rowAt(rows, N)).toBeUndefined();
    expect(rowAt(rows, -1)).toBeUndefined();
  });

  it("passes plain arrays straight through", () => {
    const plain = [{ id: 1 }, { id: 2 }] as unknown as DataPoint[];
    expect(rowAt(plain, 1)).toBe(plain[1]);
    expect(rowAt(plain, 5)).toBeUndefined();
  });

  it("serves values identical to the eager materialization", async () => {
    const { rows } = lazyArray();
    const eager = await eagerRows();
    for (const i of [0, 199, 200, 201, N - 2, N - 1]) {
      const lazy = rowAt(rows, i)! as unknown as Record<string, unknown>;
      const ref = eager[i] as unknown as Record<string, unknown>;
      expect(lazy.x).toBe(ref.x);
      expect(lazy.y).toBe(ref.y);
      expect(lazy.id).toBe(ref.id);
      expect(lazy.line).toBe(ref.line);
      expect(lazy.reward).toBe(ref.reward);
    }
  });

  it("gives on-demand rows the same shape as eager ones (own keys, for-in, accessors)", async () => {
    const { rows } = lazyArray();
    const eager = await eagerRows();
    const onDemand = rowAt(rows, 230)!;

    expect(Object.keys(onDemand).sort()).toEqual(Object.keys(eager[230]).sort());

    const forIn = (o: object) => {
      const keys: string[] = [];
      for (const k in o) keys.push(k);
      return keys.sort();
    };
    expect(forIn(onDemand)).toEqual(forIn(eager[230]));
    // DoI/selected ride the shared prototype as enumerable accessors — the
    // micro-scan's key set depends on it.
    expect(forIn(onDemand)).toContain("DoI");
    expect(forIn(onDemand)).toContain("selected");
    expect(onDemand.DoI).toBe(1);
    expect(onDemand.selected).toBe(false);
  });

  it("routes accessor writes on an on-demand row into the canonical columns", () => {
    const { rows, cols } = lazyArray();
    const row = rowAt(rows, 250)!;
    row.DoI = 0.25;
    row.selected = true;
    expect(cols.doi[250]).toBeCloseTo(0.25);
    expect(cols.selected[250]).toBe(1);
  });

  it("supports the identity operations members are subjected to", () => {
    const { rows } = lazyArray();
    const row = rowAt(rows, 220)!;

    // reconcile keys Set<DataPoint>
    const set = new Set<DataPoint>([row]);
    expect(set.has(rowAt(rows, 220)!)).toBe(true);

    // __memberHash is written ONTO the row
    (row as unknown as Record<string, unknown>).__memberHash = "abc";
    expect((rowAt(rows, 220) as unknown as Record<string, unknown>).__memberHash).toBe("abc");

    // HoverDiffGlyphs prototypes rows
    const view = Object.create(row) as DataPoint;
    expect(view.id).toBe(row.id);
    expect(Object.getPrototypeOf(view)).toBe(row);
  });
});

describe("ensureResidentRows", () => {
  it("fills every hole, is idempotent, and flips areRowsResident", async () => {
    const { rows } = lazyArray();
    await ensureResidentRows(rows, { sliceSize: 64 });
    expect(areRowsResident(rows)).toBe(true);
    for (let i = 0; i < N; i++) expect(i in rows).toBe(true);

    const sample = rows[233];
    await ensureResidentRows(rows, { sliceSize: 64 });
    // A second pass must not replace instances downstream code already holds.
    expect(rows[233]).toBe(sample);
  });

  it("preserves rows already built through rowAt", async () => {
    const { rows } = lazyArray();
    const early = rowAt(rows, 245)!;
    await ensureResidentRows(rows, { sliceSize: 64 });
    expect(rows[245]).toBe(early);
  });

  it("reports progress per slice", async () => {
    const { rows } = lazyArray();
    const seen: Array<[number, number]> = [];
    await ensureResidentRows(rows, { sliceSize: 100, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen[seen.length - 1]).toEqual([N, N]);
    expect(seen.length).toBe(3);
  });

  it("aborts, keeps the rows it already built, and lets a later call finish", async () => {
    const { rows } = lazyArray();
    const controller = new AbortController();
    controller.abort();
    await expect(ensureResidentRows(rows, { signal: controller.signal })).rejects.toThrow();
    expect(areRowsResident(rows)).toBe(false);
    // The rejected run must not be cached as the in-flight promise.
    await expect(ensureResidentRows(rows, { sliceSize: 64 })).resolves.toBeUndefined();
    expect(areRowsResident(rows)).toBe(true);
  });

  it("concurrent callers share one pass", async () => {
    const { rows } = lazyArray();
    await Promise.all([
      ensureResidentRows(rows, { sliceSize: 32 }),
      ensureResidentRows(rows, { sliceSize: 32 }),
    ]);
    expect(areRowsResident(rows)).toBe(true);
  });

  it("resolves immediately for arrays that were never lazy", async () => {
    const plain = [{ id: 1 }] as unknown as DataPoint[];
    expect(areRowsResident(plain)).toBe(true);
    await expect(ensureResidentRows(plain)).resolves.toBeUndefined();
  });
});

describe("materializeRowsBlocking", () => {
  it("fills every hole synchronously", () => {
    const { rows } = lazyArray();
    materializeRowsBlocking(rows);
    expect(areRowsResident(rows)).toBe(true);
    for (let i = 0; i < N; i++) expect(rows[i]).toBeDefined();
  });

  it("is a no-op on a non-lazy array", () => {
    const plain = [{ id: 1 }] as unknown as DataPoint[];
    expect(() => materializeRowsBlocking(plain)).not.toThrow();
  });
});

describe("lane switches", () => {
  it("clearLazyRowArray un-registers the array (sidecar failure → JSON fallback)", () => {
    const { rows } = lazyArray();
    clearLazyRowArray(rows);
    expect(isLazyRowArray(rows)).toBe(false);
    expect(areRowsResident(rows)).toBe(true);
  });

  it("rowLazyBootEnabled follows the window kill switch", () => {
    const g = globalThis as { __rowLazyBoot?: boolean };
    expect(rowLazyBootEnabled()).toBe(true);
    g.__rowLazyBoot = false;
    expect(rowLazyBootEnabled()).toBe(false);
    g.__rowLazyBoot = true;
    expect(rowLazyBootEnabled()).toBe(true);
    delete g.__rowLazyBoot;
  });
});

describe("subsetRowsByIndex", () => {
  // The visible-subset clustering fallback (runHdbscanClustering, server fit
  // failed) walks its subset copy as a plain resident array — every entry
  // must be a real row even when the index lands on a hole.
  it("resolves holes to real rows and leaves no undefined entries", () => {
    const { rows } = lazyArray();
    const idx = [0, 205, 230, N - 1]; // eager, two holes, eager endpoint
    expect(rows[205]).toBeUndefined();
    const subset = subsetRowsByIndex(rows, idx);
    expect(subset).toHaveLength(4);
    for (const r of subset) expect(r).toBeDefined();
    expect(subset[1].id).toBe(1205);
    expect(subset[2].x).toBe(115);
  });

  it("memoizes built rows into the canonical slots (one instance per index)", () => {
    const { rows } = lazyArray();
    const subset = subsetRowsByIndex(rows, [210, 210]);
    expect(subset[0]).toBe(subset[1]);
    expect(rows[210]).toBe(subset[0]);
  });

  it("passes plain resident arrays straight through by identity", () => {
    const plain = [{ id: 1 }, { id: 2 }, { id: 3 }] as unknown as DataPoint[];
    const subset = subsetRowsByIndex(plain, [2, 0]);
    expect(subset[0]).toBe(plain[2]);
    expect(subset[1]).toBe(plain[0]);
  });
});
