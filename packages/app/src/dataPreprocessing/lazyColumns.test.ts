/**
 * Deferred-column residency (issue #315 R3c, plan §6.1): the fetch seam that
 * attaches server-resident columns into the registered sidecar on demand.
 * Pinned here (the §6.1 instant-test list):
 *
 *   (1) undefined-before-attach, live-values-after — through the SAME row
 *       instance (prototype accessors, plan §2.4),
 *   (2) attach is idempotent and concurrent callers share ONE in-flight
 *       fetch per column,
 *   (3) a failed fetch is retryable (in-flight slots clear),
 *   (4) a count-mismatched or incomplete response never attaches,
 *   (5) `ensureResidentRows` fetches deferred columns BEFORE reporting full
 *       residency (the fetch-then-materialize ordering export paths rely on).
 */

import type { DataPoint } from "./dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "./columnSidecar";
import {
  clearDeferredColumns,
  deferColumnsEnabled,
  deferredColumnNames,
  ensureResidentColumns,
  hasPendingDeferredColumns,
  onDeferredColumnsAttached,
  pendingDeferredColumns,
  registerDeferredColumns,
  type DeferredColumnEntry,
} from "./lazyColumns";
import { createLazyRowArray, ensureResidentRows, rowAt } from "./lazyRows";
import { columnsFromSidecar } from "./pointColumns";

const N = 100;

function coreSidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i * 0.5;
    y[i] = i * 0.25;
    line[i] = Math.floor(i / 10);
    id[i] = 1000 + i;
  }
  return { count: N, byName: { x, y, line, id } };
}

const DEFERRED: DeferredColumnEntry[] = [
  { name: "reward", dtype: "f64" },
  { name: "action", dtype: "u8", categories: ["left", "right"] },
];

function deferredPayload(names: readonly string[]): SidecarPointColumns {
  const byName: SidecarPointColumns["byName"] = {};
  for (const name of names) {
    if (name === "reward") {
      const a = new Float64Array(N);
      for (let i = 0; i < N; i++) a[i] = i % 7;
      byName.reward = a;
    } else if (name === "action") {
      const a: Array<string | number | boolean | null> = new Array(N);
      for (let i = 0; i < N; i++) a[i] = i % 2 === 0 ? "left" : "right";
      byName.action = a;
    }
  }
  return { count: N, byName };
}

function fixture(fetchImpl?: (names: string[]) => Promise<SidecarPointColumns>) {
  const sc = coreSidecar();
  const cols = columnsFromSidecar(sc)!;
  const fetchColumns = jest.fn(
    fetchImpl ?? (async (names: string[]) => deferredPayload(names))
  );
  const rows = createLazyRowArray([], sc, cols, {
    deferred: { names: DEFERRED.map((e) => e.name), source: sc },
  });
  registerDeferredColumns(rows, sc, DEFERRED, fetchColumns);
  return { rows, sc, cols, fetchColumns };
}

describe("registration and pending bookkeeping", () => {
  it("declares names, reports pending until attach, [] on unregistered arrays", () => {
    const { rows } = fixture();
    expect(deferredColumnNames(rows)).toEqual(["reward", "action"]);
    expect(pendingDeferredColumns(rows, ["reward", "x", "nope"])).toEqual(["reward"]);
    expect(hasPendingDeferredColumns(rows)).toBe(true);

    const plain: DataPoint[] = [];
    expect(deferredColumnNames(plain)).toEqual([]);
    expect(pendingDeferredColumns(plain, ["reward"])).toEqual([]);
    expect(hasPendingDeferredColumns(plain)).toBe(false);
  });

  it("clearDeferredColumns un-registers (the loader's JSON fallback)", async () => {
    const { rows, fetchColumns } = fixture();
    clearDeferredColumns(rows);
    await ensureResidentColumns(rows, ["reward"]);
    expect(fetchColumns).not.toHaveBeenCalled();
  });

  it("kill switch reads the window flag", () => {
    const g = globalThis as { __deferColumns?: boolean };
    expect(deferColumnsEnabled()).toBe(true);
    g.__deferColumns = false;
    expect(deferColumnsEnabled()).toBe(false);
    delete g.__deferColumns;
  });
});

describe("accessor reads across the attach", () => {
  it("a row built BEFORE the fetch reads undefined, then live values — same instance", async () => {
    const { rows } = fixture();
    const early = rowAt(rows, 3)! as unknown as Record<string, unknown>;
    expect(early.reward).toBeUndefined();
    expect(early.action).toBeUndefined();

    await ensureResidentColumns(rows, ["reward", "action"]);

    expect(rowAt(rows, 3)).toBe(early as unknown as DataPoint);
    expect(early.reward).toBe(3 % 7);
    expect(early.action).toBe("right");
  });

  it("a row built AFTER the fetch reads the same values through the accessor", async () => {
    const { rows } = fixture();
    await ensureResidentColumns(rows, ["reward"]);
    const late = rowAt(rows, 250 % N)! as unknown as Record<string, unknown>;
    expect(late.reward).toBe((250 % N) % 7);
  });
});

describe("ensureResidentColumns", () => {
  it("attaches into the registered sidecar and is idempotent", async () => {
    const { rows, sc, fetchColumns } = fixture();
    await ensureResidentColumns(rows, ["reward"]);
    expect(sc.byName.reward).toBeInstanceOf(Float64Array);
    expect(fetchColumns).toHaveBeenCalledTimes(1);
    expect(fetchColumns).toHaveBeenCalledWith(["reward"]);

    await ensureResidentColumns(rows, ["reward"]);
    expect(fetchColumns).toHaveBeenCalledTimes(1);
    expect(pendingDeferredColumns(rows, ["reward"])).toEqual([]);
  });

  it("shares ONE in-flight fetch between concurrent callers", async () => {
    let release!: (v: SidecarPointColumns) => void;
    const gate = new Promise<SidecarPointColumns>((r) => (release = r));
    const { rows, fetchColumns } = fixture(() => gate);

    const a = ensureResidentColumns(rows, ["reward"]);
    const b = ensureResidentColumns(rows, ["reward"]);
    release(deferredPayload(["reward"]));
    await Promise.all([a, b]);
    expect(fetchColumns).toHaveBeenCalledTimes(1);
  });

  it("non-deferred names resolve without any fetch", async () => {
    const { rows, fetchColumns } = fixture();
    await ensureResidentColumns(rows, ["x", "id", "unknown"]);
    expect(fetchColumns).not.toHaveBeenCalled();
  });

  it("a failed fetch rejects every waiter and is retryable", async () => {
    let calls = 0;
    const { rows, sc } = fixture(async (names) => {
      calls++;
      if (calls === 1) throw new Error("server down");
      return deferredPayload(names);
    });

    await expect(ensureResidentColumns(rows, ["reward"])).rejects.toThrow("server down");
    expect(sc.byName.reward).toBeUndefined();

    await ensureResidentColumns(rows, ["reward"]);
    expect(sc.byName.reward).toBeInstanceOf(Float64Array);
    expect(calls).toBe(2);
  });

  it("never attaches a count-mismatched or incomplete response", async () => {
    const short = fixture(async () => ({
      count: N - 1,
      byName: { reward: new Float64Array(N - 1) },
    }));
    await expect(ensureResidentColumns(short.rows, ["reward"])).rejects.toThrow(
      /count mismatch/
    );
    expect(short.sc.byName.reward).toBeUndefined();

    const missing = fixture(async () => ({ count: N, byName: {} }));
    await expect(ensureResidentColumns(missing.rows, ["reward"])).rejects.toThrow(
      /missing from the fetch response/
    );
    expect(missing.sc.byName.reward).toBeUndefined();
  });

  it("notifies attach listeners with the fetched names", async () => {
    const { rows } = fixture();
    const seen: string[][] = [];
    const off = onDeferredColumnsAttached((_pts, names) => seen.push(names));
    await ensureResidentColumns(rows, ["action"]);
    off();
    await ensureResidentColumns(rows, ["reward"]);
    expect(seen).toEqual([["action"]]);
  });
});

describe("ensureResidentRows prerequisite", () => {
  it("fetches every deferred column before reporting full residency", async () => {
    const { rows, sc, fetchColumns } = fixture();
    await ensureResidentRows(rows);
    expect(fetchColumns).toHaveBeenCalledTimes(1);
    expect(new Set(fetchColumns.mock.calls[0][0])).toEqual(new Set(["reward", "action"]));
    expect(sc.byName.reward).toBeDefined();
    expect(sc.byName.action).toBeDefined();
    // Every row is now honest full-row access.
    const r = rows[57] as unknown as Record<string, unknown>;
    expect(r.reward).toBe(57 % 7);
    expect(r.action).toBe("right");
  });
});
