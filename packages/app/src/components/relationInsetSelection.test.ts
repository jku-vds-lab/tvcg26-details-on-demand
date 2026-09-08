import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { selectVisibleRelationInsets } from "./relationInsetSelection";

function makeItem(
  uidA: string,
  uidB: string,
  score = 1,
  onSpline = false
): ClusterItem {
  return {
    element: {
      id: `relation-${uidA}-${uidB}`,
      relationAnchors: { uidA, uidB, forwardScore: score, backwardScore: 0, onSpline },
    },
    hull: null,
  } as unknown as ClusterItem;
}

describe("selectVisibleRelationInsets", () => {
  const floating = [
    makeItem("A", "B", 5),
    makeItem("A", "C", 4),
    makeItem("B", "C", 3),
    makeItem("D", "E", 2),
    makeItem("A", "D", 1),
  ];

  describe("no hover (hoveredUid = null)", () => {
    it("returns the top `budget` floating items when no on-spline items exist", () => {
      const result = selectVisibleRelationInsets(floating, [], null, 3);
      expect(result.floating).toEqual(floating.slice(0, 3));
      expect(result.onSpline).toHaveLength(0);
    });

    it("caps floating and on-spline items jointly by combined score", () => {
      const onSpline = [makeItem("F", "G", 4.5, true), makeItem("H", "I", 0.5, true)];
      const result = selectVisibleRelationInsets(floating, onSpline, null, 3);
      // Score order: A-B (5), F-G (4.5), A-C (4) — the low-score on-spline
      // item and the remaining floating items fall outside the budget.
      expect(result.floating).toEqual(floating.slice(0, 2));
      expect(result.onSpline).toEqual([onSpline[0]]);
    });

    it("preserves each list's relative order after the re-split", () => {
      const onSpline = [makeItem("F", "G", 4.5, true), makeItem("H", "I", 3.5, true)];
      const result = selectVisibleRelationInsets(floating, onSpline, null, 4);
      // Kept: A-B (5), F-G (4.5), A-C (4), H-I (3.5).
      expect(result.floating.map(({ element }) => element.id)).toEqual([
        "relation-A-B",
        "relation-A-C",
      ]);
      expect(result.onSpline.map(({ element }) => element.id)).toEqual([
        "relation-F-G",
        "relation-H-I",
      ]);
    });

    it("returns everything when budget exceeds the total", () => {
      const onSpline = [makeItem("F", "G", 0.5, true)];
      const result = selectVisibleRelationInsets(floating, onSpline, null, 100);
      expect(result.floating).toEqual(floating);
      expect(result.onSpline).toEqual(onSpline);
    });

    it("returns empty lists when budget is 0", () => {
      const onSpline = [makeItem("F", "G", 9, true)];
      const result = selectVisibleRelationInsets(floating, onSpline, null, 0);
      expect(result.floating).toHaveLength(0);
      expect(result.onSpline).toHaveLength(0);
    });

    it("clamps a negative budget to 0", () => {
      const result = selectVisibleRelationInsets(floating, [], null, -3);
      expect(result.floating).toHaveLength(0);
    });

    it("breaks score ties deterministically by element id", () => {
      const tiedA = makeItem("A", "A2", 2);
      const tiedB = makeItem("B", "B2", 2);
      const result = selectVisibleRelationInsets([tiedB, tiedA], [], null, 1);
      // "relation-A-A2" < "relation-B-B2" → A wins the single slot.
      expect(result.floating).toEqual([tiedA]);
    });
  });

  describe("hover mode (hoveredUid != null)", () => {
    it("returns all floating items involving the hovered uid (uncapped)", () => {
      const result = selectVisibleRelationInsets(floating, [], "A", 1);
      expect(result.floating).toHaveLength(3); // A-B, A-C, A-D
      expect(
        result.floating.every(({ element }) => {
          const a = element.relationAnchors;
          return a?.uidA === "A" || a?.uidB === "A";
        })
      ).toBe(true);
    });

    it("returns empty floating list when hovered uid has no relations", () => {
      const result = selectVisibleRelationInsets(floating, [], "Z", 10);
      expect(result.floating).toHaveLength(0);
    });

    it("matches on both uidA and uidB", () => {
      const result = selectVisibleRelationInsets(floating, [], "C", 10);
      expect(result.floating).toHaveLength(2); // A-C, B-C
    });

    it("is uncapped regardless of budget, and leaves on-spline items untouched", () => {
      const onSpline = [makeItem("F", "G", 9, true)];
      const result = selectVisibleRelationInsets(floating, onSpline, "A", 0);
      expect(result.floating).toHaveLength(3);
      expect(result.onSpline).toEqual(onSpline);
    });
  });
});
