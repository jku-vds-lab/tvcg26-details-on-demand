/**
 * Member specs for index-backed group arrays (issue #315 R1c, plan §4 R1c).
 *
 * An index-backed group is a HOLEY DataPoint[] whose membership lives in a
 * registered spec (leaf range or canonical-index list). Pinned here:
 *
 *   (1) accessors resolve members through `rowAt` — one memoized instance
 *       per canonical index — and NEVER write the group's own slots,
 *   (2) both spec kinds agree with each other and with the canonical
 *       columns (refs, mean, x/y, id membership),
 *   (3) the stride sampler honors its cap and the vote-rows helper is
 *       strided while non-resident, exact (all rows) once resident,
 *   (4) plain arrays pass through untouched (null returns / slot reads).
 */

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "../dataPreprocessing/columnSidecar";
import { createLazyRowArray, materializeRowsBlocking } from "../dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "../dataPreprocessing/pointColumns";
import {
  groupFirstRow,
  groupHeadRows,
  groupMeanPoint,
  groupMemberIndexAt,
  groupMemberRefs,
  groupMemberRowAt,
  groupMembersOf,
  groupMemberXY,
  groupSharesAnyId,
  groupStrideRows,
  groupVoteRows,
  registerGroupMembers,
  type GroupMemberSpec,
} from "./groupMembers";

const N = 240; // > the 200-row eager prefix ⇒ the tail is real holes

function sidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i * 0.5;
    y[i] = i * 0.25;
    line[i] = 0;
    id[i] = 1000 + i;
  }
  return { count: N, byName: { x, y, line, id } };
}

function lazyNodes(): DataPoint[] {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols);
}

/** A holey group over nodes[first..last) with a range spec. */
function rangeGroup(nodes: DataPoint[], first: number, last: number) {
  const order = Array.from({ length: N }, (_v, i) => i);
  const samples = new Array<DataPoint>(last - first);
  registerGroupMembers(samples, {
    kind: "range",
    nodes,
    hierarchyId: 7,
    order,
    first,
    last,
  });
  return samples;
}

/** A holey group with an explicit canonical-index list spec. */
function listGroup(nodes: DataPoint[], indices: number[]) {
  const samples = new Array<DataPoint>(indices.length);
  registerGroupMembers(samples, {
    kind: "list",
    nodes,
    hierarchyId: 7,
    indices: Int32Array.from(indices),
  });
  return samples;
}

describe("groupMembers specs", () => {
  it("indexes both spec kinds identically", () => {
    const nodes = lazyNodes();
    const range = rangeGroup(nodes, 210, 220);
    const list = listGroup(nodes, [210, 211, 212, 213, 214, 215, 216, 217, 218, 219]);
    const rs = groupMembersOf(range)!;
    const ls = groupMembersOf(list)!;
    for (let k = 0; k < 10; k++) {
      expect(groupMemberIndexAt(rs, k)).toBe(210 + k);
      expect(groupMemberIndexAt(ls, k)).toBe(210 + k);
    }
  });

  it("resolves rows via rowAt without touching the group slots", () => {
    const nodes = lazyNodes();
    const samples = rangeGroup(nodes, 210, 220);
    const row = groupMemberRowAt(samples, 3)!;
    expect(row.id).toBe(1000 + 213);
    // Memoized into the CANONICAL array; asked again ⇒ same instance.
    expect(nodes[213]).toBe(row);
    expect(groupMemberRowAt(samples, 3)).toBe(row);
    // The group's own slots stay holes.
    for (let k = 0; k < samples.length; k++) expect(k in samples).toBe(false);
    expect(groupFirstRow(samples)!.id).toBe(1000 + 210);
  });

  it("serves refs, mean, x/y and id membership from the columns", () => {
    const nodes = lazyNodes();
    const samples = listGroup(nodes, [220, 230]);
    expect(groupMemberRefs(samples)).toEqual([
      { id: 1220, line: 0 },
      { id: 1230, line: 0 },
    ]);
    const mean = groupMeanPoint(samples)!;
    expect(mean.x).toBeCloseTo((220 * 0.5 + 230 * 0.5) / 2);
    expect(mean.y).toBeCloseTo((220 * 0.25 + 230 * 0.25) / 2);
    const xy = groupMemberXY(samples)!;
    expect(xy.count).toBe(2);
    expect(xy.xs[groupMemberIndexAt(xy.spec, 1)]).toBeCloseTo(115);
    expect(groupSharesAnyId(samples, new Set([1230]))).toBe(true);
    expect(groupSharesAnyId(samples, new Set([9999]))).toBe(false);
    // Nothing above needed a row (N-1 is the eager endpoint probe).
    for (let i = 210; i < N - 1; i++) expect(i in nodes).toBe(false);
  });

  it("groupHeadRows: first ≤ cap resolved rows, slice semantics on plain arrays", () => {
    const nodes = lazyNodes();
    const samples = rangeGroup(nodes, 200, 240);
    // The edge-diff probe contract (issue #315 R1c E2E finding): the sides
    // handed to the renderers ARE the holey group arrays — a direct
    // `slice(0, cap)` spread their holes as `undefined` into Object.keys.
    const head = groupHeadRows(samples, 8);
    expect(head.length).toBe(8);
    expect(head.every(Boolean)).toBe(true);
    expect(head.map((r) => r.id)).toEqual([1200, 1201, 1202, 1203, 1204, 1205, 1206, 1207]);
    // Under the cap ⇒ every member, still no holes.
    expect(groupHeadRows(listGroup(nodes, [205, 215]), 8).map((r) => r.id)).toEqual([1205, 1215]);
    // Plain arrays keep the exact slice behavior.
    materializeRowsBlocking(nodes);
    const plain = [nodes[0], nodes[1], nodes[2]];
    expect(groupHeadRows(plain, 2)).toEqual([nodes[0], nodes[1]]);
  });

  it("stride-samples at most cap rows, spread over the membership", () => {
    const nodes = lazyNodes();
    const samples = rangeGroup(nodes, 200, 240);
    const rows = groupStrideRows(samples, 8)!;
    expect(rows.length).toBe(8);
    expect(rows[0].id).toBe(1200);
    // Strided, not a prefix.
    expect(rows[rows.length - 1].id).toBeGreaterThan(1230);
    // Under the cap ⇒ every member.
    expect(groupStrideRows(listGroup(nodes, [205, 215]), 8)!.map((r) => r.id)).toEqual([1205, 1215]);
  });

  it("groupVoteRows: strided while non-resident, all members once resident", () => {
    const nodes = lazyNodes();
    const samples = rangeGroup(nodes, 200, 240);
    expect(groupVoteRows(samples, 8)!.length).toBe(8);
    materializeRowsBlocking(nodes);
    expect(groupVoteRows(samples, 8)!.length).toBe(40);
  });

  it("passes plain arrays through", () => {
    const nodes = lazyNodes();
    materializeRowsBlocking(nodes);
    const plain = [nodes[0], nodes[1]];
    expect(groupMembersOf(plain)).toBeUndefined();
    expect(groupMemberRowAt(plain, 1)).toBe(nodes[1]);
    expect(groupStrideRows(plain, 8)).toBeNull();
    expect(groupMemberRefs(plain)).toBeNull();
    expect(groupMeanPoint(plain)).toBeNull();
    expect(groupMemberXY(plain)).toBeNull();
    expect(groupSharesAnyId(plain, new Set([1]))).toBeNull();
    expect(groupVoteRows(plain, 8)).toBeNull();
  });
});

// Type-level: the spec union narrows on `kind`.
const _narrow = (s: GroupMemberSpec): number =>
  s.kind === "range" ? s.last - s.first : s.indices.length;
void _narrow;
