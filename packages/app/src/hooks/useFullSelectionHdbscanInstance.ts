// src/hooks/useFullSelectionHdbscanInstance.ts
import { useEffect, useState } from "react";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";

/** ClusterTreeNode augmented with the leaf-range index this hook attaches. */
type IndexedNode = ClusterTreeNode & {
  firstLeaf?: number;
  lastLeaf?: number;
  leftChild?: IndexedNode;
  rightChild?: IndexedNode;
};

function formatUid(n: number) { return `0x${n.toString(16).toUpperCase()}`; }
// Exported for the server-cut golden-parity test (issue #315 S1): the Python
// cut service must assign byte-identical uids.
export function reuid<T extends ClusterTreeNode>(root: T): T {
  let c = 1;
  const dfs = (n: IndexedNode): IndexedNode => {
    const out: IndexedNode = { ...n, uid: formatUid(c++) };
    if (n.leftChild)  out.leftChild  = dfs(n.leftChild);
    if (n.rightChild) out.rightChild = dfs(n.rightChild);
    return out;
  };
  return dfs(root) as T;
}

/**
 * Build one DFS leaf order and annotate every node with [firstLeaf,lastLeaf).
 * Exported for the worker-fit slow path in hdbscanClustering.ts, which must
 * hydrate the worker's lightweight tree exactly like this hook hydrates
 * precomputed ones.
 */
export function indexLeafRanges(root: ClusterTreeNode & { firstLeaf?: number; lastLeaf?: number }) {
  const order: number[] = [];
  const stack: Array<[IndexedNode | undefined, 0 | 1]> = [[root, 0]];

  while (stack.length) {
    const [node, seen] = stack.pop()!;
    if (!node) continue;

    if (!seen) {
      stack.push([node, 1]);
      if (node.rightChild) stack.push([node.rightChild, 0]);
      if (node.leftChild)  stack.push([node.leftChild, 0]);
    } else {
      const isLeaf = !node.leftChild && !node.rightChild;

      if (isLeaf) {
        const idx =
          node.leafIndex != null
            ? node.leafIndex
            : (Array.isArray(node.children) && node.children.length === 1
                ? node.children[0]
                : undefined);

        if (idx == null) {
          // Defensive: empty legacy leaf (shouldn’t happen). Zero-length range.
          node.firstLeaf = order.length;
          node.lastLeaf  = order.length;
          continue;
        }

        const pos = order.length;
        order.push(idx);
        node.firstLeaf = pos;
        node.lastLeaf  = pos + 1;
      } else {
        const l = node.leftChild, r = node.rightChild;
        const first = Math.min(
          l?.firstLeaf ?? Number.POSITIVE_INFINITY,
          r?.firstLeaf ?? Number.POSITIVE_INFINITY
        );
        const last = Math.max(
          l?.lastLeaf ?? Number.NEGATIVE_INFINITY,
          r?.lastLeaf ?? Number.NEGATIVE_INFINITY
        );
        node.firstLeaf = first;
        node.lastLeaf  = last;
      }
    }
  }
  return order;
}


/** Optional: compatibility shim – lazy `children` getter (cached below a cap). */
export function attachLazyChildren(root: ClusterTreeNode, leafOrder: number[], cacheCap = 4000) {
  const stack: Array<IndexedNode | undefined> = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (!n) continue;

    // Keep legacy arrays as-is.
    if (!Array.isArray(n.children) && n.firstLeaf != null && n.lastLeaf != null) {
      let cached: number[] | undefined;
      Object.defineProperty(n, "children", {
        configurable: true,
        enumerable: false, // don’t bloat any re-serialization
        get() {
          if (cached) return cached;
          const start = n.firstLeaf as number;
          const end   = n.lastLeaf  as number;
          const slice = leafOrder.slice(start, end);
          if (slice.length <= cacheCap) cached = slice;
          return slice;
        },
      });
    }

    if (n.leftChild)  stack.push(n.leftChild);
    if (n.rightChild) stack.push(n.rightChild);
  }
}


function extractTreeRoot(maybe: unknown): IndexedNode | undefined {
  if (!maybe || typeof maybe !== "object") return undefined;
  const o = maybe as { hierarchyTree?: IndexedNode; hierarchy?: IndexedNode; tree?: IndexedNode };
  if (o.hierarchyTree) return o.hierarchyTree;
  if (o.hierarchy)     return o.hierarchy;
  if (o.tree)          return o.tree;
  return maybe as IndexedNode; // bare root
}

export interface PrecomputedHdbscanResult {
  hierarchyTree: ClusterTreeNode & { firstLeaf?: number; lastLeaf?: number };
}

export function useRehydrateHdbscan(hdbscanJson: unknown): PrecomputedHdbscanResult | undefined {
  const [result, setResult] = useState<PrecomputedHdbscanResult>();
  useEffect(() => {
    const root = extractTreeRoot(hdbscanJson);
    if (!root) {
      // Input cleared (e.g. after an in-app re-projection): drop the previous
      // tree, otherwise downstream clustering would silently reuse a stale
      // hierarchy over the new coordinates.
      setResult(undefined);
      return;
    }
    const tree = reuid(root);
    const leafOrder =
      (hdbscanJson as { leafOrder?: number[] } | undefined)?.leafOrder ?? indexLeafRanges(tree);
    attachLazyChildren(tree, leafOrder);
    tree._leafOrder = leafOrder; // available to other code paths
    setResult({ hierarchyTree: tree });
  }, [hdbscanJson]);
  return result;
}

export function useRehydrateMidpointHdbscan(hdbscanJson: unknown): PrecomputedHdbscanResult | undefined {
  const [result, setResult] = useState<PrecomputedHdbscanResult>();
  useEffect(() => {
    const root = extractTreeRoot(hdbscanJson);
    if (!root) {
      // See useRehydrateHdbscan: clearing the input must clear the result.
      setResult(undefined);
      return;
    }
    const tree = reuid(root);
    const leafOrder =
      (hdbscanJson as { leafOrder?: number[] } | undefined)?.leafOrder ?? indexLeafRanges(tree);
    attachLazyChildren(tree, leafOrder);
    tree._leafOrder = leafOrder;
    setResult({ hierarchyTree: tree });
  }, [hdbscanJson]);
  return result;
}
