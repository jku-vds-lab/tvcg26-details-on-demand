// packages/app/src/dataPreprocessing/hdbscanTreeWire.ts
//
// Depth-proof wire format for ClusterTreeNode hierarchies crossing the
// worker boundary (2026-08-21 deployed inset-freeze bug). postMessage's
// structured clone serializes nested objects RECURSIVELY in V8, so a
// single-linkage tree with a long merge chain (measured: a ~30k-point lasso
// on all_chess_openings) throws "Maximum call stack size exceeded" inside
// the worker — the recluster dies and the insets silently keep the previous
// field's layout. Every traversal on both sides of the app already uses
// explicit stacks (issue #315); this module closes the last recursive step
// by shipping the tree as flat parallel arrays (index-linked children) and
// rebuilding the identical nested structure iteratively on the other side.
//
// Lossless for the shapes hdbscan.worker produces (buildHdbscanHierarchy):
// id/uid/leafIndex/distance/size/stability/birthDistance/bbox/left/right,
// plus the single-leaf root's legacy materialized `children` array. Lazy
// children getters and _leafOrder are attached AFTER transport (main
// thread), exactly as before.

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";

export interface HdbscanTreeWire {
  /** Flat node count; nodes are indexed 0..count-1 in flatten visit order. */
  count: number;
  /** Index of the root node. */
  rootIndex: number;
  ids: Int32Array;
  uids: string[];
  /** Leaf index per node, -1 for internal nodes. */
  leafIndex: Int32Array;
  /** Child links as flat-array indices, -1 = none. */
  left: Int32Array;
  right: Int32Array;
  distance: Float64Array;
  size: Float64Array;
  stability: Float64Array;
  /** NaN = field absent on that node. */
  birthDistance: Float64Array;
  /** NaN in bboxMinX = bbox absent on that node. */
  bboxMinX: Float64Array;
  bboxMinY: Float64Array;
  bboxMaxX: Float64Array;
  bboxMaxY: Float64Array;
  /** Legacy materialized member arrays (the n=1 root ships one); sparse. */
  legacyChildren: Array<{ index: number; members: number[] }>;
}

/** Iterative flatten — no recursion at any depth. */
export function flattenHdbscanTree(root: ClusterTreeNode): HdbscanTreeWire {
  // Pass 1: collect nodes (pre-order via explicit stack) and index them.
  const nodes: ClusterTreeNode[] = [];
  const indexOf = new Map<ClusterTreeNode, number>();
  const stack: ClusterTreeNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (indexOf.has(node)) continue;
    indexOf.set(node, nodes.length);
    nodes.push(node);
    if (node.rightChild) stack.push(node.rightChild);
    if (node.leftChild) stack.push(node.leftChild);
  }

  const count = nodes.length;
  const wire: HdbscanTreeWire = {
    count,
    rootIndex: 0,
    ids: new Int32Array(count),
    uids: new Array<string>(count),
    leafIndex: new Int32Array(count),
    left: new Int32Array(count),
    right: new Int32Array(count),
    distance: new Float64Array(count),
    size: new Float64Array(count),
    stability: new Float64Array(count),
    birthDistance: new Float64Array(count),
    bboxMinX: new Float64Array(count),
    bboxMinY: new Float64Array(count),
    bboxMaxX: new Float64Array(count),
    bboxMaxY: new Float64Array(count),
    legacyChildren: [],
  };

  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    wire.ids[i] = node.id;
    wire.uids[i] = node.uid;
    wire.leafIndex[i] = node.leafIndex ?? -1;
    wire.left[i] = node.leftChild ? indexOf.get(node.leftChild)! : -1;
    wire.right[i] = node.rightChild ? indexOf.get(node.rightChild)! : -1;
    wire.distance[i] = node.distance;
    wire.size[i] = node.size;
    wire.stability[i] = node.stability;
    wire.birthDistance[i] = node.birthDistance ?? NaN;
    if (node.bbox) {
      wire.bboxMinX[i] = node.bbox.minX;
      wire.bboxMinY[i] = node.bbox.minY;
      wire.bboxMaxX[i] = node.bbox.maxX;
      wire.bboxMaxY[i] = node.bbox.maxY;
    } else {
      wire.bboxMinX[i] = NaN;
    }
    if (Array.isArray(node.children)) {
      wire.legacyChildren.push({ index: i, members: node.children });
    }
  }
  return wire;
}

/** Iterative rebuild — nodes first, links second; no ordering assumptions. */
export function rebuildHdbscanTree(wire: HdbscanTreeWire): ClusterTreeNode {
  const { count } = wire;
  if (count === 0) throw new Error("empty hdbscan tree wire");
  const nodes = new Array<ClusterTreeNode>(count);
  for (let i = 0; i < count; i++) {
    const node: ClusterTreeNode = {
      id: wire.ids[i],
      uid: wire.uids[i],
      distance: wire.distance[i],
      size: wire.size[i],
      stability: wire.stability[i],
    };
    const leafIndex = wire.leafIndex[i];
    if (leafIndex >= 0) node.leafIndex = leafIndex;
    const birth = wire.birthDistance[i];
    if (!Number.isNaN(birth)) node.birthDistance = birth;
    if (!Number.isNaN(wire.bboxMinX[i])) {
      node.bbox = {
        minX: wire.bboxMinX[i],
        minY: wire.bboxMinY[i],
        maxX: wire.bboxMaxX[i],
        maxY: wire.bboxMaxY[i],
      };
    }
    nodes[i] = node;
  }
  for (const { index, members } of wire.legacyChildren) {
    nodes[index].children = members;
  }
  for (let i = 0; i < count; i++) {
    const l = wire.left[i];
    const r = wire.right[i];
    if (l >= 0) nodes[i].leftChild = nodes[l];
    if (r >= 0) nodes[i].rightChild = nodes[r];
  }
  return nodes[wire.rootIndex];
}
