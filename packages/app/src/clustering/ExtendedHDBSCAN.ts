import { HDBSCAN } from 'hdbscan-ts';

export interface ClusterTreeNode {
  id: number;
  uid: string;

  /** Legacy: fully materialized member indices; may be absent on lightweight trees. */
  children?: number[];

  /** Only on leaves in the lightweight export. */
  leafIndex?: number;
  /** Server-computed contour vertices (issue #315 D1, server-cut mode). */
  precomputedHull?: Array<[number, number]>;
  /** Server-computed inset seed position in data coords (issue #315 S3/S4,
   * server-cut mode) — the layout seeds from it, the annealer polishes. */
  insetPos?: [number, number];
  /** Server-stamped DoI mass (issue #315 A3 / P-d, plan §6e), copied off the
   * cut candidate: the scoring pass prefers it over the client's leaf-order
   * prefix / member loop. Undefined for locally-walked nodes and whenever no
   * server DoI state exists — the fallbacks then run unchanged. */
  doiMass?: number;

  distance: number;
  size: number;
  stability: number;
  birthDistance?: number;

  leftChild?: ClusterTreeNode;
  rightChild?: ClusterTreeNode;

  /** Axis-aligned bounds of all member points, in data coords. */
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };

  /** DFS leaf-order range [firstLeaf, lastLeaf) used to slice the global leaf order. */
  firstLeaf?: number;
  lastLeaf?: number;

  /** On the root: global DFS leaf order used by lazy children getters (not
   * serialized). `Uint32Array` on the server-cut path (issue #315 P7 S6a —
   * the provider hands back the wire view unboxed); `number[]` for
   * client-built trees. Every reader indexes or takes `.length`. */
  _leafOrder?: number[] | Uint32Array;
}


// Define a type for the internal cluster structure returned by hdbscan-ts.
interface InternalCluster {
  id: number;
  children: number[];
  distance: number;
  size: number;
  stability: number;
  birthDistance?: number;
  leftChild?: InternalCluster;
  rightChild?: InternalCluster;
}

function perturbDuplicates(data: number[][], eps = 1e-9): number[][] {
  const seen = new Map<string, number>();
  return data.map((point) => {
    const key = point.join(',');
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) {
      const perturbed = [...point];
      for (let i = 0; i < perturbed.length; i++) {
        perturbed[i] += (Math.random() * 2 - 1) * eps;
      }
      return perturbed;
    }
    return [...point];
  });
}


export function printClusterTree(
  root: ClusterTreeNode,
  relativeThreshold?: number
): void {
  const collapsedSet = new Set<number>();

  if (relativeThreshold !== undefined) {
    const getTotalDepth = (node: ClusterTreeNode): number => {
      if (!node.leftChild && !node.rightChild) return 0;
      const left = node.leftChild
        ? (node.distance - node.leftChild.distance) + getTotalDepth(node.leftChild)
        : 0;
      const right = node.rightChild
        ? (node.distance - node.rightChild.distance) + getTotalDepth(node.rightChild)
        : 0;
      return Math.max(left, right);
    };

    const collectCollapsedNodes = (
      node: ClusterTreeNode,
      cum: number,
      threshold: number
    ): void => {
      if (cum >= threshold || (!node.leftChild && !node.rightChild)) {
        collapsedSet.add(node.id);
        return;
      }

      if (node.leftChild) {
        collectCollapsedNodes(
          node.leftChild,
          cum + (node.distance - node.leftChild.distance),
          threshold
        );
      }
      if (node.rightChild) {
        collectCollapsedNodes(
          node.rightChild,
          cum + (node.distance - node.rightChild.distance),
          threshold
        );
      }
    };

    const totalDepth = getTotalDepth(root);
    const absoluteThreshold = (1 - Math.pow(relativeThreshold, 5)) * totalDepth;
    collectCollapsedNodes(root, 0, absoluteThreshold);
  }

  const printNode = (
    node: ClusterTreeNode,
    prefix: string,
    isTail: boolean,
    parentDistance: number
  ): void => {
    const branchDiff = parentDistance - node.distance;
    const branchStr = parentDistance > 0 ? ` (+${branchDiff.toFixed(2)})` : "";
    const cutMark = collapsedSet.has(node.id) ? " [CUT]" : "";
    console.log(
      prefix + (isTail ? "└── " : "├── ") + `Node ${node.uid} d:${node.distance.toFixed(2)}${branchStr}${cutMark}`
    );

    if (collapsedSet.has(node.id)) return;

    const children: ClusterTreeNode[] = [];
    if (node.leftChild) children.push(node.leftChild);
    if (node.rightChild) children.push(node.rightChild);

    children.forEach((child, index) => {
      printNode(
        child,
        prefix + (isTail ? "    " : "│   "),
        index === children.length - 1,
        node.distance
      );
    });
  };

  printNode(root, "", true, root.distance);
}

// Define an interface describing the private members we need to access.
interface HDBSCANPrivate {
  clusterMap: Map<number, InternalCluster>;
}

export interface ExtendedHDBSCANOptions {
  minClusterSize: number;
  minSamples?: number;
  alpha?: number;
  group: "annotation" | "inset"; // Grouping for clustering results
}

/**
 * Represents the result of updating labels based on zoom.
 */
export interface ZoomUpdateResult {
  labels: number[];
  activeClusters: ClusterTreeNode[];
  /**
   * UIDs of active clusters that entered via the chain-rescue reserve
   * (semantic-zoom path only; legacy updateLabelsForZoom leaves it unset).
   * Feeds the settings-panel base-vs-chain readout.
   */
  rescuedUids?: string[];
  /**
   * Server-computed annotation/inset split (issue #315 P7 S2): uid → 0 neither
   * / 1 annotation / 2 inset, as selected server-side from the masked
   * visible-member mean DoI. Set ONLY in server-select mode; its presence tells
   * the dispatch tail to skip the client's masked-prefix classification pass
   * entirely (the whole point of the answer lane). Absent everywhere else, so
   * the client-complete and candidates lanes are untouched.
   */
  serverGroups?: Map<string, 0 | 1 | 2>;
}

/**
 * ExtendedHDBSCAN wraps the hdbscan-ts package to expose the internal clustering hierarchy.
 * It provides methods to collapse/expand the tree based on a zoom threshold and update cluster labels.
 */
export class ExtendedHDBSCAN extends HDBSCAN {
  public hierarchyTree: ClusterTreeNode | null = null;
  public group: "annotation" | "inset";

  constructor(options: ExtendedHDBSCANOptions) {
    super({
      minClusterSize: options.minClusterSize,
      minSamples: options.minSamples,
      alpha: options.alpha,
    });
    this.group = options.group;
  }

   /**
   * Recursively assign bbox to each cluster node using its children[] point indices
   */
   private assignBBoxes(node: ClusterTreeNode, data: number[][]): void {
    if (!node.leftChild && !node.rightChild) {
    const idx = node.children?.[0] ?? node.leafIndex!;
    const [x, y] = data[idx];
    node.bbox = { minX: x, minY: y, maxX: x, maxY: y };
    return;
  }
    // internal node: recurse children
    if (node.leftChild) this.assignBBoxes(node.leftChild, data);
    if (node.rightChild) this.assignBBoxes(node.rightChild, data);
    // union of children bboxes
    const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
    if (node.leftChild?.bbox) boxes.push(node.leftChild.bbox);
    if (node.rightChild?.bbox) boxes.push(node.rightChild.bbox);
    const minX = Math.min(...boxes.map(b => b.minX));
    const minY = Math.min(...boxes.map(b => b.minY));
    const maxX = Math.max(...boxes.map(b => b.maxX));
    const maxY = Math.max(...boxes.map(b => b.maxY));
    node.bbox = { minX, minY, maxX, maxY };
  }


  /**
   * Override the fit method to capture the hierarchy.
   * After clustering, the internal tree is built and converted to a tree structure.
   */
  fit(data: number[][]): number[] {
    // Handle the trivial case: if there's fewer than 2 points, we skip clustering.
    if (data.length < 2) {
      if (data.length === 1) {
        // For a single point, create a trivial cluster tree.
        this.hierarchyTree = {
          id: 0,
          uid: this.formatUid(1),
          children: [0],
          distance: 0,
          size: 1,
          stability: 0,
        };
        return [0];
      } else {
        // No data provided.
        return [];
      }
    }

    // Normal case: call the base fit method on a slightly perturbed copy to
    // avoid NaN results when points overlap perfectly.
    const labels = super.fit(perturbDuplicates(data));

    // Access the private members from HDBSCAN.
    const hdbscanPrivate = this as unknown as HDBSCANPrivate;

    // The library stores the full hierarchy in a cluster map keyed by id.
    const rootCluster = hdbscanPrivate.clusterMap.get(0);
    if (rootCluster) {
      // Convert the flat hierarchy into a tree with persistent UIDs.
      this.hierarchyTree = this.convertHierarchyToTree([rootCluster]);
      // Compute data-space bboxes for every node
      this.assignBBoxes(this.hierarchyTree, data);
    }

    return labels;
  }

  /**
   * Recursively convert the hierarchy array from the base class into a tree structure,
   * while annotating each node with a persistent unique identifier (uid) computed via an incrementing counter.
   * @param hierarchy Array of cluster objects from hdbscan-ts.
   */
  private convertHierarchyToTree(hierarchy: InternalCluster[]): ClusterTreeNode {
    // Use a closure counter to assign unique UIDs.
    let uidCounter = 1;

    const buildNode = (cluster: InternalCluster): ClusterTreeNode => {
      const node: ClusterTreeNode = {
        id: cluster.id,
        uid: this.formatUid(uidCounter++),
        children: cluster.children,
        distance: cluster.distance,
        size: cluster.size,
        stability: cluster.stability,
        birthDistance: cluster.birthDistance,
      };
      if (cluster.leftChild) {
        node.leftChild = buildNode(cluster.leftChild);
      }
      if (cluster.rightChild) {
        node.rightChild = buildNode(cluster.rightChild);
      }
      return node;
    };

    return buildNode(hierarchy[0]);
  }

  /**
   * Formats the numeric uid into a hexadecimal string.
   * @param uidNumber The numeric uid.
   */
  private formatUid(uidNumber: number): string {
    return `0x${uidNumber.toString(16).toUpperCase()}`;
  }

  /**
   * Recursively compute the cumulative distance from the given node down to its farthest leaf.
   */
  private getLongestPath(node: ClusterTreeNode): number {
    if (!node.leftChild && !node.rightChild) {
      return 0;
    }
    const left = node.leftChild
      ? (node.distance - node.leftChild.distance) + this.getLongestPath(node.leftChild)
      : 0;
    const right = node.rightChild
      ? (node.distance - node.rightChild.distance) + this.getLongestPath(node.rightChild)
      : 0;
    return Math.max(left, right);
  }

  /**
   * Returns the total depth of the tree.
   */
  public getTotalTreeDepth(): number {
    if (!this.hierarchyTree) {
      throw new Error("Hierarchy tree is not available. Call fit() first.");
    }
    return this.getLongestPath(this.hierarchyTree);
  }

  /**
   * Given a relative zoom value (0 to 1), compute the absolute threshold for collapsing the tree.
   */
  public computeAbsoluteDistance(relative: number): number {
    if (relative < 0 || relative > 1) {
      throw new Error("Relative distance must be between 0 and 1.");
    }
    const totalDepth = this.getTotalTreeDepth();
    return (1 - relative) * totalDepth;
  }

  /**
   * Traverse the tree and determine which clusters should be visible given a relative zoom threshold.
   */
  public getCollapsedClusters(relativeThreshold: number): ClusterTreeNode[] {
    if (!this.hierarchyTree) {
      throw new Error('Hierarchy tree is not available. Call fit() first.');
    }
    // Make the threshold more sensitive.
    relativeThreshold = Math.pow(relativeThreshold, 5);
    const totalDepth = this.getTotalTreeDepth();
    const absoluteThreshold = (1 - relativeThreshold) * totalDepth;
    const result: ClusterTreeNode[] = [];
  
    const collapse = (node: ClusterTreeNode, cum: number): void => {
      // If the cumulative distance has already met/exceeded the threshold, cut here.
      if (cum >= absoluteThreshold) {
        result.push(node);
        return;
      }
      // If this is a leaf, add it.
      if (!node.leftChild && !node.rightChild) {
        result.push(node);
        return;
      }
      
      // Determine if we can go deeper on either branch.
      let canRecurse = false;
      if (node.leftChild) {
        const newCumLeft = cum + (node.distance - node.leftChild.distance);
        if (newCumLeft < absoluteThreshold) canRecurse = true;
      }
      if (node.rightChild) {
        const newCumRight = cum + (node.distance - node.rightChild.distance);
        if (newCumRight < absoluteThreshold) canRecurse = true;
      }
      
      // If neither branch qualifies for further recursion, add the current node.
      if (!canRecurse) {
        result.push(node);
        return;
      }
      
      // Otherwise, for each child, either recurse or add it directly if going deeper would exceed the threshold.
      if (node.leftChild) {
        const newCumLeft = cum + (node.distance - node.leftChild.distance);
        if (newCumLeft < absoluteThreshold) {
          collapse(node.leftChild, newCumLeft);
        } else {
          result.push(node.leftChild);
        }
      }
      if (node.rightChild) {
        const newCumRight = cum + (node.distance - node.rightChild.distance);
        if (newCumRight < absoluteThreshold) {
          collapse(node.rightChild, newCumRight);
        } else {
          result.push(node.rightChild);
        }
      }
    };
  
    if (absoluteThreshold <= 0) {
      return [this.hierarchyTree];
    }
    collapse(this.hierarchyTree, 0);
    return result;
  }

  /**
   * Updates cluster labels for each data point based on the visible clusters determined
   * by the current relative zoom threshold.
   * Instead of enumerating clusters sequentially, we now assign each point the unique id
   * of its collapsed cluster.
   * 
   * Returns a ZoomUpdateResult containing:
   * - labels: an array mapping each data point to its cluster id (or -1 for noise)
   * - activeClusters: the array of collapsed cluster nodes (with their persistent uids)
   */
  public updateLabelsForZoom(relativeThreshold: number, data: number[][]): ZoomUpdateResult {
  if (!this.hierarchyTree) throw new Error('Hierarchy tree is not available. Call fit() first.');
  const collapsedClusters = this.getCollapsedClusters(relativeThreshold);
  const labels = new Array(data.length).fill(-1);

  for (const cluster of collapsedClusters) {
    const memberIdxs =
      cluster.children ??
      (cluster.leafIndex != null ? [cluster.leafIndex] : []); // lightweight safety
    for (const i of memberIdxs) labels[i] = cluster.id;
  }
  return { labels, activeClusters: collapsedClusters };
}

  /**
   * Returns the full clustering state: both the complete hierarchy and the active (collapsed) clusters.
   * This method facilitates downstream consumption by exposing both the full tree and the current cut.
   * @param relativeThreshold Normalized zoom factor (0 to 1) used to compute the active clusters.
   */
  public getClusteringState(relativeThreshold: number): {
    fullHierarchy: ClusterTreeNode;
    activeClusters: ClusterTreeNode[];
  } {
    if (!this.hierarchyTree) {
      throw new Error("Hierarchy tree is not available. Call fit() first.");
    }
    const activeClusters = this.getCollapsedClusters(relativeThreshold);
    return { fullHierarchy: this.hierarchyTree, activeClusters };
  }

  /**
   * Returns the hierarchy tree built after clustering.
   */
  public getHierarchyTree(): ClusterTreeNode | null {
    return this.hierarchyTree;
  }

  /**
   * Prints the hierarchy tree to the console.
   */
  public printTree(relativeThreshold?: number): void {
    if (!this.hierarchyTree) {
      console.error("Hierarchy tree not available. Please run fit() first.");
      return;
    }
    printClusterTree(this.hierarchyTree, relativeThreshold);
  }
}
