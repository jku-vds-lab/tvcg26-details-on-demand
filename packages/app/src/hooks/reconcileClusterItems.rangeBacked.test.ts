/**
 * Reconcile over index-backed (holey) group arrays (issue #315 R1c).
 *
 * THE trap pinned first: an index-backed group's slots are holes, so the
 * #322 pairwise fast path would compare `undefined === undefined` and
 * false-report two DIFFERENT memberships as identical — the spec branch
 * must decide before any slot read. Also pinned: equal specs across
 * rebuilt arrays stay cold, mixed spec/plain pairs count as changed
 * (residency transition), and centroids resolve columnar (no row reads).
 */

import { registerGroupMembers } from "src/clustering/groupMembers";
import type { PointColumns as SidecarPointColumns } from "src/dataPreprocessing/columnSidecar";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { createLazyRowArray } from "src/dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "src/dataPreprocessing/pointColumns";
import { VisualElementType } from "src/models/VisualElement";
import { reconcileClusterItems } from "./reconcileClusterItems";

const N = 240;

function lazyNodes(): DataPoint[] {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = 2 * i;
    line[i] = 0;
    id[i] = i + 1;
  }
  const sc: SidecarPointColumns = { count: N, byName: { x, y, line, id } };
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols);
}

function listGroup(nodes: DataPoint[], indices: number[], hierarchyId = 1): DataPoint[] {
  const samples = new Array<DataPoint>(indices.length);
  registerGroupMembers(samples, {
    kind: "list",
    nodes,
    hierarchyId,
    indices: Int32Array.from(indices),
  });
  return samples;
}

const opts = {
  kind: "node" as const,
  type: VisualElementType.Annotation,
  datasetType: "default",
};

test("two DIFFERENT index-backed memberships of equal length are detected as changed", () => {
  const nodes = lazyNodes();
  // Same mean x/y by construction, so ONLY the membership distinguishes
  // them — a pairwise slot compare would see undefined === undefined.
  const first = reconcileClusterItems([], { c1: listGroup(nodes, [210, 214]) }, opts);
  expect(first).toHaveLength(1);
  first[0].element.temperature = 0;

  const next = listGroup(nodes, [211, 213]);
  const second = reconcileClusterItems(first, { c1: next }, opts);
  expect(second[0].element.samples).toBe(next); // swapped
  expect(second[0].element.temperature).toBeGreaterThan(0);
});

test("equal index-backed memberships across rebuilt arrays stay cold", () => {
  const nodes = lazyNodes();
  const first = reconcileClusterItems([], { c1: listGroup(nodes, [210, 214]) }, opts);
  first[0].element.temperature = 0;
  const prevSamples = first[0].element.samples;

  // Fresh array + fresh spec object, same indices — the per-commit rebuild.
  const second = reconcileClusterItems(first, { c1: listGroup(nodes, [210, 214]) }, opts);
  expect(second[0].element.samples).toBe(prevSamples); // not swapped
  expect(second[0].element.temperature).toBe(0);
});

test("same indices under a DIFFERENT hierarchy count as changed", () => {
  const nodes = lazyNodes();
  const first = reconcileClusterItems([], { c1: listGroup(nodes, [210, 214], 1) }, opts);
  first[0].element.temperature = 0;

  const second = reconcileClusterItems(first, { c1: listGroup(nodes, [210, 214], 2) }, opts);
  expect(second[0].element.temperature).toBeGreaterThan(0);
});

test("a spec'd vs plain-row pair (residency transition) counts as changed", () => {
  const nodes = lazyNodes();
  const first = reconcileClusterItems([], { c1: listGroup(nodes, [10, 20]) }, opts);
  first[0].element.temperature = 0;

  // Rows 10/20 are inside the eager prefix — a resident-lane rebuild would
  // hand real rows.
  const plain = [nodes[10], nodes[20]];
  const second = reconcileClusterItems(first, { c1: plain }, opts);
  expect(second[0].element.samples).toBe(plain);
  expect(second[0].element.temperature).toBeGreaterThan(0);
});

test("centroids resolve columnar — no member row is built", () => {
  const nodes = lazyNodes();
  const items = reconcileClusterItems([], { c1: listGroup(nodes, [220, 230]) }, opts);
  expect(items[0].element.sourcePosition.x).toBeCloseTo(225);
  expect(items[0].element.sourcePosition.y).toBeCloseTo(450);
  // The columnar mean + hull left the canonical holes untouched.
  expect(220 in nodes).toBe(false);
  expect(230 in nodes).toBe(false);
});
