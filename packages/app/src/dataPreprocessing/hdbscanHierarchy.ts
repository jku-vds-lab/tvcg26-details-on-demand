// packages/app/src/dataPreprocessing/hdbscanHierarchy.ts
//
// Scalable replacement for ExtendedHDBSCAN.fit() on the simple-format
// loading path (issue #218 follow-up: 10k–40k-row CSVs OOM'd/froze the
// tab). hdbscan-ts materializes a full n×n distance matrix (O(n²) memory,
// ~13 GB at 40k rows) and rebuilds point-membership arrays per hierarchy
// split (O(n³)-ish time). This module computes the identical single-linkage
// hierarchy over the mutual-reachability graph in O(n) memory / O(n²) time:
//   1. core distances from the exact grid-bucketed kNN (knnGraph.ts),
//   2. MST via Prim on the *implicit* mutual-reachability graph
//      (edge weight = max(d², core²_i, core²_j) — squared euclidean, the
//      same convention hdbscan-ts uses),
//   3. dendrogram via ascending Kruskal merges (union-find), emitted as a
//      lightweight ClusterTreeNode tree: leaves carry leafIndex, internal
//      nodes carry no materialized children arrays — exactly the shape of
//      the offline-precomputed trees that useRehydrateHdbscan already
//      hydrates (lazy children getters over the DFS leaf order).
//
// Node field semantics mirror hdbscan-ts so downstream cut math is
// unchanged: node.distance = weight of the merge that absorbed the node
// into its parent (root: its own formation weight) — this keeps
// child.distance ≤ parent.distance, which getCollapsedClusters relies on.
// stability follows the hdbscan-ts formula (1/leave − 1/birth)·size with
// birth = distance; the root is pinned to 0 (shouldSkipRootCluster).

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { computeKnnGraph, type KnnPoint } from "./knnGraph";

export interface HdbscanHierarchyOptions {
  /** Core-distance neighbor count (sklearn min_samples). Default 1. */
  minSamples?: number;
  /** MST progress callback, called with a 0..1 fraction every ~1k merges. */
  onProgress?: (fraction: number) => void;
}

const formatUid = (n: number): string => `0x${n.toString(16).toUpperCase()}`;

const squaredDistance = (a: KnnPoint, b: KnnPoint): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

/**
 * Build the HDBSCAN single-linkage hierarchy for 2D points.
 * Returns null for empty input; a single-leaf root for one point.
 */
export function buildHdbscanHierarchy(
  points: readonly KnnPoint[],
  options: HdbscanHierarchyOptions = {}
): ClusterTreeNode | null {
  const n = points.length;
  if (n === 0) return null;
  if (n === 1) {
    const { x, y } = points[0];
    return {
      id: 0,
      uid: formatUid(1),
      children: [0],
      leafIndex: 0,
      distance: 0,
      size: 1,
      stability: 0,
      bbox: { minX: x, minY: y, maxX: x, maxY: y },
    };
  }

  const minSamples = Math.max(1, options.minSamples ?? 1);
  const onProgress = options.onProgress;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i].x;
    ys[i] = points[i].y;
  }

  // Core distances (squared): distance to the minSamples-th nearest other
  // point. The kNN rows are self-inclusive and ascending, so the last entry
  // of a (minSamples+1)-row is that neighbor.
  const knn = computeKnnGraph(points, minSamples + 1);
  const coreD2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const row = knn[i];
    coreD2[i] = squaredDistance(points[i], points[row[row.length - 1]]);
  }

  // Prim MST over the implicit mutual-reachability graph: O(n) memory.
  // `unvisited` is a shrinking swap-remove list so each pass only touches
  // points still outside the tree.
  const edgesU = new Int32Array(n - 1);
  const edgesV = new Int32Array(n - 1);
  const edgesW = new Float64Array(n - 1);
  const minW = new Float64Array(n).fill(Infinity);
  const minTo = new Int32Array(n);
  const unvisited = new Int32Array(n - 1);
  for (let i = 1; i < n; i++) unvisited[i - 1] = i;
  let remaining = n - 1;
  let current = 0;

  for (let e = 0; e < n - 1; e++) {
    const cx = xs[current];
    const cy = ys[current];
    const cCore = coreD2[current];
    let best = Infinity;
    let bestPos = -1;
    for (let pos = 0; pos < remaining; pos++) {
      const i = unvisited[pos];
      const dx = xs[i] - cx;
      const dy = ys[i] - cy;
      let w = dx * dx + dy * dy;
      if (w < cCore) w = cCore;
      const ci = coreD2[i];
      if (w < ci) w = ci;
      if (w < minW[i]) {
        minW[i] = w;
        minTo[i] = current;
      }
      const wi = minW[i];
      if (wi < best) {
        best = wi;
        bestPos = pos;
      }
    }
    const bestI = unvisited[bestPos];
    edgesU[e] = minTo[bestI];
    edgesV[e] = bestI;
    edgesW[e] = best;
    remaining--;
    unvisited[bestPos] = unvisited[remaining];
    current = bestI;
    if (onProgress && (e & 1023) === 0) onProgress(e / (n - 1));
  }

  // Kruskal-style dendrogram over the MST edges, ascending by weight.
  // Leaves are node ids 0..n-1; internal nodes n..2n-2 in merge order, so a
  // child's id is always smaller than its parent's (single ascending passes
  // suffice for bbox/stability, no recursion anywhere).
  const edgeOrder = Array.from({ length: n - 1 }, (_, i) => i).sort(
    (a, b) => edgesW[a] - edgesW[b]
  );

  const total = 2 * n - 1;
  const left = new Int32Array(total).fill(-1);
  const right = new Int32Array(total).fill(-1);
  const size = new Int32Array(total).fill(1);
  const formW = new Float64Array(total); // weight of the merge forming the node
  const dist = new Float64Array(total); // hdbscan-ts node.distance (see header)
  const leaveW = new Float64Array(total); // max first-incident-edge weight inside

  // Union-find with path halving; nodeOf[root] = current dendrogram node.
  const ufParent = new Int32Array(n);
  const nodeOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    ufParent[i] = i;
    nodeOf[i] = i;
  }
  const find = (x: number): number => {
    while (ufParent[x] !== x) {
      ufParent[x] = ufParent[ufParent[x]];
      x = ufParent[x];
    }
    return x;
  };

  let next = n;
  for (const e of edgeOrder) {
    const ra = find(edgesU[e]);
    const rb = find(edgesV[e]);
    const a = nodeOf[ra];
    const b = nodeOf[rb];
    const w = edgesW[e];
    const m = next++;
    left[m] = a;
    right[m] = b;
    formW[m] = w;
    size[m] = size[a] + size[b];
    // A point's minimum incident MST edge inside any containing cluster is
    // the (ascending) edge that first connected it — so a singleton child
    // contributes this merge's weight, an internal child its own value.
    const la = size[a] === 1 ? w : leaveW[a];
    const lb = size[b] === 1 ? w : leaveW[b];
    leaveW[m] = la > lb ? la : lb;
    dist[a] = w;
    dist[b] = w;
    ufParent[rb] = ra;
    nodeOf[ra] = m;
  }
  const rootId = total - 1;
  dist[rootId] = formW[rootId];

  // Materialize nested nodes ascending (children exist before parents).
  const nodes = new Array<ClusterTreeNode>(total);
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    nodes[i] = {
      id: i,
      uid: formatUid(i + 1),
      leafIndex: i,
      distance: dist[i],
      size: 1,
      stability: 0,
      birthDistance: dist[i],
      bbox: { minX: x, minY: y, maxX: x, maxY: y },
    };
  }
  for (let i = n; i < total; i++) {
    const l = nodes[left[i]];
    const r = nodes[right[i]];
    const lb = l.bbox!;
    const rb = r.bbox!;
    const leave = leaveW[i];
    const birth = dist[i];
    const stability =
      i === rootId || leave <= 0 || birth <= 0
        ? 0
        : (1 / leave - 1 / birth) * size[i];
    nodes[i] = {
      id: i,
      uid: formatUid(i + 1),
      distance: birth,
      size: size[i],
      stability,
      birthDistance: birth,
      leftChild: l,
      rightChild: r,
      bbox: {
        minX: lb.minX < rb.minX ? lb.minX : rb.minX,
        minY: lb.minY < rb.minY ? lb.minY : rb.minY,
        maxX: lb.maxX > rb.maxX ? lb.maxX : rb.maxX,
        maxY: lb.maxY > rb.maxY ? lb.maxY : rb.maxY,
      },
    };
  }

  onProgress?.(1);
  return nodes[rootId];
}
