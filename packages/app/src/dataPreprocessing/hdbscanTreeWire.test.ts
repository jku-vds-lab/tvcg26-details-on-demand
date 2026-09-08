// Depth-proof hdbscan tree wire (2026-08-21 inset-freeze bug). Pinned:
// flatten→rebuild is lossless for the shapes the worker produces (real
// buildHdbscanHierarchy output incl. bbox/uid/stability and the n=1 legacy
// children root), and both directions stay iterative — a 100k-deep merge
// chain must round-trip without touching the call-stack limit that killed
// postMessage's recursive structured clone on all_chess_openings lassos.

import { describe, expect, it } from "@jest/globals";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { buildHdbscanHierarchy } from "./hdbscanHierarchy";
import { flattenHdbscanTree, rebuildHdbscanTree } from "./hdbscanTreeWire";

/** Iterative deep-compare of the fields the wire carries (no recursion —
 * the deep-chain case would otherwise blow the test's own stack). */
function expectTreesEqual(a: ClusterTreeNode, b: ClusterTreeNode) {
  const stack: Array<[ClusterTreeNode | undefined, ClusterTreeNode | undefined]> = [[a, b]];
  let visited = 0;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (!x || !y) {
      expect(x).toBe(y); // both absent, or a structural mismatch
      continue;
    }
    visited++;
    expect(y.id).toBe(x.id);
    expect(y.uid).toBe(x.uid);
    expect(y.leafIndex).toBe(x.leafIndex);
    expect(y.distance).toBe(x.distance);
    expect(y.size).toBe(x.size);
    expect(y.stability).toBe(x.stability);
    expect(y.birthDistance).toBe(x.birthDistance);
    expect(y.bbox).toEqual(x.bbox);
    expect(y.children).toEqual(x.children);
    stack.push([x.leftChild, y.leftChild]);
    stack.push([x.rightChild, y.rightChild]);
  }
  return visited;
}

describe("hdbscanTreeWire", () => {
  it("round-trips a real buildHdbscanHierarchy tree losslessly", () => {
    const points = Array.from({ length: 24 }, (_, i) => ({
      x: (i % 5) * 3 + (i % 3) * 0.4,
      y: Math.floor(i / 5) * 2 + (i % 2) * 0.7,
    }));
    const tree = buildHdbscanHierarchy(points, { minSamples: 1 })!;
    const rebuilt = rebuildHdbscanTree(flattenHdbscanTree(tree));
    const visited = expectTreesEqual(tree, rebuilt);
    expect(visited).toBe(2 * points.length - 1); // full single-linkage tree
  });

  it("round-trips the n=1 single-leaf root with its legacy children array", () => {
    const tree = buildHdbscanHierarchy([{ x: 3, y: 4 }])!;
    expect(tree.children).toEqual([0]); // the legacy shape under test
    const rebuilt = rebuildHdbscanTree(flattenHdbscanTree(tree));
    expectTreesEqual(tree, rebuilt);
  });

  it("survives a 100k-deep merge chain (the postMessage stack-overflow shape)", () => {
    // Build the pathological linear dendrogram ITERATIVELY: each internal
    // node's right child is the previous subtree.
    const DEPTH = 100_000;
    let node: ClusterTreeNode = {
      id: 0, uid: "0x1", leafIndex: 0, distance: 0, size: 1, stability: 0,
    };
    for (let i = 1; i <= DEPTH; i++) {
      const leaf: ClusterTreeNode = {
        id: 2 * i - 1, uid: `0x${(2 * i).toString(16).toUpperCase()}`,
        leafIndex: i, distance: i, size: 1, stability: 0,
      };
      node = {
        id: 2 * i, uid: `0x${(2 * i + 1).toString(16).toUpperCase()}`,
        distance: i, size: i + 1, stability: 0.5,
        leftChild: leaf, rightChild: node,
      };
    }

    const wire = flattenHdbscanTree(node);
    expect(wire.count).toBe(2 * DEPTH + 1);
    const rebuilt = rebuildHdbscanTree(wire);

    // Verify the full chain survived, iteratively.
    let depth = 0;
    let cursor: ClusterTreeNode | undefined = rebuilt;
    while (cursor?.rightChild) {
      expect(cursor.leftChild?.leafIndex).toBeDefined();
      cursor = cursor.rightChild;
      depth++;
    }
    expect(depth).toBe(DEPTH);
    expect(cursor?.leafIndex).toBe(0);
  });
});
