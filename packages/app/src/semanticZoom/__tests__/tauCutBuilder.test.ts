/**
 * semanticZoom/__tests__/tauCutBuilder.test.ts
 *
 * Unit tests for the τ-cut based cluster activation system.
 *
 * Key properties verified:
 *  1. Monotonicity: raising τ never increases #components; lowering τ never
 *     decreases #components (may stay same for leaves).
 *  2. Coverage: every in-view point belongs to exactly one component.
 *  3. Extreme zoom-in (τ → 0): all viewport nodes become singletons.
 *  4. Extreme zoom-out (τ ≥ root.distance): single component (root).
 *  5. No nesting: returned nodes are never ancestor-descendant pairs.
 *  6. Viewport filtering (Option A): nodes outside the viewport are excluded.
 *  7. zoomToTau mapping: monotone w.r.t. viewport fraction, tauScale, tauExponent.
 */

import { describe, expect, it } from "@jest/globals";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import { buildAssignment, buildTauCut, tauRange } from "../tauCutBuilder";
import { zoomToTau } from "../zoomToTau";

// ---------------------------------------------------------------------------
// Hierarchy factory
// ---------------------------------------------------------------------------
//
//  root (distance=10, bbox 0-100)
//  ├── L  (distance=5, bbox 0-50)
//  │   ├── LL (distance=0, leaf, bbox 0-25)
//  │   └── LR (distance=0, leaf, bbox 25-50)
//  └── R  (distance=3, bbox 50-100)
//      ├── RL (distance=0, leaf, bbox 50-75)
//      └── RR (distance=0, leaf, bbox 75-100)
//
// Merge distances:
//   root merges L+R at scale 10
//   L    merges LL+LR at scale 5
//   R    merges RL+RR at scale 3

let _id = 0;
let _uid = 0;

function mkLeaf(minX: number, maxX: number): ClusterTreeNode {
  return {
    id: _id++,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: 0,
    size: 1,
    stability: 0.5,
    leafIndex: _id - 1, // reuse id as leaf index for simplicity
    bbox: { minX, minY: 0, maxX, maxY: 10 },
  };
}

function mkInternal(
  minX: number,
  maxX: number,
  dist: number,
  left: ClusterTreeNode,
  right: ClusterTreeNode
): ClusterTreeNode {
  return {
    id: _id++,
    uid: `0x${(_uid++).toString(16).toUpperCase()}`,
    distance: dist,
    size: (left.size ?? 1) + (right.size ?? 1),
    stability: 1.0,
    bbox: { minX, minY: 0, maxX, maxY: 10 },
    leftChild: left,
    rightChild: right,
  };
}

function buildTree() {
  _id = 0;
  _uid = 0;
  const ll = mkLeaf(0, 25);
  const lr = mkLeaf(25, 50);
  const rl = mkLeaf(50, 75);
  const rr = mkLeaf(75, 100);
  const L = mkInternal(0, 50, 5, ll, lr);
  const R = mkInternal(50, 100, 3, rl, rr);
  const root = mkInternal(0, 100, 10, L, R);
  return { root, L, R, ll, lr, rl, rr };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all UIDs in the cut, assert no duplicates. */
function uidSet(cut: ClusterTreeNode[]): Set<string> {
  const s = new Set<string>();
  for (const n of cut) {
    expect(s.has(n.uid)).toBe(false); // no duplicates
    s.add(n.uid);
  }
  return s;
}

/** True if a is an ancestor of b (b is in a's sub-tree). */
function isAncestor(a: ClusterTreeNode, b: ClusterTreeNode): boolean {
  if (a === b) return false;
  function search(node: ClusterTreeNode): boolean {
    if (node === b) return true;
    if (node.leftChild && search(node.leftChild)) return true;
    if (node.rightChild && search(node.rightChild)) return true;
    return false;
  }
  return search(a);
}

// ---------------------------------------------------------------------------
// 1. buildTauCut — basic shape
// ---------------------------------------------------------------------------

describe("buildTauCut — τ = 0 (singletons)", () => {
  it("returns all 4 leaves when τ = 0 (no viewport)", () => {
    const { root, ll, lr, rl, rr } = buildTree();
    const cut = buildTauCut(root, 0, undefined);
    expect(cut).toHaveLength(4);
    const ids = uidSet(cut);
    expect(ids.has(ll.uid)).toBe(true);
    expect(ids.has(lr.uid)).toBe(true);
    expect(ids.has(rl.uid)).toBe(true);
    expect(ids.has(rr.uid)).toBe(true);
  });
});

describe("buildTauCut — τ = root.distance (entire dataset one component)", () => {
  it("returns just the root when τ ≥ root.distance", () => {
    const { root } = buildTree();
    const cut = buildTauCut(root, root.distance, undefined);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBe(root);
  });

  it("also returns root when τ is very large", () => {
    const { root } = buildTree();
    const cut = buildTauCut(root, 1_000_000, undefined);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toBe(root);
  });
});

describe("buildTauCut — intermediate τ values", () => {
  it("τ = 4 splits at the root but not at R (dist=3 ≤ 4), not at L (dist=5 > 4)", () => {
    // With τ=4:
    //   root.distance=10 > 4 → recurse
    //   L.distance=5     > 4 → recurse → ll + lr
    //   R.distance=3     ≤ 4 → R is one component
    // Expected: [ll, lr, R]
    const { root, ll, lr, R } = buildTree();
    const cut = buildTauCut(root, 4, undefined);
    expect(cut).toHaveLength(3);
    const ids = uidSet(cut);
    expect(ids.has(ll.uid)).toBe(true);
    expect(ids.has(lr.uid)).toBe(true);
    expect(ids.has(R.uid)).toBe(true);
  });

  it("τ = 6 splits root, L ≤ 6 is one component, R ≤ 6 is one component", () => {
    // With τ=6:
    //   root.distance=10 > 6 → recurse
    //   L.distance=5     ≤ 6 → L is one component
    //   R.distance=3     ≤ 6 → R is one component
    // Expected: [L, R]
    const { root, L, R } = buildTree();
    const cut = buildTauCut(root, 6, undefined);
    expect(cut).toHaveLength(2);
    const ids = uidSet(cut);
    expect(ids.has(L.uid)).toBe(true);
    expect(ids.has(R.uid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Monotonicity
// ---------------------------------------------------------------------------

describe("buildTauCut — monotonicity", () => {
  it("raising τ never increases the component count", () => {
    const tauLevels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15];
    let prevCount = Infinity;

    for (const tau of tauLevels) {
      const { root } = buildTree();
      const cut = buildTauCut(root, tau, undefined);
      expect(cut.length).toBeLessThanOrEqual(prevCount);
      prevCount = cut.length;
    }
  });

  it("lowering τ never decreases the component count", () => {
    const tauLevels = [15, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    let prevCount = 0;

    for (const tau of tauLevels) {
      const { root } = buildTree();
      const cut = buildTauCut(root, tau, undefined);
      expect(cut.length).toBeGreaterThanOrEqual(prevCount);
      prevCount = cut.length;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Coverage completeness (every leaf covered exactly once)
// ---------------------------------------------------------------------------

describe("buildTauCut — coverage", () => {
  /** Collect all leaf indices reachable from a cut node. */
  function leafIndices(node: ClusterTreeNode): number[] {
    if (node.leftChild == null && node.rightChild == null) {
      return node.leafIndex != null ? [node.leafIndex] : [];
    }
    return [
      ...(node.leftChild ? leafIndices(node.leftChild) : []),
      ...(node.rightChild ? leafIndices(node.rightChild) : []),
    ];
  }

  it("every leaf in the tree is covered exactly once — no viewport", () => {
    for (const tau of [0, 2, 4, 6, 10]) {
      const { root } = buildTree();
      const cut = buildTauCut(root, tau, undefined);
      const allLeaves: number[] = [];
      for (const n of cut) {
        allLeaves.push(...leafIndices(n));
      }
      // 4 leaves total; each must appear exactly once
      expect(allLeaves).toHaveLength(4);
      const uniqueLeaves = new Set(allLeaves);
      expect(uniqueLeaves.size).toBe(4);
    }
  });

  it("covered leaves are exactly those whose bbox intersects the viewport", () => {
    const { root } = buildTree();
    // Viewport covers strictly the left half: x ∈ [0, 49.9], excluding rl (50-75)
    const viewbox = { minX: 0, minY: 0, maxX: 49.9, maxY: 10 };
    const cut = buildTauCut(root, 0, viewbox);
    // With τ=0, should get ll (0-25) and lr (25-50) — rl starts at 50 > 49.9
    expect(cut).toHaveLength(2);
    for (const n of cut) {
      expect(n.bbox!.minX).toBeLessThanOrEqual(49.9);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. No nesting
// ---------------------------------------------------------------------------

describe("buildTauCut — no nesting in result", () => {
  it("no two returned nodes are in an ancestor-descendant relationship", () => {
    for (const tau of [0, 3, 5, 6, 10]) {
      const { root } = buildTree();
      const cut = buildTauCut(root, tau, undefined);
      for (let i = 0; i < cut.length; i++) {
        for (let j = i + 1; j < cut.length; j++) {
          expect(isAncestor(cut[i], cut[j])).toBe(false);
          expect(isAncestor(cut[j], cut[i])).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Viewport filtering (Option A)
// ---------------------------------------------------------------------------

describe("buildTauCut — viewport filtering", () => {
  it("returns empty array when viewbox is entirely outside data range", () => {
    const { root } = buildTree();
    const viewbox = { minX: 200, minY: 200, maxX: 300, maxY: 300 };
    const cut = buildTauCut(root, 10, viewbox);
    expect(cut).toHaveLength(0);
  });

  it("returns only left subtree components when viewbox covers x=[0,50]", () => {
    const { root, ll, lr } = buildTree();
    // τ = 0 → singletons; use 49.9 to strictly exclude rl (bbox starts at 50)
    const viewbox = { minX: 0, minY: 0, maxX: 49.9, maxY: 10 };
    const cut = buildTauCut(root, 0, viewbox);
    const ids = uidSet(cut);
    expect(ids.has(ll.uid)).toBe(true);
    expect(ids.has(lr.uid)).toBe(true);
    expect(cut).toHaveLength(2);
    // rr (x=[75,100]) must NOT be in the cut
    for (const n of cut) {
      expect(n.bbox!.minX).toBeLessThan(75); // no node starting at x≥75
    }
  });

  it("with no viewport, returns same as undefined viewport", () => {
    const { root: r1 } = buildTree();
    const { root: r2 } = buildTree();
    const tau = 4;
    const cutUndefined = buildTauCut(r1, tau, undefined);
    // Use a viewbox that covers everything
    const bigView = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
    const cutBig = buildTauCut(r2, tau, bigView);
    expect(cutUndefined.length).toBe(cutBig.length);
  });
});

// ---------------------------------------------------------------------------
// 6. tauRange
// ---------------------------------------------------------------------------

describe("tauRange", () => {
  it("returns maxTau = root.distance", () => {
    const { root } = buildTree();
    const { maxTau } = tauRange(root);
    expect(maxTau).toBe(root.distance); // 10
  });

  it("returns minTau = smallest non-zero merge distance", () => {
    const { root } = buildTree();
    const { minTau } = tauRange(root);
    // L.distance=5, R.distance=3, leaves=0 (not counted); smallest = 3
    expect(minTau).toBe(3);
  });

  it("minTau ≤ maxTau", () => {
    const { root } = buildTree();
    const { minTau, maxTau } = tauRange(root);
    expect(minTau).toBeLessThanOrEqual(maxTau);
  });
});

// ---------------------------------------------------------------------------
// 7. zoomToTau — mapping properties
// ---------------------------------------------------------------------------

describe("zoomToTau", () => {
  const rootBbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const tauMax = 10;

  it("full viewport (fraction=1) → τ = tauMax × tauScale × 1^exp", () => {
    const viewbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const tau = zoomToTau(viewbox, rootBbox, tauMax, 1.0, 1.0);
    expect(tau).toBeCloseTo(10, 5);
  });

  it("extreme zoom-in (fraction→0) → τ → 0", () => {
    const viewbox = { minX: 50, minY: 50, maxX: 50.001, maxY: 50.001 }; // tiny viewport
    const tau = zoomToTau(viewbox, rootBbox, tauMax, 1.0, 1.0);
    expect(tau).toBeLessThan(0.01);
  });

  it("τ is monotone w.r.t. viewport fraction (more zoom-in → smaller τ)", () => {
    const fractions = [1.0, 0.5, 0.25, 0.1, 0.01, 0.001];
    let prev = Infinity;
    for (const f of fractions) {
      const side = Math.sqrt(f) * 100;
      const viewbox = { minX: 0, minY: 0, maxX: side, maxY: side };
      const tau = zoomToTau(viewbox, rootBbox, tauMax, 1.0, 1.0);
      expect(tau).toBeLessThanOrEqual(prev + 1e-9);
      prev = tau;
    }
  });

  it("τ is monotone w.r.t. tauScale", () => {
    const viewbox = { minX: 0, minY: 0, maxX: 50, maxY: 50 }; // 25% of dataset
    let prev = 0;
    for (const scale of [0, 0.5, 1.0, 1.5, 2.0]) {
      const tau = zoomToTau(viewbox, rootBbox, tauMax, scale, 1.0);
      expect(tau).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = tau;
    }
  });

  it("τ ≥ 0 always", () => {
    const viewbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(zoomToTau(viewbox, rootBbox, 0, 1.0, 1.0)).toBe(0);
    expect(zoomToTau(undefined, undefined, 10, 1.0, 1.0)).toBeGreaterThanOrEqual(0);
  });

  it("undefined viewbox returns tauMax × tauScale (fallback)", () => {
    const tau = zoomToTau(undefined, rootBbox, tauMax, 1.5, 1.0);
    expect(tau).toBeCloseTo(15, 5);
  });

  it("tauExponent > 1 gives smaller τ for same partial zoom than exponent < 1", () => {
    const viewbox = { minX: 0, minY: 0, maxX: 50, maxY: 50 }; // 25%
    const tauSlow = zoomToTau(viewbox, rootBbox, tauMax, 1.0, 0.5);
    const tauFast = zoomToTau(viewbox, rootBbox, tauMax, 1.0, 2.0);
    expect(tauFast).toBeLessThan(tauSlow);
  });
});

// ---------------------------------------------------------------------------
// 8. Extreme zoom end-to-end (τ = 0 → singletons can be annotated)
// ---------------------------------------------------------------------------

describe("buildTauCut — extreme zoom singletons", () => {
  it("τ = 0 on a chain tree (N, N-1 imbalance) still yields all singletons", () => {
    // Build a maximally imbalanced (chain) tree with 5 points:
    //   root (dist=5) → leaf0 + chain4 (dist=4) → leaf1 + chain3 (dist=3) → …
    _id = 0;
    _uid = 0;
    const leaf0 = mkLeaf(0, 1);
    const leaf1 = mkLeaf(1, 2);
    const leaf2 = mkLeaf(2, 3);
    const leaf3 = mkLeaf(3, 4);
    const leaf4 = mkLeaf(4, 5);
    const n3 = mkInternal(3, 5, 1, leaf3, leaf4);
    const n2 = mkInternal(2, 5, 2, leaf2, n3);
    const n1 = mkInternal(1, 5, 3, leaf1, n2);
    const n0 = mkInternal(0, 5, 4, leaf0, n1);

    const cut = buildTauCut(n0, 0, undefined);
    expect(cut).toHaveLength(5);
    const ids = uidSet(cut);
    expect(ids.has(leaf0.uid)).toBe(true);
    expect(ids.has(leaf1.uid)).toBe(true);
    expect(ids.has(leaf2.uid)).toBe(true);
    expect(ids.has(leaf3.uid)).toBe(true);
    expect(ids.has(leaf4.uid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. buildAssignment — full coverage invariant
// ---------------------------------------------------------------------------

/**
 * Simulate `membersOf` by collecting all leaf indices reachable from a node.
 * This mirrors what ClusteringService.membersOf does against the real HDBSCAN tree.
 */
function membersOfTree(node: ClusterTreeNode): number[] {
  const out: number[] = [];
  function walk(n: ClusterTreeNode): void {
    if (n.leftChild == null && n.rightChild == null) {
      if (n.leafIndex != null) out.push(n.leafIndex);
    } else {
      if (n.leftChild) walk(n.leftChild);
      if (n.rightChild) walk(n.rightChild);
    }
  }
  walk(node);
  return out;
}

describe("buildAssignment — full coverage invariant", () => {
  it("every leaf index maps to exactly one unit for various τ values", () => {
    for (const tau of [0, 3, 5, 6, 10]) {
      const { root } = buildTree();
      const partitionUnits = buildTauCut(root, tau, undefined);
      const assignment = buildAssignment(partitionUnits, membersOfTree);

      // 4 leaves with indices 0–3
      expect(assignment.size).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(assignment.has(i)).toBe(true);
        expect(typeof assignment.get(i)).toBe("string");
      }
    }
  });

  it("τ = 0 (isolated singletons): each leaf gets its OWN distinct unit uid", () => {
    // Every leaf is isolated (no qualifying edge at τ=0) — the partition
    // must have 4 singletons, each with a unique unit uid.
    const { root } = buildTree();
    const partitionUnits = buildTauCut(root, 0, undefined);
    const assignment = buildAssignment(partitionUnits, membersOfTree);

    expect(assignment.size).toBe(4);
    const unitUids = new Set(assignment.values());
    expect(unitUids.size).toBe(4); // all unique — no two leaves share a unit
  });

  it("τ removes most edges (chain tree, τ=0): no point is unassigned", () => {
    // 5-point chain tree — all internal merge distances > 0, so τ=0 makes
    // all edges inactive.  Every leaf must still become a singleton unit.
    _id = 0;
    _uid = 0;
    const leaf0 = mkLeaf(0, 1);
    const leaf1 = mkLeaf(1, 2);
    const leaf2 = mkLeaf(2, 3);
    const leaf3 = mkLeaf(3, 4);
    const leaf4 = mkLeaf(4, 5);
    const n3 = mkInternal(3, 5, 1, leaf3, leaf4);
    const n2 = mkInternal(2, 5, 2, leaf2, n3);
    const n1 = mkInternal(1, 5, 3, leaf1, n2);
    const n0 = mkInternal(0, 5, 4, leaf0, n1);

    const partitionUnits = buildTauCut(n0, 0, undefined);
    expect(partitionUnits).toHaveLength(5); // 5 singletons

    const assignment = buildAssignment(partitionUnits, membersOfTree);
    expect(assignment.size).toBe(5); // all 5 leaves covered
    const unitUids = new Set(assignment.values());
    expect(unitUids.size).toBe(5); // all in different units
  });

  it("coverage holds with viewport filtering (only in-view leaves counted)", () => {
    // Viewport covers only the left half; 2 leaves are in-view.
    const { root } = buildTree();
    const viewbox = { minX: 0, minY: 0, maxX: 49.9, maxY: 10 };
    const partitionUnits = buildTauCut(root, 0, viewbox);
    expect(partitionUnits).toHaveLength(2); // ll + lr only

    const assignment = buildAssignment(partitionUnits, membersOfTree);
    // Leaf indices 0 (ll) and 1 (lr) are in-view
    expect(assignment.size).toBe(2);
    expect(assignment.has(0)).toBe(true);
    expect(assignment.has(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Partition ⊇ labeledUnits invariant
// ---------------------------------------------------------------------------

describe("partitionUnits ⊇ labeledUnits — labeled is always a subset", () => {
  it("a simulated budget-capped label set is always a subset of the partition", () => {
    for (const tau of [0, 3, 5, 10]) {
      const { root } = buildTree();
      const partitionUnits = buildTauCut(root, tau, undefined);

      // Simulate a budget of 2 (any selection strategy)
      const labeledUnits = partitionUnits.slice(0, 2);

      // Count invariant: |labeled| ≤ |partition|
      expect(labeledUnits.length).toBeLessThanOrEqual(partitionUnits.length);

      // Membership invariant: every labeled unit is in the partition
      const partitionUidSet = new Set(partitionUnits.map((u) => u.uid));
      for (const lu of labeledUnits) {
        expect(partitionUidSet.has(lu.uid)).toBe(true);
      }
    }
  });

  it("points in non-labeled partition units remain assigned (not 'noise')", () => {
    // The partition covers all 4 leaves.  If budget = 1, 3 leaves have no label
    // but still have a partition-unit assignment.
    const { root } = buildTree();
    const partitionUnits = buildTauCut(root, 0, undefined); // 4 singletons
    const assignment = buildAssignment(partitionUnits, membersOfTree);

    // Simulated budget: only label the first partition unit
    const labeledUids = new Set([partitionUnits[0].uid]);

    // All 4 leaves are assigned to SOME unit — none are undefined/unassigned
    let assignedCount = 0;
    for (let i = 0; i < 4; i++) {
      if (assignment.has(i)) assignedCount++;
    }
    expect(assignedCount).toBe(4); // full coverage regardless of labeledUnits

    // Only 1 leaf's unit is in the labeled set
    const labeledCount = Array.from(assignment.values()).filter((uid) =>
      labeledUids.has(uid)
    ).length;
    expect(labeledCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Refinement monotonicity — τ-cut forms a partition lattice
// ---------------------------------------------------------------------------

describe("refinement monotonicity — τ-cut is a partition lattice", () => {
  it("every unit in cut(τ1) maps entirely into a single unit of cut(τ2) when τ1 ≤ τ2", () => {
    // cut(τ1) is FINER; cut(τ2) is COARSER.
    // Key: no unit from the finer cut can straddle two coarser-cut units.
    const tauPairs: [number, number][] = [
      [0, 3], [0, 5], [0, 10], [3, 5], [3, 10], [5, 10],
    ];

    for (const [tau1, tau2] of tauPairs) {
      const { root } = buildTree();
      const cut1 = buildTauCut(root, tau1, undefined); // finer
      const cut2 = buildTauCut(root, tau2, undefined); // coarser

      // Build the coarser assignment (each leaf → its unit uid at τ2)
      const assign2 = buildAssignment(cut2, membersOfTree);

      // For each finer unit, ALL its leaves must land in the SAME coarser unit.
      for (const unit1 of cut1) {
        const leaves = membersOfTree(unit1);
        if (leaves.length === 0) continue;
        const containingCoarseUnits = new Set(leaves.map((idx) => assign2.get(idx)));
        expect(containingCoarseUnits.size).toBe(1); // exactly one coarser unit
      }
    }
  });

  it("increasing τ cannot split a unit (merges are monotone)", () => {
    // If two points are in the same unit at a given τ, they remain in the same
    // unit or a larger unit at any higher τ.
    const tauSteps = [0, 2, 3, 5, 7, 10];
    const { root } = buildTree();

    let prevAssignment: Map<number, string> | null = null;

    for (const tau of tauSteps) {
      const partitionUnits = buildTauCut(root, tau, undefined);
      const assignment = buildAssignment(partitionUnits, membersOfTree);

      if (prevAssignment !== null) {
        // For any two leaves that were in DIFFERENT units at the previous τ,
        // they can now be in the same unit (merged) or still different —
        // but they can never be MORE split than before.
        // Equivalently: if they were in the SAME unit before, they must still
        // be in the same unit (or a containing unit which has the same uid).
        for (let i = 0; i < 4; i++) {
          for (let j = i + 1; j < 4; j++) {
            const prevSame = prevAssignment.get(i) === prevAssignment.get(j);
            const currSame =      assignment.get(i) ===      assignment.get(j);
            if (prevSame) {
              // Once merged, must stay merged at higher τ
              expect(currSame).toBe(true);
            }
            // (if prevDifferent, they may merge now or stay different — both ok)
          }
        }
      }

      prevAssignment = assignment;
    }
  });

  it("decreasing τ cannot merge two previously separate units", () => {
    // If two points are in DIFFERENT units at a given τ, they cannot be in the
    // same unit at any smaller τ (cuts can only get finer).
    const tauSteps = [10, 7, 5, 3, 2, 0]; // decreasing
    const { root } = buildTree();

    let prevAssignment: Map<number, string> | null = null;

    for (const tau of tauSteps) {
      const partitionUnits = buildTauCut(root, tau, undefined);
      const assignment = buildAssignment(partitionUnits, membersOfTree);

      if (prevAssignment !== null) {
        for (let i = 0; i < 4; i++) {
          for (let j = i + 1; j < 4; j++) {
            const prevDifferent = prevAssignment.get(i) !== prevAssignment.get(j);
            const currDifferent =      assignment.get(i) !==      assignment.get(j);
            if (prevDifferent) {
              // Once split, must stay split at lower τ
              expect(currDifferent).toBe(true);
            }
          }
        }
      }

      prevAssignment = assignment;
    }
  });
});
