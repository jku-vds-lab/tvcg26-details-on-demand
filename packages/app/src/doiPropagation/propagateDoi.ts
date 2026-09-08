// src/doiPropagation/propagateDoi.ts
//
// #337 PR B: the heap-oracle spread (`propagateDoI`) retired — the field
// engine (serverPropagation.runLocalFieldPropagation) owns every local
// propagation lane. What remains here is the shared per-dataset trajectory
// precomputation and the doiGroup ladder, which the field lane and the
// preview machinery still consume.
import type { DataPoint, DoiGroup } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";

/**
 * Immediately updates the node's group affiliation based on its current DoI
 * and the provided DOI thresholds.
 */
export function updateNodeGroup(
  node: DataPoint,
  thresholds: {
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  },
  labeledNodeIds?: Set<string>
): void {
  let group: DoiGroup;
  if (node.DoI < thresholds.grayOutDoiThreshold) {
    group = "gray";
  } else if (node.DoI < thresholds.annotationDoiThreshold) {
    group = "transparent";
  } else if (node.DoI < thresholds.insetDoiThreshold) {
    group = "annotation";
  } else {
    group = "inset";
  }
  // In unlabeled-only mode, cap already-labeled nodes below the annotation
  // threshold so they never enter clustering, activation, or annotation rendering.
  if (labeledNodeIds?.has(String(node.id)) && (group === "annotation" || group === "inset")) {
    group = "transparent";
  }
  node.doiGroup = group;
}

/** -------- Stage 1 precomputation cache (built once per dataset) -------- **/

export interface PropagationPrecomputation {
  /** node.id -> index in nodes[] */
  indexById: Map<number, number>;
  /** predecessor index per node, -1 if none */
  predIndex: Int32Array;
  /** successor index per node, -1 if none */
  succIndex: Int32Array;
}

/**
 * Weakly cache precomputations per nodes array identity.
 * When a new dataset replaces the array, the cache naturally evicts.
 */
const PRECOMP_CACHE = new WeakMap<DataPoint[], PropagationPrecomputation>();

/**
 * Build (or fetch) precomputation for a given dataset.
 * O(n). Called once per dataset (thanks to WeakMap).
 */
export function getPropagationPrecomputation(nodes: DataPoint[]): PropagationPrecomputation {
  const cached = PRECOMP_CACHE.get(nodes);
  if (cached) return cached;

  const n = nodes.length;
  // Columnar id/line source (issue #315 R1a step 6): this one-shot pass reads
  // two properties per row over the whole dataset; the columns hold exactly
  // the same values, so the maps and index arrays come out identical.
  const cols = columnsOf(nodes);
  const idAt = cols ? (i: number) => cols.id[i] : (i: number) => nodes[i].id;
  const lineAt = cols ? (i: number) => cols.line[i] : (i: number) => nodes[i].line;

  const indexById = new Map<number, number>();
  for (let i = 0; i < n; i++) indexById.set(idAt(i), i);

  // Build pred/succ by single pass over nodes, maintaining last seen per line.
  const predIndex = new Int32Array(n);
  const succIndex = new Int32Array(n);
  predIndex.fill(-1);
  succIndex.fill(-1);

  const lastIndexByLine = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const lineId = lineAt(i);
    const prev = lastIndexByLine.get(lineId);
    if (prev !== undefined) {
      predIndex[i] = prev;
      succIndex[prev] = i;
    }
    lastIndexByLine.set(lineId, i);
  }

  const pre: PropagationPrecomputation = { indexById, predIndex, succIndex };
  PRECOMP_CACHE.set(nodes, pre);
  return pre;
}
