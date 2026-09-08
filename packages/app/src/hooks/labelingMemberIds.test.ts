/**
 * Labeling-assign membership on index-backed groups (issue #315 R1c E2E
 * finding). The registered group of a cluster uid is a HOLEY array on the
 * server lane — the old `for...of` slot walk crashed the inline assign
 * (`undefined.id`) live in the browser. Pinned here:
 *
 *   (1) a spec'd (holey) registered group yields its ids via the member
 *       spec's columnar refs — no throw, no slot reads,
 *   (2) a plain registered array keeps the slot walk,
 *   (3) an unregistered uid keeps the legacy per-point cluster-id scan.
 */

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "../dataPreprocessing/columnSidecar";
import { createLazyRowArray } from "../dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "../dataPreprocessing/pointColumns";
import { registerGroupClusterUid, resetGroupClusterUids } from "../clustering/groupClusterUid";
import { registerGroupMembers } from "../clustering/groupMembers";
import { collectClusterUidMemberIds } from "./labelingMemberIds";

const N = 240; // > the 200-row eager prefix ⇒ the tail is real holes

function lazyNodes(): DataPoint[] {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = i;
    id[i] = 1000 + i;
  }
  const sc: SidecarPointColumns = { count: N, byName: { x, y, line, id } };
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols);
}

afterEach(() => resetGroupClusterUids());

describe("collectClusterUidMemberIds", () => {
  it("resolves a spec'd holey group through columnar refs without slot reads", () => {
    const nodes = lazyNodes();
    const samples = new Array<DataPoint>(10);
    registerGroupMembers(samples, {
      kind: "list",
      nodes,
      hierarchyId: 7,
      indices: Int32Array.from({ length: 10 }, (_v, k) => 210 + k),
    });
    registerGroupClusterUid(samples, "uid-holey");
    const ids = collectClusterUidMemberIds("uid-holey", nodes);
    expect(ids).toEqual(Array.from({ length: 10 }, (_v, k) => String(1210 + k)));
    // The group's slots stayed holes — the ids never walked them.
    for (let k = 0; k < samples.length; k++) expect(k in samples).toBe(false);
  });

  it("keeps the slot walk for plain registered arrays", () => {
    const a = { id: 1, x: 0, y: 0 } as unknown as DataPoint;
    const b = { id: 2, x: 0, y: 0 } as unknown as DataPoint;
    registerGroupClusterUid([a, b], "uid-plain");
    expect(collectClusterUidMemberIds("uid-plain", [])).toEqual(["1", "2"]);
  });

  it("keeps the legacy cluster-id scan for unregistered uids", () => {
    const pts = [
      { id: 5, insetClusterId: 42 },
      { id: 6, annotationClusterId: 42 },
      { id: 7, insetClusterId: 9 },
    ] as unknown as DataPoint[];
    expect(collectClusterUidMemberIds("42", pts)).toEqual(["5", "6"]);
  });
});
