/**
 * Deferred feature columns in the tabular-card probe (issue #315, CS
 * checklist round 2026-08-07): on an endgame manifest (synth1m) the feature
 * columns are PROTOTYPE accessors reading through the registered sidecar —
 * Object.keys can never enumerate them, so `collectFeatureColumns` found 0
 * columns and the server build fell to the abstract placeholder instead of the
 * tabular server card. The probe must add the manifest-declared deferred
 * names (readable via `in` once the bytes attach); before the attach they
 * read "" everywhere and drop out, which is the abstract-this-frame half of
 * the mechanism.
 */

import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { PointColumns } from "src/dataPreprocessing/columnSidecar";
import {
  clearDeferredColumns,
  ensureResidentColumns,
  registerDeferredColumns,
} from "src/dataPreprocessing/lazyColumns";
import { collectFeatureColumns } from "./featureStats";

const ROW_INDEX = Symbol("rowIndex");

/** Rows the way the deferred-lane factory builds them: core columns as OWN
 * props, deferred columns as enumerable PROTOTYPE accessors through the
 * shared sidecar `byName` slot (undefined until fetched). */
function makeDeferredDataset(n: number, deferredNames: string[]) {
  const sidecar = { count: n, byName: {} } as unknown as PointColumns;
  const proto: Record<string, unknown> = {};
  for (const name of deferredNames) {
    Object.defineProperty(proto, name, {
      enumerable: true,
      configurable: true,
      get(this: { [ROW_INDEX]: number }) {
        const col = (sidecar.byName as Record<string, ArrayLike<number> | undefined>)[name];
        return col ? col[this[ROW_INDEX]] : undefined;
      },
    });
  }
  const rows = Array.from({ length: n }, (_, i) => {
    const r = Object.create(proto) as DataPoint & { [ROW_INDEX]: number };
    r[ROW_INDEX] = i;
    Object.assign(r, { id: i, x: i, y: 0, line: 0 });
    return r as DataPoint;
  });
  return { rows, sidecar };
}

describe("collectFeatureColumns on the deferred-columns lane (issue #315 R3c)", () => {
  it("Object.keys cannot see a deferred accessor — the failure this pins", () => {
    const { rows } = makeDeferredDataset(4, ["reward"]);
    expect(Object.keys(rows[0])).not.toContain("reward");
    expect("reward" in rows[0]).toBe(true);
  });

  it("finds a deferred numeric column once its bytes are attached", async () => {
    const { rows, sidecar } = makeDeferredDataset(8, ["reward"]);
    registerDeferredColumns(
      rows,
      sidecar,
      [{ name: "reward", dtype: "f32" }],
      async () => ({
        count: 8,
        byName: { reward: Float32Array.from([0.5, 1, 2, 3, 4, 5, 6, 7]) },
      }) as unknown as PointColumns
    );
    try {
      // Server-resident: values read "", the column drops out — abstract card
      // this frame (the renderer triggers the fetch alongside).
      expect(collectFeatureColumns(rows)).toEqual([]);

      await ensureResidentColumns(rows, ["reward"]);
      expect(collectFeatureColumns(rows)).toEqual([
        { column: "reward", kind: "numeric" },
      ]);
    } finally {
      clearDeferredColumns(rows);
    }
  });

  it("the canonical hint serves merged probe arrays (the edge-diff path)", async () => {
    const { rows, sidecar } = makeDeferredDataset(8, ["reward"]);
    registerDeferredColumns(
      rows,
      sidecar,
      [{ name: "reward", dtype: "f32" }],
      async () => ({
        count: 8,
        byName: { reward: Float32Array.from([1, 1, 2, 2, 3, 3, 4, 4]) },
      }) as unknown as PointColumns
    );
    try {
      await ensureResidentColumns(rows, ["reward"]);
      // A freshly merged array has no registry entry of its own — without the
      // hint the declared names are invisible to it.
      const merged = [...rows.slice(0, 3), ...rows.slice(5)];
      expect(collectFeatureColumns(merged)).toEqual([]);
      expect(collectFeatureColumns(merged, { canonical: rows })).toEqual([
        { column: "reward", kind: "numeric" },
      ]);
    } finally {
      clearDeferredColumns(rows);
    }
  });
});
