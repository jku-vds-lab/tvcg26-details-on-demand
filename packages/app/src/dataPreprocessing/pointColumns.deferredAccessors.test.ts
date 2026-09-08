/**
 * Deferred-column prototype accessors (issue #315 R3c, plan §6.1 identity
 * audit): rows born from `createColumnBackedRowFactory` with a deferred set
 * carry one enumerable PROTO accessor per deferred name — exactly the
 * DoI/`selected` pattern — so:
 *
 *   (1) own-property shape stays uniform across build times (the feature
 *       micro-scan invariant): Object.keys/JSON.stringify never include
 *       deferred names, before OR after the attach,
 *   (2) for-in sees them (enumerable proto accessors), in parity with DoI,
 *   (3) the SAME instance gains the fields when the column attaches,
 *   (4) a row WRITE shadows the accessor with an own property (the
 *       materialized lane's divergence semantics — writes never flow back
 *       into sidecar columns) without touching sibling rows.
 */

import { makeRecordBuilder, type PointColumns as SidecarPointColumns } from "./columnSidecar";
import { columnsFromSidecar, createColumnBackedRowFactory } from "./pointColumns";

const N = 10;

function coreSidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = i * 2;
    line[i] = 0;
    id[i] = i;
  }
  return { count: N, byName: { x, y, line, id } };
}

function buildRow(i: number, sc = coreSidecar()) {
  const cols = columnsFromSidecar(sc)!;
  const build = makeRecordBuilder(
    sc,
    createColumnBackedRowFactory(cols, { names: ["reward", "action"], source: sc })
  );
  return { row: build(i) as Record<string, unknown>, sc };
}

function attach(sc: SidecarPointColumns): void {
  const reward = new Float64Array(N);
  for (let i = 0; i < N; i++) reward[i] = i * 10;
  sc.byName.reward = reward;
  sc.byName.action = Array.from({ length: N }, (_, i) => (i % 2 ? "b" : "a"));
}

test("own-property shape excludes deferred names before and after attach", () => {
  const { row, sc } = buildRow(4);
  const ownBefore = Object.keys(row).sort();
  expect(ownBefore).toEqual(["id", "line", "x", "y"]);
  attach(sc);
  expect(Object.keys(row).sort()).toEqual(ownBefore);
  expect(JSON.parse(JSON.stringify(row))).toEqual({ x: 4, y: 8, line: 0, id: 4 });
});

test("for-in sees deferred names, in parity with DoI", () => {
  const { row } = buildRow(2);
  const forIn: string[] = [];
  for (const k in row) forIn.push(k);
  expect(forIn).toEqual(expect.arrayContaining(["DoI", "selected", "reward", "action"]));
});

test("undefined before attach, live values after — same instance", () => {
  const { row, sc } = buildRow(3);
  expect(row.reward).toBeUndefined();
  expect(row.action).toBeUndefined();
  attach(sc);
  expect(row.reward).toBe(30);
  expect(row.action).toBe("b");
});

test("a write shadows with an own property on that row only", () => {
  const sc = coreSidecar();
  const cols = columnsFromSidecar(sc)!;
  const build = makeRecordBuilder(
    sc,
    createColumnBackedRowFactory(cols, { names: ["reward"], source: sc })
  );
  const a = build(1) as Record<string, unknown>;
  const b = build(2) as Record<string, unknown>;
  attach(sc);

  a.reward = 999;
  expect(a.reward).toBe(999);
  expect(Object.prototype.hasOwnProperty.call(a, "reward")).toBe(true);
  // The sibling still reads the column through the proto accessor…
  expect(b.reward).toBe(20);
  expect(Object.prototype.hasOwnProperty.call(b, "reward")).toBe(false);
  // …and the column itself never saw the write.
  expect((sc.byName.reward as Float64Array)[1]).toBe(10);
});

test("deferred names never shadow the DoI/selected accessors", () => {
  const sc = coreSidecar();
  const cols = columnsFromSidecar(sc)!;
  const build = makeRecordBuilder(
    sc,
    createColumnBackedRowFactory(cols, { names: ["DoI", "reward"], source: sc })
  );
  const row = build(5) as Record<string, unknown>;
  row.DoI = 0.25;
  expect(cols.doi[5]).toBe(0.25); // still the column-backed setter
});
