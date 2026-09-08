import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { buildHdbscanHierarchy } from "./hdbscanHierarchy";

/** Deterministic PRNG so failures reproduce. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const collectNodes = (root: ClusterTreeNode): ClusterTreeNode[] => {
  const out: ClusterTreeNode[] = [];
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    out.push(node);
    if (node.leftChild) stack.push(node.leftChild);
    if (node.rightChild) stack.push(node.rightChild);
  }
  return out;
};

const leafIndices = (root: ClusterTreeNode): number[] =>
  collectNodes(root)
    .filter((n) => !n.leftChild && !n.rightChild)
    .map((n) => n.leafIndex!)
    .sort((a, b) => a - b);

/** Brute-force mutual-reachability MST edge weights (squared euclidean). */
const bruteForceMstWeights = (
  pts: { x: number; y: number }[],
  minSamples: number
): number[] => {
  const n = pts.length;
  const d2 = (i: number, j: number) => {
    const dx = pts[i].x - pts[j].x;
    const dy = pts[i].y - pts[j].y;
    return dx * dx + dy * dy;
  };
  const core = pts.map((_, i) => {
    const ds = pts.map((_, j) => d2(i, j)).filter((_, j) => j !== i);
    ds.sort((a, b) => a - b);
    return ds[Math.min(minSamples - 1, ds.length - 1)];
  });
  const w = (i: number, j: number) => Math.max(d2(i, j), core[i], core[j]);
  const inTree = new Array(n).fill(false);
  const minW = new Array(n).fill(Infinity);
  inTree[0] = true;
  for (let j = 1; j < n; j++) minW[j] = w(0, j);
  const weights: number[] = [];
  for (let e = 0; e < n - 1; e++) {
    let best = Infinity;
    let bestI = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && minW[i] < best) {
        best = minW[i];
        bestI = i;
      }
    }
    weights.push(best);
    inTree[bestI] = true;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) minW[i] = Math.min(minW[i], w(bestI, i));
    }
  }
  return weights.sort((a, b) => a - b);
};

describe("buildHdbscanHierarchy", () => {
  it("returns null for empty input and a single-leaf root for one point", () => {
    expect(buildHdbscanHierarchy([])).toBeNull();
    const root = buildHdbscanHierarchy([{ x: 3, y: 4 }])!;
    expect(root.size).toBe(1);
    expect(root.leafIndex ?? root.children?.[0]).toBe(0);
    expect(root.bbox).toEqual({ minX: 3, minY: 4, maxX: 3, maxY: 4 });
  });

  it("builds a full binary dendrogram with a leafIndex bijection and bboxes", () => {
    const rand = mulberry32(42);
    const pts = Array.from({ length: 60 }, () => ({ x: rand() * 10, y: rand() * 10 }));
    const root = buildHdbscanHierarchy(pts)!;

    const nodes = collectNodes(root);
    expect(nodes).toHaveLength(2 * pts.length - 1);
    expect(leafIndices(root)).toEqual(pts.map((_, i) => i));
    expect(root.size).toBe(pts.length);

    for (const node of nodes) {
      expect(node.bbox).toBeDefined();
      if (node.leftChild && node.rightChild) {
        // bbox is the union of the children's bboxes.
        expect(node.bbox!.minX).toBe(
          Math.min(node.leftChild.bbox!.minX, node.rightChild.bbox!.minX)
        );
        expect(node.bbox!.maxY).toBe(
          Math.max(node.leftChild.bbox!.maxY, node.rightChild.bbox!.maxY)
        );
        expect(node.size).toBe(node.leftChild.size + node.rightChild.size);
        // Cut math in getCollapsedClusters needs child.distance ≤ parent's.
        expect(node.leftChild.distance).toBeLessThanOrEqual(node.distance);
        expect(node.rightChild.distance).toBeLessThanOrEqual(node.distance);
      }
    }
  });

  it("matches the brute-force mutual-reachability MST edge weights", () => {
    const rand = mulberry32(7);
    const pts = Array.from({ length: 40 }, () => ({ x: rand() * 5, y: rand() * 5 }));
    const root = buildHdbscanHierarchy(pts)!;

    // Internal-node formation weights = MST edge weights. In the emitted
    // tree the formation weight of a node is its children's `distance`.
    const merges = collectNodes(root)
      .filter((n) => n.leftChild)
      .map((n) => n.leftChild!.distance)
      .sort((a, b) => a - b);
    const expected = bruteForceMstWeights(pts, 1);
    expect(merges).toHaveLength(expected.length);
    merges.forEach((w, i) => expect(w).toBeCloseTo(expected[i], 9));
  });

  it("separates two well-separated blobs at the root", () => {
    const rand = mulberry32(99);
    const blob = (cx: number, cy: number, offset: number) =>
      Array.from({ length: 20 }, (_, i) => ({
        x: cx + rand(),
        y: cy + rand(),
        index: offset + i,
      }));
    const pts = [...blob(0, 0, 0), ...blob(100, 100, 20)];
    const root = buildHdbscanHierarchy(pts)!;

    const sides = [root.leftChild!, root.rightChild!].map((n) => leafIndices(n));
    const low = sides.find((s) => s.includes(0))!;
    const high = sides.find((s) => s.includes(20))!;
    expect(low).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(high).toEqual(Array.from({ length: 20 }, (_, i) => 20 + i));
  });

  it("keeps stabilities finite and non-negative, root pinned to 0", () => {
    const rand = mulberry32(1);
    const pts = Array.from({ length: 30 }, () => ({ x: rand(), y: rand() }));
    // Duplicates: zero-distance merges must not produce Infinity/NaN.
    pts.push({ ...pts[0] }, { ...pts[0] });
    const root = buildHdbscanHierarchy(pts)!;
    expect(root.stability).toBe(0);
    for (const node of collectNodes(root)) {
      expect(Number.isFinite(node.stability)).toBe(true);
      expect(node.stability).toBeGreaterThanOrEqual(0);
    }
  });

  it("reports monotonically increasing progress ending at 1", () => {
    const rand = mulberry32(5);
    const pts = Array.from({ length: 50 }, () => ({ x: rand(), y: rand() }));
    const fractions: number[] = [];
    buildHdbscanHierarchy(pts, { onProgress: (f) => fractions.push(f) });
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
    }
  });
});
