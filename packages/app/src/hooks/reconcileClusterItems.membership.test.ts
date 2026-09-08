// Behavior guards for the #322 membership fast paths: unchanged memberships
// (pairwise-identical instances) must not disturb settled elements, reordered
// memberships still count as equal (exact multiset fallback), and genuine
// changes are detected exactly as before the caches existed.
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { VisualElementType } from "src/models/VisualElement";
import { reconcileClusterItems } from "./reconcileClusterItems";

const point = (id: number, line = 0, x = 0, y = 0): DataPoint =>
  ({
    id,
    line,
    x,
    y,
    algo: "a",
    action: "",
    DoI: 1,
    doiGroup: "annotation",
    nextEdgeCenter: { x, y },
  }) as unknown as DataPoint;

const opts = {
  kind: "node" as const,
  type: VisualElementType.Annotation,
  datasetType: "default",
};

test("unchanged membership (same instances, same order) leaves the item cold", () => {
  const a = point(1, 0, 0, 0);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: [a, b] }, opts);
  expect(first).toHaveLength(1);
  first[0].element.temperature = 0;
  const prevSamples = first[0].element.samples;

  // Fresh array, identical instances in identical order — the per-tick pan case.
  const second = reconcileClusterItems(first, { c1: [a, b] }, opts);
  expect(second[0].element).toBe(first[0].element);
  expect(second[0].element.samples).toBe(prevSamples); // not swapped
  expect(second[0].element.temperature).toBe(0); // not reheated
});

test("reordered membership still counts as unchanged (multiset fallback)", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: [a, b] }, opts);
  first[0].element.temperature = 0;

  const second = reconcileClusterItems(first, { c1: [b, a] }, opts);
  expect(second[0].element.temperature).toBe(0);
});

test("changed membership is detected and rewarms the element", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const c = point(3, 0, 4, 0);
  const first = reconcileClusterItems([], { c1: [a, b] }, opts);
  first[0].element.temperature = 0;

  const next = [a, c];
  const second = reconcileClusterItems(first, { c1: next }, opts);
  expect(second[0].element.samples).toBe(next); // swapped to the new array
  expect(second[0].element.temperature).toBeGreaterThan(0);
});

test("duplicate-aware: [a, a] differs from [a, b] of equal length", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: [a, a] }, opts);
  first[0].element.temperature = 0;

  const second = reconcileClusterItems(first, { c1: [a, b] }, opts);
  expect(second[0].element.temperature).toBeGreaterThan(0);
});

// Server-computed inset seeds (issue #315 S3/S4): a genuinely NEW inset
// without a remembered position starts AT the server seed with temperature 0
// (annealer polish-only); the mental-map memory still wins over the seed.
test("a new inset seeds from precomputedInsetPositions with temperature 0", () => {
  const a = point(1, 0, 10, 10);
  const b = point(2, 0, 12, 10);
  const items = reconcileClusterItems([], { fresh1: [a, b] }, {
    kind: "node" as const,
    type: VisualElementType.Inset,
    datasetType: "default",
    resetAll: true, // clears the module-level inset position memory
    idSuffix: "::seedtest1",
    precomputedInsetPositions: new Map([["fresh1", { x: 42, y: -7 }]]),
  });
  expect(items).toHaveLength(1);
  expect(items[0].element.center).toEqual({ x: 42, y: -7 });
  expect(items[0].element.temperature).toBe(0);
});

// Range-keyed membership digests (issue #315 insets-at-boot I2): a
// full-membership array carries cutDrivenGroups' `__leafRange` marker, and
// tree+fit+hierarchyId+ranges then decide equality exactly — no O(members)
// per-point hashing (the boot winners span the whole dataset).
const mark = (
  arr: DataPoint[],
  ranges: Array<[number, number]>,
  hierarchyId = 1
): DataPoint[] => {
  Object.defineProperty(arr, "__leafRange", {
    value: { tree: "points", ranges, hierarchyId },
    enumerable: false,
    configurable: true,
  });
  return arr;
};

test("equal range markers count as unchanged without touching the points", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: mark([a, b], [[0, 1]]) }, opts);
  first[0].element.temperature = 0;

  const second = reconcileClusterItems(first, { c1: mark([a, b], [[0, 1]]) }, opts);
  expect(second[0].element.temperature).toBe(0);
  // The range signature replaced the per-point digest — no hash install.
  expect(Object.prototype.hasOwnProperty.call(a, "__memberHash")).toBe(false);
});

test("different range markers rewarm (and different hierarchies never equate)", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: mark([a, b], [[0, 1]], 1) }, opts);
  first[0].element.temperature = 0;
  const second = reconcileClusterItems(first, { c1: mark([a, b], [[0, 1]], 2) }, opts);
  expect(second[0].element.temperature).toBeGreaterThan(0);

  second[0].element.temperature = 0;
  const third = reconcileClusterItems(second, { c1: mark([a, b], [[0, 2]], 2) }, opts);
  expect(third[0].element.temperature).toBeGreaterThan(0);
});

test("mixed marked/unmarked arrays with identical members still count equal", () => {
  const a = point(1);
  const b = point(2, 0, 2, 0);
  const first = reconcileClusterItems([], { c1: mark([a, b], [[0, 1]]) }, opts);
  first[0].element.temperature = 0;

  // Same members, reordered, NO marker — the digest representations differ,
  // so the exact identity-set comparison must decide, not the digest reject.
  const second = reconcileClusterItems(first, { c1: [b, a] }, opts);
  expect(second[0].element.temperature).toBe(0);
});

test("without a server seed a new inset keeps the heuristic placement", () => {
  const a = point(1, 0, 10, 10);
  const b = point(2, 0, 12, 10);
  const items = reconcileClusterItems([], { fresh2: [a, b] }, {
    kind: "node" as const,
    type: VisualElementType.Inset,
    datasetType: "default",
    resetAll: true,
    idSuffix: "::seedtest2",
  });
  expect(items).toHaveLength(1);
  // The heuristic pushes outside the contour — anything but the raw seed
  // marker; the exact value is the pushPointOutsideContour output.
  expect(items[0].element.center).not.toEqual({ x: 42, y: -7 });
});
