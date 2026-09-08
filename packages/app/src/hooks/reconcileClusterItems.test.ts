import { beforeEach, describe, expect, it } from '@jest/globals';
import { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { setPositions } from "src/layout/layoutStore";
import { makeElementId, VisualElementType } from "src/models/VisualElement";
import { reconcileClusterItems, type ClusterItem } from "./reconcileClusterItems";

const mkPoint = (id: number, x: number, y: number): DataPoint => ({
  x,
  y,
  line: 0,
  algo: "a",
  id,
  action: "",
  DoI: 1,
  doiGroup: "annotation",
  nextEdgeCenter: { x, y },
});

describe("reconcileClusterItems", () => {
  beforeEach(() => {
    setPositions(new Map());
  });

  it("creates items for new groups and drops removed ones", () => {
    const prev: ClusterItem[] = [];
    const groups1 = { A: [mkPoint(1, 0, 0), mkPoint(2, 1, 1)], B: [mkPoint(3, 2, 2)] };

    const next1 = reconcileClusterItems(prev, groups1, {
      kind: "node",
      type: VisualElementType.Annotation,
      datasetType: "dummy",
    });

    expect(next1.map((i) => i.element.id).sort()).toEqual([
      makeElementId("node", VisualElementType.Annotation, "A"),
      makeElementId("node", VisualElementType.Annotation, "B"),
    ]);

    const groups2 = { B: [mkPoint(3, 2, 2)] };
    const next2 = reconcileClusterItems(next1, groups2, {
      kind: "node",
      type: VisualElementType.Annotation,
      datasetType: "dummy",
    });

    expect(next2.map((i) => i.element.id)).toEqual([
      makeElementId("node", VisualElementType.Annotation, "B"),
    ]);
  });

  it("updates samples and sourcePosition when membership changes", () => {
    const groups1 = { A: [mkPoint(1, 0, 0), mkPoint(2, 2, 0)] };
    const items1 = reconcileClusterItems([], groups1, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
    });
    const before = items1[0];
    // Reconcile MUTATES the reused item in place (identity is the contract),
    // so the pre-reconcile placement must be snapshotted by value.
    const centerBefore = { x: before.element.center.x, y: before.element.center.y };

    // Different point instances = changed membership (memberships are
    // canonical DataPoint instances; identity comparison is exact).
    const groups2 = { A: [mkPoint(1, 2, 2), mkPoint(2, 2, 2)] };
    const items2 = reconcileClusterItems(items1, groups2, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
    });

    const after = items2[0];
    // identity preserved
    expect(after.element.id).toBe(before.element.id);
    // samples updated
    expect(after.element.samples).toHaveLength(2);
    // sourcePosition updated to new centroid
    expect(after.element.sourcePosition.x).toBeCloseTo(2);
    expect(after.element.sourcePosition.y).toBeCloseTo(2);
    // inset is re-seeded for changed membership instead of keeping stale placement
    expect(after.element.center.x).not.toBeCloseTo(centerBefore.x);
    expect(after.element.center.y).not.toBeCloseTo(centerBefore.y);
  });

  it("does not reheat or re-anchor when membership is unchanged", () => {
    const p1 = mkPoint(1, 0, 0);
    const p2 = mkPoint(2, 2, 0);
    const groups1 = { A: [p1, p2] };
    const items1 = reconcileClusterItems([], groups1, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
    });

    const before = items1[0];
    before.element.temperature = 0.2;

    // Fresh REORDERED array of the SAME canonical instances — how an
    // unchanged membership actually arrives (rbush returns viewport-ordered
    // hits, groupBy rebuilds arrays per pass; the points themselves are
    // hydrated once). The old fixture rebuilt point OBJECTS with equal ids,
    // which under identity comparison is a genuinely different membership.
    const groups2 = { A: [p2, p1] };
    const items2 = reconcileClusterItems(items1, groups2, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
    });

    const after = items2[0];
    expect(after).toBe(before);
    expect(after.element.temperature).toBeCloseTo(0.2);
    // Source anchor stays on the (unchanged) centroid — no re-anchor churn.
    expect(after.element.sourcePosition.x).toBeCloseTo(1);
    expect(after.element.sourcePosition.y).toBeCloseTo(0);
  });

  it("can force full reset when hierarchy changes", () => {
    const groups1 = { A: [mkPoint(1, 0, 0)] };
    const items1 = reconcileClusterItems([], groups1, {
      kind: "node",
      type: VisualElementType.Annotation,
      datasetType: "dummy",
    });
    const oldRef = items1[0];

    const groups2 = { Z: [mkPoint(5, 5, 5)] };
    const items2 = reconcileClusterItems(items1, groups2, {
      kind: "node",
      type: VisualElementType.Annotation,
      datasetType: "dummy",
      resetAll: true,
    });

    expect(items2.map((i) => i.element.id)).toEqual([
      makeElementId("node", VisualElementType.Annotation, "Z"),
    ]);
    expect(items2[0]).not.toBe(oldRef);
  });

  it("does not reuse stale inset position by id on resetAll", () => {
    const groups1 = { A: [mkPoint(1, 0, 0), mkPoint(2, 1, 0)] };
    const items1 = reconcileClusterItems([], groups1, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
    });

    items1[0].element.center = { x: 100, y: 100 };

    const groups2 = { A: [mkPoint(10, 5, 5), mkPoint(11, 6, 5)] };
    const items2 = reconcileClusterItems(items1, groups2, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
      resetAll: true,
    });

    // With resetAll, reused cluster IDs must not inherit stale previous positions.
    expect(items2[0].element.center.x).not.toBeCloseTo(100);
    expect(items2[0].element.center.y).not.toBeCloseTo(100);
  });

  it("does not reuse stale inset position by membership on resetAll", () => {
    const groups = { A: [mkPoint(1, 0, 0), mkPoint(2, 1, 0)] };
    const items1 = reconcileClusterItems([], groups, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
      idSuffix: "::v1",
    });

    items1[0].element.center = { x: 100, y: 100 };

    const items2 = reconcileClusterItems(items1, groups, {
      kind: "node",
      type: VisualElementType.Inset,
      datasetType: "dummy",
      resetAll: true,
      idSuffix: "::v2",
    });

    // Same membership across versions must not inherit stale settled coordinates.
    expect(items2[0].element.center.x).not.toBeCloseTo(100);
    expect(items2[0].element.center.y).not.toBeCloseTo(100);
  });
});
