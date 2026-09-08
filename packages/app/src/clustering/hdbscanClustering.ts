// packages/app/src/clustering/hdbscanClustering.ts

import { featureCollection, point } from "@turf/helpers";
import * as d3 from "d3";
import { ClusteringService, setCommittedDoiRevisionProvider } from "./clusteringService";
import type {
    DataPoint,
    TrajectoryMidpoint,
} from "../dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "../dataPreprocessing/dataPreprocessing";
import { ensureTrajectoryMidpoints } from "../dataPreprocessing/lazyTrajectoryMidpoints";
import { areRowsResident, subsetRowsByIndex } from "../dataPreprocessing/lazyRows";
import { clearNodeClusterIds, columnsOf, markClusterIdsStamped } from "../dataPreprocessing/pointColumns";
import type { ClusterTreeNode } from "./ExtendedHDBSCAN";
import type { RootState } from "../store";
import store, {
    setActiveClusterStats,
    setAnnotationClusteringResults,
    setEdgeAnnotationClusteringResults,
    setEdgeInsetClusteringResults,
    setInsetClusteringResults,
    updateAnnotationActiveClusters,
    updateEdgeAnnotationActiveClusters,
    updateEdgeInsetActiveClusters,
    updateInsetActiveClusters,
} from "../store";
import { resolveCutProvider } from "@scaling";
import { getBakedDoi, getBakedThresholds, isDoiBaked } from "../doiPropagation/bakedDoi";
import { getLastDoiRevision, getResidentField } from "../doiPropagation/serverPropagation";
import { attachLazyChildren, indexLeafRanges } from "../hooks/useFullSelectionHdbscanInstance";
import { registerSwitchClear } from "../utils/clusteringSwitchGate";
import { ledgerEvent, ledgerMark } from "../utils/insetLedger";
import { completeTask, failTask, startTask, updateTask } from "../utils/progressApi";
import { computeViewbox } from "../utils/viewboxUtils";
import { hdbscanWorkerProxy } from "../workers/hdbscanWorkerProxy";

export interface ClusterResult {
  clusters: ReturnType<typeof featureCollection>;
  clusterCount: number;
  /** Sorted active-cluster uids (issue #315 C1): the change-detection signal
   * for version bumps — memberships per uid are immutable leaf ranges, so
   * this carries the same information as the per-feature id multiset the
   * consumer previously sorted (O(n log n) over up to 1M features per tick). */
  activeUids?: string[];
}

// ---------------------------------------------------------------------------
// Epoch-based cancellation guard
// ---------------------------------------------------------------------------
// Every new top-level clustering sequence (initial load, lasso, slider commit)
// calls bumpClusteringEpoch() which returns a fresh token.  Each async step
// checks isCurrentClusteringEpoch(token) after yielding to the event loop; if
// a newer sequence has started, the stale one bails without writing any state.
// ---------------------------------------------------------------------------
let clusteringEpoch = 0;

/** Starts a new exclusive clustering operation. Returns the epoch token. */
export function bumpClusteringEpoch(): number {
  // Terminate any in-flight worker computation immediately.
  hdbscanWorkerProxy.cancel();
  return ++clusteringEpoch;
}

/** True only when `epoch` still matches the most-recently started operation. */
export function isCurrentClusteringEpoch(epoch: number): boolean {
  return epoch === clusteringEpoch;
}

// Persist a single unified clustering (annotation + inset nodes) for zoom updates
interface ViewportParams {
  canvasContainer: HTMLDivElement;
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> };
  zoomTransform: d3.ZoomTransform;
}

/**
 * Cached outcome of the last zoom cut. The signature is the ordered uid lists
 * of the annotation/inset splits: identical uid sets on the same hierarchy
 * imply identical labels, per-node cluster assignments, and dispatch payloads,
 * so a matching signature lets the zoom path skip Redux dispatches entirely
 * (dispatching unchanged active sets re-renders every clustering consumer at
 * the settled-zoom cadence).
 */
interface ZoomCutCache {
  signature: string;
  result: { annotation: ClusterResult; inset: ClusterResult };
}

interface PersistentNodeClustering {
  service: ClusteringService;
  nodes: DataPoint[];
  hierarchyId: number;
  lastViewport?: ViewportParams;
  lastZoomCut?: ZoomCutCache;
  /** Actives whose members carry cluster ids (issue #315 C1 delta
   * assignment) — cleared range-wise on the next pass. */
  lastAssignedActives?: ClusterTreeNode[];
  /** Group each assigned uid was written with — unchanged (uid, group) pairs
   * skip both the clear and assign loops on the next pass. */
  lastAssignedGroups?: Map<string, "inset" | "annotation">;
}

let persistentNodeClustering: PersistentNodeClustering | undefined;
let nodeHierarchyCounter = 0;

/**
 * Cut-driven grouping access (issue #315 phase C1): the current node
 * clustering's service (whose leaf indices resolve members) and the input
 * array those indices point into. Callers must check hierarchyId against
 * the Redux results they hold — a stale pair means a swap is in flight.
 */
export function getNodeClusteringContext(): {
  service: ClusteringService;
  nodes: DataPoint[];
  hierarchyId: number;
} | null {
  if (!persistentNodeClustering) return null;
  const { service, nodes, hierarchyId } = persistentNodeClustering;
  return { service, nodes, hierarchyId };
}

interface PersistentMidpointClustering {
  service: ClusteringService;
  midpoints: TrajectoryMidpoint[];
  hierarchyId: number;
  lastViewport?: ViewportParams;
  lastZoomCut?: ZoomCutCache;
  /** Actives whose members carry a non-noise clusterId (issue #315 C1 delta
   * assignment) — cleared range-wise on the next pass. */
  lastAssignedActives?: ClusterTreeNode[];
}

let persistentMidpointClustering: PersistentMidpointClustering | null = null;
let midpointHierarchyCounter = 0;

/** Midpoint twin of getNodeClusteringContext (issue #315 phase C1b2): leaf
 * indices of midpoint active clusters index this `midpoints` array. */
export function getMidpointClusteringContext(): {
  service: ClusteringService;
  midpoints: TrajectoryMidpoint[];
  hierarchyId: number;
} | null {
  if (!persistentMidpointClustering) return null;
  const { service, midpoints, hierarchyId } = persistentMidpointClustering;
  return { service, midpoints, hierarchyId };
}

/** Midpoints from older pipelines may carry precomputed DoIs or node refs under legacy keys. */
type LegacyMidpoint = TrajectoryMidpoint & {
  startDoI?: number;
  endDoI?: number;
  startNode?: { DoI?: number };
  endNode?: { DoI?: number };
};

function edgeDoiOf(mp: TrajectoryMidpoint): number {
  const legacy = mp as LegacyMidpoint;
  const s = legacy.startDoI ?? mp.startPoint?.DoI ?? legacy.startNode?.DoI ?? 0;
  const e = legacy.endDoI ?? mp.endPoint?.DoI ?? legacy.endNode?.DoI ?? 0;
  return 0.5 * (s + e);
}

type CutProviderInstance = NonNullable<ReturnType<typeof resolveCutProvider>>;

// Server subset-fit size cap (issue #315 P7 S4). Was 5 000 while the server
// fit was the exact O(n²) Prim (0.6 s @10k, ~7 s @39k, ~45 s extrapolated
// @100k) and every fit blocked a request thread. Both premises are gone:
// `rl_trajectories/sparse_fit.py` fits the 4k–100k band with a sparse kNN-MST
// in seconds, and A1 runs it on a dedicated thread that no walker waits on.
// The cap now coincides with the flood cap, so the client worker fit is off
// the provider path entirely.
export const SERVER_SUBSET_FIT_MAX_POINTS = 100_000;

// Blocking-worker-fit cap for a provider WITHOUT server fitting (an old
// backend, or one whose manifest omits the capability). Unchanged: past this
// the worker fit takes minutes, so the coarse-first full-tree cut + background
// worker refine is still the only sane route there.
const WORKER_BLOCKING_MAX_POINTS = 5000;

// Above this, a DoI-filtered subset has NO viable fit path (see the flood
// guard in runHdbscanClustering) and the full-tree server cut takes over.
const FLOOD_SUBSET_MAX_POINTS = 100_000;

/**
 * Routing of a DoI-filtered visible subset on a cut-capable backend (issue
 * #315 §10.2 package A, amended by P7 S4).
 *
 * - `exact` — the subset gets its own hierarchy: the resident server cut
 *   (subset === dataset), the server subset fit (≤ 100k when `canServerFit`),
 *   or the client worker fit (no provider, or ≤ 5k without server fitting).
 * - `coarse-first` — the worker fit would take minutes and block every
 *   downstream consumer, so cut the server's FULL-dataset hierarchy now
 *   (instant, one leaf-order fetch) and refine in the background. With
 *   `canServerFit` this band is EMPTY: the server fit covers it, and its
 *   own BUILDING phase is the coarse-first behaviour (see
 *   `runServerFitAdoption`).
 * - `flood-fallback` — > 100k: full-tree cut with NO refine; no fit path is
 *   worth running at that size.
 */
export function classifyVisibleSubset(
  visibleCount: number,
  totalCount: number,
  hasProvider: boolean,
  canServerFit = false
): "exact" | "coarse-first" | "flood-fallback" {
  if (!hasProvider) return "exact";
  if (visibleCount >= totalCount) return "exact";
  const cap = canServerFit ? SERVER_SUBSET_FIT_MAX_POINTS : WORKER_BLOCKING_MAX_POINTS;
  if (visibleCount <= cap) return "exact";
  if (visibleCount > FLOOD_SUBSET_MAX_POINTS) return "flood-fallback";
  return "coarse-first";
}

/**
 * Half-open ranges over `fullLeafOrder` covering exactly the given dataset
 * indices (issue #315 F2c) — the wire form of a subset for /v1/cluster/fit.
 * Throws when an index is outside the leaf order (desynced permutation).
 */
export function subsetLeafRanges(
  fullLeafOrder: ArrayLike<number>,
  subsetDatasetIndices: number[]
): Array<[number, number]> {
  const n = fullLeafOrder.length;
  const posOf = new Int32Array(n).fill(-1);
  for (let pos = 0; pos < n; pos++) posOf[fullLeafOrder[pos]] = pos;
  const positions = subsetDatasetIndices.map((idx) => {
    const pos = idx >= 0 && idx < n ? posOf[idx] : -1;
    if (pos < 0) throw new Error(`point ${idx} not in the leaf order`);
    return pos;
  });
  positions.sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const pos of positions) {
    const last = ranges[ranges.length - 1];
    if (last && pos === last[1]) last[1] = pos + 1;
    else ranges.push([pos, pos + 1]);
  }
  return ranges;
}

/** Fitted-tree leaf order in SUBSET-LOCAL positions (membersOf slices the
 * clustering input array, which the caller built in dataset order). */
async function fittedSubsetLeafOrder(
  fitProvider: CutProviderInstance,
  tree: "points" | "midpoints",
  subsetIdx: number[]
): Promise<Uint32Array> {
  const fittedOriginal = await fitProvider.getLeafOrder(tree);
  const subsetPosOf = new Map<number, number>();
  subsetIdx.forEach((orig, pos) => subsetPosOf.set(orig, pos));
  const out = new Uint32Array(fittedOriginal.length);
  for (let i = 0; i < fittedOriginal.length; i++) {
    const pos = subsetPosOf.get(fittedOriginal[i]);
    if (pos === undefined) {
      throw new Error(`fitted leaf ${fittedOriginal[i]} outside the subset`);
    }
    out[i] = pos;
  }
  return out;
}

/**
 * Visible-subset resolution from the server's `visibleRanges` (issue #315 P7
 * S5). The DST1 response ships the half-open leaf ranges whose DoI is at or
 * above the annotation threshold — i.e. EXACTLY the set the per-node
 * `doiGroup === "annotation" | "inset"` scan used to compute — so on the
 * provider path the O(n) scan (and the doiGroup strings behind it) is replaced
 * by a range walk.
 *
 * Two-stage on purpose: `count` alone decides the coarse/flood routing, and
 * both of those routes cluster the FULL tree, so the O(visible) index
 * materialization is deferred behind `materialize()` and never runs on the
 * flood path.
 *
 * Returns null when no fresh resident field exists (boot, graph-path or local
 * commit, or a server that shipped no ranges) — the caller keeps the legacy
 * doiGroup filter, which on an unwritten ladder means "everything visible" and
 * therefore the full-tree cut. Never engaged on client-complete datasets.
 */
export async function resolveVisibleRangeSubset(
  provider: CutProviderInstance,
  nodeCount: number
): Promise<{
  count: number;
  materialize: () => Promise<number[]>;
} | null> {
  const field = getResidentField();
  if (!field || field.revision !== getLastDoiRevision()) return null;
  const ranges = field.visibleRanges;
  if (ranges.length === 0) return null;
  let count = 0;
  for (const [start, end] of ranges) count += Math.max(0, end - start);
  if (count === 0 || count > nodeCount) return null;
  return {
    count,
    materialize: async () => {
      const leafOrder = await provider.getLeafOrder("points");
      const idx: number[] = [];
      for (const [start, end] of ranges) {
        const from = Math.max(0, start);
        const to = Math.min(end, leafOrder.length);
        for (let pos = from; pos < to; pos++) idx.push(leafOrder[pos]);
      }
      // Dataset order: `nodes.filter(...)` produced it, and every downstream
      // consumer (coords, subsetIdx alignment, fitted leaf order) assumes it.
      idx.sort((a, b) => a - b);
      return idx;
    },
  };
}

type SubsetFitAttempt =
  | { status: "ready"; provider: CutProviderInstance; leafOrder: Uint32Array }
  | { status: "building"; fitId: string };

/**
 * Subset server-fit attempt (issue #315 F2c, async since P7 A1): describe the
 * visible subset as ranges over the full tree's leaf order and ask the server
 * to fit it.
 *
 * The fit is ASYNC — the server answers with the content-addressed fitId and
 * `status: "building"` immediately, and every fit-scoped endpoint 409s until
 * it lands. So this returns one of:
 *  - `ready` — a cache hit (or a pre-A1 server): the fit-scoped provider plus
 *    the fitted leaf order, ready to `initServerCut` straight away;
 *  - `building` — the caller cuts the COARSE full server tree now and adopts
 *    the fitted tree when `event: fit` says READY (`runServerFitAdoption`);
 *  - `null` — the fit is unavailable/failed; the caller falls back exactly as
 *    it did before this feature existed.
 */
async function tryServerSubsetFit(
  provider: CutProviderInstance,
  tree: "points" | "midpoints",
  subsetIdx: number[]
): Promise<SubsetFitAttempt | null> {
  try {
    // visibleRanges → fit chain (issue #315 A3 / P-d, ledger item 2): when a
    // resident server DoI field exists whose ranges are fresh (revision matches
    // the last commit), its `visibleRanges` ARE the subsetLeafRanges vocabulary
    // by contract (§6b) — pass them straight through instead of the O(n)
    // getLeafOrder + subsetLeafRanges recompute. Only the "points" tree carries
    // a resident field (DoI propagates over points); "midpoints" always
    // recomputes. Consistency guard: a total-size mismatch means client/server
    // thresholds drifted, so fall back to the exact computed ranges + ledger it.
    const field = tree === "points" ? getResidentField() : null;
    let ranges: Array<[number, number]>;
    if (
      field &&
      field.revision === getLastDoiRevision() &&
      field.visibleRanges.length > 0
    ) {
      const total = field.visibleRanges.reduce((s, [a, b]) => s + (b - a), 0);
      if (total === subsetIdx.length) {
        ranges = field.visibleRanges;
        ledgerEvent("fit:visibleRanges", `${tree} n=${total} rev=${field.revision}`);
      } else {
        ledgerEvent(
          "fit:ranges-mismatch",
          `${tree} resident=${total} subset=${subsetIdx.length} rev=${field.revision}`
        );
        const fullOrder = await provider.getLeafOrder(tree);
        ranges = subsetLeafRanges(fullOrder, subsetIdx);
      }
    } else {
      const fullOrder = await provider.getLeafOrder(tree);
      ranges = subsetLeafRanges(fullOrder, subsetIdx);
    }
    const { fitId, status } = await provider.fitSubset!(tree, ranges);
    if (status === "failed") {
      ledgerEvent("fit:failed", `${tree} fit=${fitId}`);
      return null;
    }
    if (status === "building") {
      ledgerEvent("fit:building", `${tree} n=${subsetIdx.length} fit=${fitId}`);
      return { status: "building", fitId };
    }
    const fitProvider = provider.withFit!(fitId);
    const leafOrder = await fittedSubsetLeafOrder(fitProvider, tree, subsetIdx);
    ledgerEvent("fit:server", `${tree} n=${subsetIdx.length} fit=${fitId}`);
    return { status: "ready", provider: fitProvider, leafOrder };
  } catch (error) {
    ledgerEvent("fit:fallback", `${tree} ${String(error)}`);
    return null;
  }
}

/**
 * The [x, y] pair array the rehydrate/worker-fit paths consume — columnar
 * when `nodes` is the canonical column-backed array (issue #315 R3d: on the
 * client lazy lane the row map would be the first hard TypeError on a hole),
 * the row walk everywhere else (subset copies are resident by contract §3.3).
 */
function coordPairsFor(nodes: DataPoint[]): [number, number][] {
  const cols = columnsOf(nodes);
  if (cols) {
    const out = new Array<[number, number]>(nodes.length);
    for (let i = 0; i < nodes.length; i++) out[i] = [cols.x[i], cols.y[i]];
    return out;
  }
  return nodes.map((n) => [n.x, n.y] as [number, number]);
}

/**
 * Runs or rehydrates HDBSCAN clustering for all visible nodes (doiGroup === "annotation"
 * or "inset") in a single pass.  After clustering, the average DoI of each cluster is
 * computed; clusters whose average is at or above the inset threshold are placed into the
 * inset result set, the rest (at or above the annotation threshold) into the annotation
 * result set.  Both result sets are dispatched together so the two visualisation layers
 * always reflect a single, coherent clustering.
 *
 * Fresh clustering (when a pre-computed tree cannot be reused) is performed in a Web
 * Worker so the main thread remains responsive.  The epoch parameter is used to discard
 * results from superseded operations.
 */
export async function runHdbscanClustering(
  nodes: DataPoint[],
  fullSelectionClustering: { hierarchyTree: ClusterTreeNode } | undefined,
  epoch?: number,
  onFitProgress?: (fraction: number) => void
): Promise<ClusterResult> {
  // 1) Collect all nodes that are visible (mid-doi or high-doi). Server-cut
  // datasets boot in the implicit uniform revision-0 DoI state (issue #315
  // A3 P-a): the O(n) boot marking never runs, so an UNWRITTEN doiGroup
  // ladder means "uniformly visible" — without this clause the filter would
  // yield [] and the empty-guard below would kill the boot clustering before
  // the cut provider ever engages.
  const provider = resolveCutProvider(undefined);
  // Server-baked DoI (issue #315 P7 S5): the provider path answers this from
  // the DST1 `visibleRanges` — the O(n) doiGroup scan (and the per-point
  // strings feeding it) is skipped entirely, and on the flood route not even
  // the visible index list is built.
  const rangeSubset = provider
    ? await resolveVisibleRangeSubset(provider, nodes.length)
    : null;
  if (rangeSubset && !isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
    return { clusters: featureCollection([]), clusterCount: 0 };
  }
  let visibleNodes: DataPoint[];
  /** Set only on the ranges path — the canonical indices of `visibleNodes`,
   * so the O(n) identity scan below is skipped too. */
  let rangeSubsetIdx: number[] | null = null;
  let visibleCount: number;
  if (rangeSubset) {
    visibleCount = rangeSubset.count;
    visibleNodes = nodes; // materialized below only when the route needs it
  } else {
    // Probe before filtering (issue #315 R1a, A7): on the uniform boot every
    // node passes, so `filter` allocated a 1M-element copy (plus a closure
    // call per node) only for the identity restore below to discard it. The
    // predicate is unchanged — a first failure falls through to the real
    // filter, which is what a local-fallback propagation (the one lane that
    // writes doiGroup strings on a provider dataset) needs.
    const visible = (n: DataPoint) =>
      n.doiGroup === "annotation" ||
      n.doiGroup === "inset" ||
      (provider != null && n.doiGroup === undefined);
    // Row-lazy lane (issue #315 R1b; client variant R3d): an unmaterialized
    // row carries no doiGroup, and every writer of doiGroup strings runs with
    // resident rows — the local propagation oracle materializes before it
    // runs, and the client lane's boot marking pass is deferred until after
    // residency (useInitialClustering). A non-resident array is therefore
    // uniformly visible by construction on BOTH lazy lanes, and the probe (a
    // hash lookup per hole on a sparse array, once per clustering pass) is
    // skipped outright.
    // Baked lane (#337 toggle bug; #342): while a bake owns DoI the strings
    // are stale BY DESIGN (S5) and must not be consulted — a labeled-mode
    // commit writes real capped strings, and the next baked commit never
    // rewrites them, so the string filter would exclude labeled points from
    // every fit forever. But the baked FIELD is fresh truth, and the fit
    // must shrink to its ≥annotation subset exactly like the string lane
    // did (#342: treating every baked commit as uniformly visible sent
    // focused query selections onto the full-tree route, whose τ-cut
    // clusters mix focused and unfocused members — wrong inset labels,
    // wrong active count). A uniform field (select-all, boot) yields no
    // subset and keeps the full-tree route unchanged.
    let allVisible = true;
    let bakedVisibleIdx: number[] | null = null;
    const bakedField = getBakedDoi();
    const bakedThresholds = getBakedThresholds();
    if (bakedField && bakedThresholds && bakedField.length === nodes.length) {
      const annotationT = bakedThresholds.annotationDoiThreshold;
      const idx: number[] = [];
      for (let i = 0; i < bakedField.length; i++) {
        if (bakedField[i] >= annotationT) idx.push(i);
      }
      if (idx.length < nodes.length) {
        allVisible = false;
        bakedVisibleIdx = idx;
      }
    } else if (!isDoiBaked() && areRowsResident(nodes)) {
      for (let i = 0; i < nodes.length; i++) {
        if (!visible(nodes[i])) { allVisible = false; break; }
      }
    }
    // Everything passed ⇒ the filter result is the identical sequence — keep
    // the CANONICAL array identity (issue #315 I2): downstream WeakMap
    // registries (sidecar columns, columnsOf) key on it, and the uniform
    // boot otherwise clusters against an anonymous 1M copy. The baked
    // subset resolves through rowAt (row contract §3.3) so lazy-lane holes
    // materialize instead of leaking undefined into the fit coords.
    visibleNodes = allVisible
      ? nodes
      : bakedVisibleIdx
        ? subsetRowsByIndex(nodes, bakedVisibleIdx)
        : nodes.filter(visible);
    visibleCount = visibleNodes.length;
  }
  // Field-first flood guard (issue #315 A3 v2), extended to progressive
  // clustering (§10.2 package A): under the field engine the ≥annotation set
  // can be a diameter-scale fraction of the dataset — hundreds of thousands
  // of points at 1M. Past the fit cap no fit path exists at all, so cut the
  // FULL-tree server hierarchy instead: focus emphasis still lands through
  // opacity and the server-stamped per-candidate doiMass scoring.
  // Server-cut datasets only — client-complete filtering is untouched.
  const canServerFit = Boolean(provider?.fitSubset && provider?.withFit);
  let refineSubsetNodes: DataPoint[] | null = null;
  const subsetRoute = classifyVisibleSubset(
    visibleCount,
    nodes.length,
    provider != null,
    canServerFit
  );
  if (rangeSubset && subsetRoute !== "flood-fallback" && visibleCount < nodes.length) {
    // Only the exact and coarse-first routes need the actual subset; the
    // flood route cuts the full tree and never looks at it.
    rangeSubsetIdx = await rangeSubset.materialize();
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    // Row contract §3.3: the subset copy is walked as a plain resident array
    // downstream (local fit fallback when the server fit fails, refine
    // capture), so members resolve through `rowAt` — a slot read on the lazy
    // canonical array leaks `undefined` into the copy and crashes the
    // coords map.
    visibleNodes = subsetRowsByIndex(nodes, rangeSubsetIdx);
    ledgerEvent("cut:visibleRanges", `visible=${visibleNodes.length} (no doiGroup scan)`);
  }
  if (subsetRoute !== "exact") {
    if (subsetRoute === "coarse-first") {
      refineSubsetNodes = visibleNodes;
      ledgerEvent(
        "cut:coarse-first",
        `visible=${visibleNodes.length} -> full tree, refine queued`
      );
    } else {
      ledgerEvent("cut:flood-fallback", `visible=${visibleCount} -> full tree`);
    }
    rangeSubsetIdx = null;
    visibleNodes = nodes;
  }

  // Reset cluster IDs on every node so stale assignments don't linger
  // (write-guarded — a first boot skips the 2M slot-creating writes).
  clearNodeClusterIds(nodes);

  // 2) No visible points → clear both stores and bail.
  if (visibleNodes.length === 0) {
    persistentNodeClustering = undefined;
    const empty: ClusterTreeNode[] = [];
    store.dispatch(setAnnotationClusteringResults({ activeClusters: empty, hierarchyId: 0 }));
    store.dispatch(setInsetClusteringResults({ activeClusters: empty, hierarchyId: 0 }));
    return { clusters: featureCollection([]), clusterCount: 0 };
  }

  // 3) Server subset fit, BEFORE the coordinates are frozen (issue #315 P7
  // S4): the fit is async, and a still-BUILDING one reroutes this pass to the
  // coarse full-tree cut, which changes what `visibleNodes` is.
  let readySubsetFit: { provider: CutProviderInstance; leafOrder: Uint32Array } | null = null;
  let pendingServerFit: { fitId: string; subsetNodes: DataPoint[]; subsetIdx: number[] } | null =
    null;
  if (provider && canServerFit && visibleNodes.length < nodes.length) {
    // nodes.filter order produced visibleNodes, so this scan aligns
    // subsetIdx[pos] with visibleNodes[pos]. On the ranges path (issue #315
    // P7 S5) the indices came out of the range walk already sorted, so the
    // O(n) Set scan is skipped with the doiGroup scan that fed it.
    let subsetIdx: number[];
    if (rangeSubsetIdx) {
      subsetIdx = rangeSubsetIdx;
    } else {
      const visible = new Set<DataPoint>(visibleNodes);
      subsetIdx = [];
      for (let i = 0; i < nodes.length; i++) {
        if (visible.has(nodes[i])) subsetIdx.push(i);
      }
    }
    const attempt = await tryServerSubsetFit(provider, "points", subsetIdx);
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    if (attempt?.status === "ready") {
      readySubsetFit = { provider: attempt.provider, leafOrder: attempt.leafOrder };
    } else if (attempt?.status === "building") {
      // A1 coarse-first: the fitted tree does not exist yet (every fit-scoped
      // endpoint 409s), so cut the server's FULL hierarchy now — the actives
      // the user already sees stay up — and adopt the fitted tree when
      // `event: fit` announces READY. This is the SAME shape the worker
      // refine had, minus the worker.
      pendingServerFit = { fitId: attempt.fitId, subsetNodes: visibleNodes, subsetIdx };
      ledgerEvent(
        "cut:coarse-first",
        `visible=${visibleNodes.length} -> full tree, server fit ${attempt.fitId} building`
      );
      visibleNodes = nodes;
    }
  }

  // 4) Coordinates are prepared PER BRANCH below (issue #315 B2): only the
  // rehydrate and worker-fit paths consume them — the server-cut path never
  // does, and materializing 1M pair-arrays on it was pure boot cost.

  // 5) Server cut vs. rehydrate vs. fresh clustering
  const service = new ClusteringService({ minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation" });
  // Server-cut mode (issue #315 S2b): a dataset whose backend advertises the
  // "cut" capability needs no resident tree at all — the walk happens
  // server-side per settled viewport. A DoI-filtered subset clusters a
  // DIFFERENT tree than the server's resident one; when the provider offers
  // subset fitting (issue #315 F2c) that tree is fit server-side too, and
  // only a failed/unsupported fit drops to the client worker fit below.
  // (`provider` resolved above, where the visibleNodes filter needs it.)
  const cutProvider = visibleNodes.length === nodes.length ? provider : null;
  const subsetFit = readySubsetFit;
  if (cutProvider) {
    ledgerEvent("cut:leaforder", "points fetch");
    const leafOrder = await cutProvider.getLeafOrder("points");
    ledgerEvent("cut:leaforder", `points done n=${leafOrder.length}`);
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    service.initServerCut(cutProvider, "points", leafOrder, visibleNodes, nodes);
    service.setOnCutReady(scheduleCutRefresh);
  }
  if (subsetFit) {
    service.initServerCut(subsetFit.provider, "points", subsetFit.leafOrder, visibleNodes, nodes);
    service.setOnCutReady(scheduleCutRefresh);
  } else if (!cutProvider && fullSelectionClustering?.hierarchyTree && visibleNodes.length === nodes.length) {
    // Fast path: reuse pre-computed hierarchy — stays on the main thread.
    const coords = coordPairsFor(visibleNodes);
    service.rehydrateHierarchy(fullSelectionClustering.hierarchyTree, coords, visibleNodes, nodes);
    // Static boot frame (issue #315 insets-at-boot I3): only THIS path may
    // adopt the prep-time artifact — its uids/leaf ranges are the shipped
    // tree's vocabulary (a worker-fit tree numbers differently). The gate
    // and the registry are both one-shot, so re-arming on a later
    // select-all recluster is inert. onCutReady is wired so the applied
    // frame's pass can schedule the superseding local pass.
    service.enableStaticBootFrame();
    service.setOnCutReady(scheduleCutRefresh);
  } else if (!cutProvider) {
    // Slow path: run hdbscan.fit() in a worker so the main thread stays free.
    const coords = coordPairsFor(visibleNodes);
    let fitTree: ClusterTreeNode;
    try {
      const fitResult = await hdbscanWorkerProxy.fit(
        coords,
        {
          minClusterSize: 1,
          minSamples: 1,
          alpha: 1.0,
          group: "annotation",
        },
        onFitProgress
      );
      fitTree = fitResult.tree;
    } catch (e) {
      // Cancelled (epoch superseded) or worker error.
      if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
        return { clusters: featureCollection([]), clusterCount: 0 };
      }
      throw e;
    }
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    // The worker tree is lightweight (leafIndex-only leaves): attach the DFS
    // leaf-order index + lazy children getters, mirroring useRehydrateHdbscan.
    const leafOrder = indexLeafRanges(fitTree);
    attachLazyChildren(fitTree, leafOrder);
    fitTree._leafOrder = leafOrder;
    // Rehydrate from the worker-computed tree (bboxes already set; no fit needed).
    service.rehydrateHierarchy(fitTree, coords, visibleNodes, nodes);
  }

  // 5) Persist for zoom updates and assign a new hierarchy id
  nodeHierarchyCounter += 1;
  const hierarchyId = nodeHierarchyCounter;
  ledgerEvent("hierarchySwap", `h${hierarchyId}`);
  persistentNodeClustering = { service, nodes: visibleNodes, hierarchyId };

  // 6–11) see finalizeNodeClusteringPass.
  const result = finalizeNodeClusteringPass(
    service,
    visibleNodes,
    hierarchyId,
    Boolean(cutProvider || subsetFit)
  );

  // Server subset fit still building (issue #315 P7 A1): the coarse full-tree
  // result is live — adopt the fitted tree when the server announces READY.
  // Deliberately not awaited, same as the worker refine below.
  if (pendingServerFit && provider) {
    void runServerFitAdoption(
      provider,
      pendingServerFit.fitId,
      pendingServerFit.subsetNodes,
      pendingServerFit.subsetIdx,
      nodes,
      hierarchyId,
      epoch ?? clusteringEpoch
    );
  }

  // Progressive clustering (issue #315 §10.2 package A): the coarse result is
  // live — now compute the EXACT subset hierarchy off the main thread and
  // swap it in when it lands. Deliberately not awaited: the caller's
  // downstream steps (performZoomClustering, insets, hulls) must proceed on
  // the coarse cut.
  if (refineSubsetNodes) {
    void runBackgroundSubsetRefine(
      refineSubsetNodes,
      nodes,
      hierarchyId,
      epoch ?? clusteringEpoch
    );
  }

  return result;
}

/**
 * Post-fit tail of a node clustering pass (steps 6–11 of
 * `runHdbscanClustering`): full-depth cut → per-cluster mean DoI →
 * annotation/inset split → cluster-id writeback → the two Redux dispatches →
 * GeoJSON result.
 *
 * Shared with the background subset refine (issue #315 §10.2 package A) so a
 * swapped-in hierarchy lands downstream state identical to a directly fitted
 * one. `serverSeeded` selects the server-cut seed (empty actives — the first
 * settled round trip fills them via onCutReady) over the resident tree's
 * threshold-1 cut.
 */
function finalizeNodeClusteringPass(
  service: ClusteringService,
  visibleNodes: DataPoint[],
  hierarchyId: number,
  serverSeeded: boolean
): ClusterResult {
  // 6) Full-depth cut at threshold=1. In server-cut mode there is no
  //    resident tree to seed from — actives stay empty until the first
  //    settled-transform round trip populates them (onCutReady refresh).
  //    The seed carries an EMPTY labels array: with no active clusters every
  //    point is noise, and the O(n) fill(-1) plus the two per-point walks
  //    below were pure boot-path waste at 1M (issue #315 I2) — both walks
  //    are gated on activeClusters below to keep them no-op-free.
  const { labels, activeClusters } = serverSeeded
    ? { labels: [] as number[], activeClusters: [] as ClusterTreeNode[] }
    : service.updateClusteringForZoom(1);

  // 7) Compute average DoI per cluster. Columnar DoI when the array carries
  //    columns (issue #315 R3d): on the client lazy lane `forEach` would
  //    silently skip holes and the means would be sums over the ~201 eager
  //    rows only — cols.doi is index-complete regardless of residency (and
  //    uniform-1 at boot, matching what the deferred marking pass writes).
  const uidMap = new Map<number, string>();
  activeClusters.forEach((c) => uidMap.set(c.id, c.uid));

  const clusterDoiSums = new Map<string, { sum: number; count: number }>();
  if (activeClusters.length > 0) {
    const cols = columnsOf(visibleNodes);
    for (let i = 0; i < visibleNodes.length; i++) {
      const label = labels[i];
      const uid = label === -1 ? "noise" : uidMap.get(label)!;
      if (uid !== "noise") {
        const doi = cols ? (cols.doi[i] ?? 0) : (visibleNodes[i].DoI ?? 0);
        const entry = clusterDoiSums.get(uid) ?? { sum: 0, count: 0 };
        entry.sum += doi;
        entry.count += 1;
        clusterDoiSums.set(uid, entry);
      }
    }
  }
  const clusterDoi = new Map<string, number>();
  clusterDoiSums.forEach((v, k) => clusterDoi.set(k, v.sum / v.count));

  // 8) Split active clusters into annotation vs inset based on average DoI
  const { annotationDoiThreshold, insetDoiThreshold } = (
    store.getState() as RootState
  ).visualizationSettings;
  const annotationActive: ClusterTreeNode[] = [];
  const insetActive: ClusterTreeNode[] = [];
  activeClusters.forEach((c) => {
    const doi = clusterDoi.get(c.uid) ?? 0;
    if (doi >= insetDoiThreshold) insetActive.push(c);
    else if (doi >= annotationDoiThreshold) annotationActive.push(c);
  });

  const annSet = new Set(annotationActive.map((c) => c.uid));
  const insetSet = new Set(insetActive.map((c) => c.uid));

  // 9) Assign cluster IDs back to points. Ids are row OWN properties, so on
  //    the client lazy lane's pre-residency pass there is nothing to write
  //    onto (issue #315 R3d) — and nothing that reads them either: the
  //    static-frame first inset resolves members through the R1c range/list
  //    group machinery, and the deferred supersede pass (which re-runs this
  //    finalize with resident rows) stamps them before any consumer needs
  //    row ids.
  const rowsReady = areRowsResident(visibleNodes);
  if (activeClusters.length > 0 && rowsReady) {
    markClusterIdsStamped();
    visibleNodes.forEach((pt, i) => {
      const label = labels[i];
      const uid = label === -1 ? "noise" : uidMap.get(label)!;
      if (uid === "noise") return;
      if (insetSet.has(uid)) pt.insetClusterId = uid;
      else if (annSet.has(uid)) pt.annotationClusterId = uid;
    });
  }

  // 10) Dispatch both result sets together
  store.dispatch(setAnnotationClusteringResults({ activeClusters: annotationActive, hierarchyId }));
  store.dispatch(setInsetClusteringResults({ activeClusters: insetActive, hierarchyId }));

  // 11) Build GeoJSON (uses inset id first, falls back to annotation).
  //     Gated on activeClusters like steps 7/9 (issue #315 R1a): with no
  //     actives every feature would carry cluster: undefined, and the only
  //     consumer lane (useClustering) filters those out behind its
  //     activeUids fallback — on the server-seeded boot pass this walk
  //     built 1M turf features that were discarded.
  //     On the client lazy lane's pre-residency pass the features are
  //     skipped with step 9 (issue #315 R3d): their only meaning is the
  //     cluster ids that pass didn't stamp, and a holey `map` would hand
  //     turf an array with holes.
  const features =
    activeClusters.length > 0 && rowsReady
      ? visibleNodes.map((n) =>
          point([n.x, n.y], {
            id: n.id,
            cluster: n.insetClusterId ?? n.annotationClusterId,
          })
        )
      : [];

  return {
    clusters: featureCollection(features),
    clusterCount: annSet.size + insetSet.size,
  };
}

/**
 * Adopt a server subset fit that was still BUILDING when its pass ran
 * (issue #315 P7 S4 / A1).
 *
 * The pass this belongs to already cut the server's FULL hierarchy, so the
 * user is looking at coarse actives right now. Here we wait for the fit
 * (`awaitFit` = the SSE `event: fit` raced against bounded polling), then swap
 * the fit-scoped server cut in and re-cut the current viewport.
 *
 * Guards are the SAME double gate the worker refine uses: the clustering epoch
 * must still be current AND `persistentNodeClustering` must still carry the
 * hierarchy id this adoption was queued for. Every other writer of
 * `persistentNodeClustering` therefore revokes this adoption's right to swap.
 *
 * The "Refining clusters…" task is the `refining` chip of the two-chip
 * taxonomy (issue #315 P7 A5): set at cause time (the fit is in flight),
 * cleared at effect time (the fitted frame applies) or when the swap is
 * revoked. No timer guards it.
 */
async function runServerFitAdoption(
  provider: CutProviderInstance,
  fitId: string,
  subsetNodes: DataPoint[],
  subsetIdx: number[],
  allNodes: DataPoint[],
  coarseHierarchyId: number,
  epoch: number
): Promise<void> {
  const id = `task:cluster:refine:${Date.now()}`;
  startTask({
    id,
    label: "Clustering",
    phase: "Refining clusters…",
    kind: "compute",
    value: null,
    progressMode: "indeterminate",
  });

  let fitProvider: CutProviderInstance;
  let leafOrder: Uint32Array;
  try {
    const status = provider.awaitFit
      ? await provider.awaitFit("points", fitId)
      : "ready";
    if (status !== "ready") {
      ledgerEvent("fit:adopt-abandoned", `fit=${fitId} ${status}`);
      failTask(id, "Refining clusters failed");
      return;
    }
    if (!isCurrentClusteringEpoch(epoch)) {
      failTask(id, "Superseded");
      return;
    }
    fitProvider = provider.withFit!(fitId);
    leafOrder = await fittedSubsetLeafOrder(fitProvider, "points", subsetIdx);
  } catch (error) {
    ledgerEvent("fit:adopt-failed", `fit=${fitId} ${String(error)}`);
    failTask(id, "Refining clusters failed");
    // The coarse result stays live — nothing to unwind.
    return;
  }

  const current = persistentNodeClustering;
  if (!isCurrentClusteringEpoch(epoch) || current?.hierarchyId !== coarseHierarchyId) {
    failTask(id, "Superseded");
    return;
  }

  const service = new ClusteringService({
    minClusterSize: 1,
    minSamples: 1,
    alpha: 1.0,
    group: "annotation",
  });
  service.initServerCut(fitProvider, "points", leafOrder, subsetNodes, allNodes);
  service.setOnCutReady(scheduleCutRefresh);

  // The adopted context's node array is the SUBSET, so the zoom path's clear
  // loops never reach points outside it — drop the coarse pass's assignments
  // here (mirrors step 1 of runHdbscanClustering).
  clearNodeClusterIds(allNodes);

  nodeHierarchyCounter += 1;
  const hierarchyId = nodeHierarchyCounter;
  ledgerEvent("hierarchySwap", `h${hierarchyId} serverFit n=${subsetNodes.length}`);
  persistentNodeClustering = {
    service,
    nodes: subsetNodes,
    hierarchyId,
    // Carried from the coarse context so refreshClusterActivation below has a
    // viewport to re-cut against.
    lastViewport: current.lastViewport,
  };

  // serverSeeded: the fitted tree lives on the server, so actives stay empty
  // until the re-cut below fills them.
  finalizeNodeClusteringPass(service, subsetNodes, hierarchyId, true);
  completeTask(id);

  refreshClusterActivation({ force: true });
}

/**
 * Background exact refine of a coarse-first pass (issue #315 §10.2 package A).
 *
 * UNREACHABLE on a provider that can fit server-side (issue #315 P7 S4): the
 * server fit covers 0–100k, so `classifyVisibleSubset` never returns
 * `coarse-first` when `canServerFit`, and `runServerFitAdoption` above is the
 * swap path instead. This stays for providers WITHOUT `fitSubset` (an older
 * backend, or a manifest that omits the capability), where the worker fit is
 * still the only refine available. Verify-then-delete is S7.
 *
 * Fits the TRUE visible subset in the HDBSCAN worker while the user already
 * interacts with the coarse full-tree cut, then swaps the refined hierarchy in
 * and re-cuts the current viewport against it.
 *
 * Concurrency: `hdbscanWorkerProxy.fit` terminates any in-flight worker, so at
 * most one refine fit ever runs; a superseded one rejects with AbortError.
 * Swapping is additionally gated on (a) the clustering epoch still being
 * current and (b) `persistentNodeClustering` still carrying the hierarchy id
 * this refine was queued for — every other path that writes
 * `persistentNodeClustering` (a newer run, the empty-guard reset, the dataset
 * switch clear) therefore revokes this refine's right to swap.
 *
 * The "Refining clusters…" task is the `refining` chip of the two-chip
 * taxonomy (issue #315 P7 A5): set at fit dispatch below, cleared when the
 * fitted frame applies (`completeTask` after finalizeNodeClusteringPass) or
 * when the swap is revoked. No timer guards it — see utils/pipelineChips.ts
 * for the other two chips.
 */
async function runBackgroundSubsetRefine(
  subsetNodes: DataPoint[],
  allNodes: DataPoint[],
  coarseHierarchyId: number,
  epoch: number
): Promise<void> {
  const id = `task:cluster:refine:${Date.now()}`;
  startTask({
    id,
    label: "Clustering",
    phase: "Refining clusters…",
    kind: "compute",
    value: null,
    progressMode: "predictive",
  });

  const coords = subsetNodes.map((n) => [n.x, n.y] as [number, number]);
  let fitTree: ClusterTreeNode;
  try {
    const fitResult = await hdbscanWorkerProxy.fit(
      coords,
      { minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation" },
      (fraction) =>
        updateTask({
          id,
          value: Math.min(99, fraction * 100),
          phase: "Refining clusters…",
          progressMode: "predictive",
        })
    );
    fitTree = fitResult.tree;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      // Cancelled by a newer clustering epoch — not an error.
      failTask(id, "Superseded");
      return;
    }
    failTask(id, "Refining clusters failed");
    // The coarse result stays live — nothing to unwind.
    console.error("[hdbscan] background subset refine failed", e);
    return;
  }

  const current = persistentNodeClustering;
  if (!isCurrentClusteringEpoch(epoch) || current?.hierarchyId !== coarseHierarchyId) {
    failTask(id, "Superseded");
    return;
  }

  // Hydrate the lightweight worker tree exactly like the slow path.
  const leafOrder = indexLeafRanges(fitTree);
  attachLazyChildren(fitTree, leafOrder);
  fitTree._leafOrder = leafOrder;

  const service = new ClusteringService({
    minClusterSize: 1,
    minSamples: 1,
    alpha: 1.0,
    group: "annotation",
  });
  service.rehydrateHierarchy(fitTree, coords, subsetNodes, allNodes);

  // The refined context's node array is the SUBSET, so the zoom path's
  // clear loops never reach points outside it — drop the coarse pass's
  // assignments here (mirrors step 1 of runHdbscanClustering).
  clearNodeClusterIds(allNodes);

  nodeHierarchyCounter += 1;
  const hierarchyId = nodeHierarchyCounter;
  ledgerEvent("hierarchySwap", `h${hierarchyId} refine n=${subsetNodes.length}`);
  persistentNodeClustering = {
    service,
    nodes: subsetNodes,
    hierarchyId,
    // Carried from the coarse context so refreshClusterActivation below has a
    // viewport to re-cut against.
    lastViewport: current.lastViewport,
  };

  finalizeNodeClusteringPass(service, subsetNodes, hierarchyId, false);
  completeTask(id);

  // Re-cut the current viewport against the refined tree so actives, hulls
  // and insets re-dispatch.
  refreshClusterActivation({ force: true });
}

/**
 * Asynchronously run unified node clustering while toggling the global loading state.
 * This allows React to display the spinner before the heavy computation runs.
 */
export async function runHdbscanClusteringWithStatus(
  nodes: DataPoint[],
  fullSelectionClustering: { hierarchyTree: ClusterTreeNode } | undefined,
  parentTaskId?: string,
  epoch?: number
): Promise<ClusterResult> {
  const id = `task:cluster:nodes:${Date.now()}`;
  startTask({
    id,
    label: "Clustering",
    phase: "Node clusters",
    kind: "compute",
    value: null,
    parentId: parentTaskId,
    // Server-cut datasets: the client side of this pass is setup only (leaf
    // order fetch + service init) and usually sub-second — a bar that flashes
    // AFTER insets already display reads as phantom work (CS round 4). It
    // still surfaces when the pass genuinely takes long (worker fits, cold
    // leaf orders).
    minShowMs: resolveCutProvider(undefined) ? 1200 : 150,
    stickyOnCompleteMs: 600,
    progressMode: "indeterminate",
  });

  await new Promise((r) => setTimeout(r, 0)); // let UI paint — yields to event loop

  // A newer clustering operation has started while we were waiting; discard this one.
  if (epoch !== undefined && !isCurrentClusteringEpoch(epoch)) {
    failTask(id, "Superseded");
    return { clusters: featureCollection([]), clusterCount: 0 };
  }

  try {
    // Worker fits (datasets without a precomputed hierarchy) report progress;
    // the fast rehydrate path completes before the first update would land.
    const result = await runHdbscanClustering(nodes, fullSelectionClustering, epoch, (fraction) =>
      updateTask({
        id,
        value: Math.min(99, fraction * 100),
        phase: "Fitting cluster hierarchy…",
        progressMode: "predictive",
      })
    );
    completeTask(id);
    return result;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      // Worker was cancelled by a newer epoch — not an error.
      failTask(id, "Superseded");
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    failTask(id, "Clustering failed");
    throw e;
  }
}

// ───── Midpoint clustering ────────────────────────────────────────────────

/** True when the last selection workflow skipped the midpoint FIT because
 * relationInsetBudget was 0 — the App-side budget watcher runs the deferred
 * fit when the budget re-enables (without it the slider would silently do
 * nothing until the next lasso). */
let midpointFitSkippedForBudget = false;
export function wasMidpointFitSkippedForBudget(): boolean {
  return midpointFitSkippedForBudget;
}

/** Input identity of the last midpoint fit that actually ran (issue #315
 * B2): the lazy midpoint build bumps the R-tree version DURING the fit it
 * feeds, which re-fires useInitialClustering's effect with a new array
 * identity — without this record that re-fire would duplicate the whole
 * (possibly worker-seconds) fit it just came from. */
let lastMidpointFitInput: { midpoints: TrajectoryMidpoint[]; tree: unknown } | null = null;
export function wasMidpointFitRunFor(
  midpoints: TrajectoryMidpoint[],
  fullSelectionClustering: unknown
): boolean {
  return (
    lastMidpointFitInput !== null &&
    lastMidpointFitInput.midpoints === midpoints &&
    lastMidpointFitInput.tree === fullSelectionClustering
  );
}

export async function runTrajectoryMidpointClustering(
  midpoints: TrajectoryMidpoint[],
  annotationDoiThreshold: number,
  fullSelectionClustering?: { hierarchyTree: ClusterTreeNode },
  epoch?: number,
  onFitProgress?: (fraction: number) => void
): Promise<ClusterResult> {
  // #261 budget-0 semantics, extended to the FIT (issue #315 §10.2 pain): the
  // zoom path already short-circuits the cut when the edge pipeline is hidden,
  // but the fit still ran at lasso time — a worker HDBSCAN over the
  // DoI-filtered midpoint set (minutes on synth1m) whose result nothing
  // consumes, and it blocks performZoomClustering() (the only producer of
  // node insets) behind the await in runSelectionWorkflow.
  const edgeBudget = (store.getState() as RootState).clusterSettings.relationInsetBudget;
  if (edgeBudget <= 0) {
    midpointFitSkippedForBudget = true;
    persistentMidpointClustering = null;
    store.dispatch(updateEdgeAnnotationActiveClusters([]));
    store.dispatch(updateEdgeInsetActiveClusters([]));
    return { clusters: featureCollection([]), clusterCount: 0 };
  }
  midpointFitSkippedForBudget = false;

  // Lazy midpoints (issue #315 B2): boot no longer builds the midpoint
  // array — this fit is the choke point every consumer path funnels
  // through, so the first budget-enabled run materializes them here. The
  // registered builder also installs the refs/R-tree and bumps the context
  // version; ensureTrajectoryMidpoints memoizes per dataset load.
  if (midpoints.length === 0) {
    midpoints = await ensureTrajectoryMidpoints();
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
  }

  if (midpoints.length === 0) {
    persistentMidpointClustering = null;
    return { clusters: featureCollection([]), clusterCount: 0 };
  }
  lastMidpointFitInput = { midpoints, tree: fullSelectionClustering };

  // Resolved up front — the routing decision below needs it (both branches
  // further down read the same handle).
  const midpointProvider = resolveCutProvider(undefined);
  let filtered = midpoints.filter((m) => edgeDoiOf(m) >= annotationDoiThreshold);
  // Midpoint twin of runHdbscanClustering's flood guard (issue #315 §10.2
  // package C). Between the 5k server-fit cap and infinity the ONLY path was
  // hdbscanWorkerProxy.fit over the filtered set — minutes at 10^5–10^6, and
  // AWAITED inside the selection workflow, so it blocks node insets too. Both
  // non-exact routes therefore cut the FULL midpoint tree server-side; the
  // classification mean is masked to the visible midpoints (package B2) so the
  // coarser membership still splits annotation vs inset meaningfully.
  //
  // Deliberately NO background refine (the node path has one): edge insets are
  // budgeted to a handful, the coarse tree is enough to pick them, and a
  // second minutes-long worker fit per lasso is exactly the cost being removed.
  const midpointRoute = classifyVisibleSubset(
    filtered.length,
    midpoints.length,
    midpointProvider != null
  );
  if (midpointRoute !== "exact") {
    ledgerEvent(
      "cut:mid-flood-fallback",
      `${midpointRoute} filtered=${filtered.length}/${midpoints.length} -> full tree`
    );
    filtered = midpoints;
  }
  // Set membership, not Array.includes: the linear scan per midpoint was
  // O(n²) — measured 39 s of the 1M boot (#315 phase C0 attribution).
  const filteredSet = new Set(filtered);
  midpoints.forEach((m) => { if (!filteredSet.has(m)) m.clusterId = undefined; });

  if (filtered.length === 0) {
    persistentMidpointClustering = null;
    return { clusters: featureCollection([]), clusterCount: 0 };
  }

  const nodes: DataPoint[] = filtered.map((m) => ({
    ...createEmptyDataPoint(),
    x: m.midPoint.x,
    y: m.midPoint.y,
    line: 0,
    id: m.id,
    action: m.action,
    DoI: 1,
  }));

  const coords = nodes.map((n) => [n.x, n.y] as [number, number]);
  const service = new ClusteringService({ minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation" });
  // Server-cut mode (issue #315 S2b) — see runHdbscanClustering. Subset
  // server-fit (F2c2) mirrors the points branch: a filtered edge set fits
  // server-side when the provider offers it; any failure keeps the worker.
  // (`midpointProvider` resolved above, where the flood guard needs it.)
  const cutProvider = filtered.length === midpoints.length ? midpointProvider : null;
  let subsetFit: { provider: CutProviderInstance; leafOrder: Uint32Array } | null = null;
  if (cutProvider) {
    const leafOrder = await cutProvider.getLeafOrder("midpoints");
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    service.initServerCut(cutProvider, "midpoints", leafOrder, nodes);
    service.setOnCutReady(scheduleCutRefresh);
  } else if (
    midpointProvider?.fitSubset &&
    midpointProvider.withFit &&
    filtered.length <= WORKER_BLOCKING_MAX_POINTS
  ) {
    // midpoints.filter order produced `filtered` (and `nodes`), so this scan
    // aligns subsetIdx[pos] with the clustering input position pos.
    const subsetIdx: number[] = [];
    for (let i = 0; i < midpoints.length; i++) {
      if (filteredSet.has(midpoints[i])) subsetIdx.push(i);
    }
    const attempt = await tryServerSubsetFit(midpointProvider, "midpoints", subsetIdx);
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    if (attempt?.status === "ready") {
      subsetFit = { provider: attempt.provider, leafOrder: attempt.leafOrder };
    } else if (attempt?.status === "building") {
      // Midpoints are scoped OUT of P7 v1 (plan §0.8 / G9): the edge lane keeps
      // its client path rather than growing an adoption lifecycle of its own.
      // A still-building fit therefore just falls through to the worker fit —
      // ≤ 5k points, the pre-server-fit behaviour — and the next identical
      // selection is a cache hit that lands READY here.
      ledgerEvent("fit:mid-building", `n=${filtered.length} fit=${attempt.fitId}`);
    }
  }
  if (subsetFit) {
    service.initServerCut(subsetFit.provider, "midpoints", subsetFit.leafOrder, nodes);
    service.setOnCutReady(scheduleCutRefresh);
  } else if (!cutProvider && fullSelectionClustering?.hierarchyTree && filtered.length === midpoints.length) {
    // Fast path: reuse pre-computed hierarchy.
    service.rehydrateHierarchy(fullSelectionClustering.hierarchyTree, coords, nodes);
  } else if (!cutProvider) {
    // Slow path: run hdbscan.fit() off the main thread.
    let fitTree: ClusterTreeNode;
    try {
      const fitResult = await hdbscanWorkerProxy.fit(
        coords,
        {
          minClusterSize: 1,
          minSamples: 1,
          alpha: 1.0,
          group: "annotation",
        },
        onFitProgress
      );
      fitTree = fitResult.tree;
    } catch (e) {
      if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
        return { clusters: featureCollection([]), clusterCount: 0 };
      }
      throw e;
    }
    if (!isCurrentClusteringEpoch(epoch ?? clusteringEpoch)) {
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    // See runHdbscanClustering: hydrate the lightweight worker tree.
    const leafOrder = indexLeafRanges(fitTree);
    attachLazyChildren(fitTree, leafOrder);
    fitTree._leafOrder = leafOrder;
    service.rehydrateHierarchy(fitTree, coords, nodes);
  }

  midpointHierarchyCounter += 1;
  const hierarchyId = midpointHierarchyCounter;
  persistentMidpointClustering = { service, midpoints: filtered, hierarchyId };

  // Server-cut mode: no resident tree to seed from (see runHdbscanClustering).
  const { labels, activeClusters } = cutProvider || subsetFit
    ? { labels: new Array<number>(filtered.length).fill(-1), activeClusters: [] as ClusterTreeNode[] }
    : service.updateClusteringForZoom(1);
  const uidMap = new Map<number, string>();
  activeClusters.forEach((c) => uidMap.set(c.id, c.uid));

  const uniqueClusterIds = new Set<string>();
  const clusterDoiSums = new Map<string, { sum: number; count: number }>();
  filtered.forEach((mp, i) => {
    const label = labels[i];
    const uid = label === -1 ? "noise" : uidMap.get(label)!;
    mp.clusterId = uid;
    if (uid !== "noise") {
      uniqueClusterIds.add(uid);
      const entry = clusterDoiSums.get(uid) || { sum: 0, count: 0 };
      entry.sum += edgeDoiOf(mp);
      entry.count += 1;
      clusterDoiSums.set(uid, entry);
    }
  });

  const clusterDoi = new Map<string, number>();
  clusterDoiSums.forEach((v, k) => {
    clusterDoi.set(k, v.sum / v.count);
  });

  const { annotationDoiThreshold: annThresh, insetDoiThreshold } = (
    store.getState() as RootState
  ).visualizationSettings;
  const edgeAnnotationActive: ClusterTreeNode[] = [];
  const edgeInsetActive: ClusterTreeNode[] = [];
  activeClusters.forEach((c) => {
    const doi = clusterDoi.get(c.uid) ?? 0;
    if (doi >= insetDoiThreshold) edgeInsetActive.push(c);
    else if (doi >= annThresh) edgeAnnotationActive.push(c);
  });

  store.dispatch(
    setEdgeAnnotationClusteringResults({ activeClusters: edgeAnnotationActive, hierarchyId })
  );
  store.dispatch(
    setEdgeInsetClusteringResults({ activeClusters: edgeInsetActive, hierarchyId })
  );

  const features = filtered.map((m) =>
    point([m.midPoint.x, m.midPoint.y], { id: m.id, cluster: m.clusterId })
  );

  return { clusters: featureCollection(features), clusterCount: uniqueClusterIds.size };
}

export async function runTrajectoryMidpointClusteringWithStatus(
  midpoints: TrajectoryMidpoint[],
  annotationDoiThreshold: number,
  fullSelectionClustering?: { hierarchyTree: ClusterTreeNode },
  parentTaskId?: string,
  epoch?: number
): Promise<ClusterResult> {
  const id = `task:cluster:midpoints:${Date.now()}`;
  startTask({
    id,
    label: "Clustering",
    phase: "Midpoint clusters",
    kind: "compute",
    value: null,
    parentId: parentTaskId,
    // See the node task above: no flash for sub-second server-cut setup.
    minShowMs: resolveCutProvider(undefined) ? 1200 : 150,
    stickyOnCompleteMs: 600,
    progressMode: "indeterminate",
  });

  await new Promise((r) => setTimeout(r, 0));

  if (epoch !== undefined && !isCurrentClusteringEpoch(epoch)) {
    failTask(id, "Superseded");
    return { clusters: featureCollection([]), clusterCount: 0 };
  }

  try {
    const result = await runTrajectoryMidpointClustering(
      midpoints,
      annotationDoiThreshold,
      fullSelectionClustering,
      epoch,
      (fraction) =>
        updateTask({
          id,
          value: Math.min(99, fraction * 100),
          phase: "Fitting midpoint hierarchy…",
          progressMode: "predictive",
        })
    );
    completeTask(id);
    return result;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      failTask(id, "Superseded");
      return { clusters: featureCollection([]), clusterCount: 0 };
    }
    failTask(id, "Clustering failed");
    throw e;
  }
}

/**
 * Updates **midpoint** clustering on zoom/pan by re-cutting the last computed hierarchy.
 * (No Redux dispatch here—midpoint labels live on the objects.)
 */
export function updateTrajectoryMidpointClusteringForZoom(
  _normalizedFactor: number,
  canvasContainer: HTMLDivElement,
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  },
  zoomTransform: d3.ZoomTransform,
  opts?: { force?: boolean }
): { annotation: ClusterResult; inset: ClusterResult } | null {
  if (!persistentMidpointClustering) return null;

  // Store viewport params for refreshClusterActivation().
  persistentMidpointClustering.lastViewport = { canvasContainer, scales, zoomTransform };

  // relationInsetBudget = 0 hides the whole edge pipeline (#261) and the
  // edge hooks skip their groups — the walk, the leaf-order DoI prefix
  // (edgeDoiOf over ~1M midpoints, measured ~20% of interaction CPU), and
  // the split all serve nothing. Budget changes re-enter via the
  // clusterSettings subscription, so this self-heals when re-enabled.
  const edgeBudget = (store.getState() as RootState).clusterSettings.relationInsetBudget;
  if (edgeBudget <= 0) {
    const cached = persistentMidpointClustering.lastZoomCut;
    if (cached && cached.signature === "__edge-off__") return cached.result;
    store.dispatch(updateEdgeAnnotationActiveClusters([]));
    store.dispatch(updateEdgeInsetActiveClusters([]));
    const emptyResult = {
      annotation: { clusters: featureCollection([]), clusterCount: 0, activeUids: [] as string[] },
      inset: { clusters: featureCollection([]), clusterCount: 0, activeUids: [] as string[] },
    };
    persistentMidpointClustering.lastZoomCut = { signature: "__edge-off__", result: emptyResult };
    return emptyResult;
  }

  const viewbox = computeViewbox(canvasContainer, scales, zoomTransform);
  // Rescale by zoom transform so footprints grow/shrink correctly as the user zooms.
  const zoomedXScale = zoomTransform.rescaleX(scales.xScale);
  const zoomedYScale = zoomTransform.rescaleY(scales.yScale);
  const { service, midpoints } = persistentMidpointClustering;

  const { activeClusters } = service.updateClusteringSemanticZoom(
    viewbox,
    zoomedXScale,
    zoomedYScale,
    canvasContainer.clientWidth,
    canvasContainer.clientHeight
  );

  // Delta assignment + DoI means from leaf ranges (issue #315 phase C1):
  // instead of re-labeling every midpoint per settled tick (pre-gate, so it
  // ran for unchanged cuts too), clear the PREVIOUS actives' members and
  // assign the new ones — O(old ∪ new members). The full-clear fallback
  // establishes the "non-members are noise" invariant on the first pass
  // after a (re)initialized clustering; a cluster's range is exactly the
  // set its label marked, so assignments and means are identical.
  // Unchanged uids (active before AND after) skip both write loops: a uid's
  // member range is immutable, so its clusterId writes are already correct
  // (same reasoning as the node path's lastAssignedGroups skip).
  const prevActives = persistentMidpointClustering.lastAssignedActives;
  const nextUids = new Set(activeClusters.map((c) => c.uid));
  if (prevActives) {
    for (const c of prevActives) {
      if (nextUids.has(c.uid)) continue; // unchanged — keep writes
      const memberIdx = service.membersOfCluster(c);
      for (let i = 0; i < memberIdx.length; i++) {
        const mp = midpoints[memberIdx[i]];
        if (mp) mp.clusterId = "noise";
      }
    }
  } else {
    for (const mp of midpoints) mp.clusterId = "noise";
  }
  const prevUids = prevActives ? new Set(prevActives.map((c) => c.uid)) : null;

  // Means via one leaf-order prefix pass (see updateClusteringForZoom);
  // the assignment writes stay range-wise per active cluster. Masked to the
  // VISIBLE members for the same reason as the node split (issue #315 §10.2
  // package B2): the midpoint flood guard below cuts the FULL midpoint tree,
  // so an unmasked mean dilutes to near zero for every candidate.
  const { annotationDoiThreshold, insetDoiThreshold, grayOutDoiThreshold } = (
    store.getState() as RootState
  ).visualizationSettings;
  const clusterDoi = new Map<string, number>();
  const midDoiPrefix =
    activeClusters.length > 0
      ? service.buildLeafOrderMaskedPrefix((i) => {
          const mp = midpoints[i];
          return mp ? edgeDoiOf(mp) : 0;
        }, grayOutDoiThreshold)
      : null;
  for (const c of activeClusters) {
    const mean = midDoiPrefix ? service.clusterVisibleMeanFromPrefix(c, midDoiPrefix) : null;
    if (mean != null && prevUids?.has(c.uid)) {
      // Already assigned and mean available range-wise — no member loop.
      clusterDoi.set(c.uid, mean);
      continue;
    }
    const memberIdx = service.membersOfCluster(c);
    let sum = 0;
    let visible = 0;
    for (let i = 0; i < memberIdx.length; i++) {
      const mp = midpoints[memberIdx[i]];
      if (mp) {
        mp.clusterId = c.uid;
        if (mean == null) {
          const doi = edgeDoiOf(mp);
          if (doi >= grayOutDoiThreshold) {
            sum += doi;
            visible += 1;
          }
        }
      }
    }
    clusterDoi.set(c.uid, mean != null ? mean : visible > 0 ? sum / visible : 0);
  }
  persistentMidpointClustering.lastAssignedActives = activeClusters;

  const edgeAnnotationActive: ClusterTreeNode[] = [];
  const edgeInsetActive: ClusterTreeNode[] = [];
  activeClusters.forEach((c) => {
    const doi = clusterDoi.get(c.uid) ?? 0;
    if (doi >= insetDoiThreshold) edgeInsetActive.push(c);
    else if (doi >= annotationDoiThreshold) edgeAnnotationActive.push(c);
  });

  // Unchanged-cut gate (see updateClusteringForZoom): mp.clusterId was already
  // re-assigned identically above, so only dispatches/features are skipped.
  const cutSignature =
    edgeAnnotationActive.map((c) => c.uid).join(",") +
    "||" +
    edgeInsetActive.map((c) => c.uid).join(",");
  const cachedCut = persistentMidpointClustering.lastZoomCut;
  if (!opts?.force && cachedCut && cachedCut.signature === cutSignature) {
    return cachedCut.result;
  }

  store.dispatch(updateEdgeAnnotationActiveClusters(edgeAnnotationActive));
  store.dispatch(updateEdgeInsetActiveClusters(edgeInsetActive));

  const annSet = new Set(edgeAnnotationActive.map((c) => c.uid));
  const insetSet = new Set(edgeInsetActive.map((c) => c.uid));

  // No GeoJSON features on the zoom path — see updateClusteringForZoom.
  const result = {
    annotation: {
      clusters: featureCollection([]),
      clusterCount: annSet.size,
      activeUids: edgeAnnotationActive.map((c) => c.uid).sort(),
    },
    inset: {
      clusters: featureCollection([]),
      clusterCount: insetSet.size,
      activeUids: edgeInsetActive.map((c) => c.uid).sort(),
    },
  };
  persistentMidpointClustering.lastZoomCut = { signature: cutSignature, result };
  return result;
}

/**
 * Updates clustering on zoom/pan by re-cutting the last computed unified hierarchy.
 * Only the **active set** changes; the hierarchy/labels buffer is reused.
 * Returns separate annotation and inset ClusterResult objects derived from a single
 * semantic-zoom cut, splitting clusters by their average DoI.
 */
export function updateClusteringForZoom(
  _normalizedFactor: number,
  canvasContainer: HTMLDivElement,
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  },
  zoomTransform: d3.ZoomTransform,
  opts?: { force?: boolean }
): { annotation: ClusterResult; inset: ClusterResult } | null {
  if (!persistentNodeClustering) return null;

  // Store viewport params so refreshClusterActivation() can re-run without zoom/pan.
  persistentNodeClustering.lastViewport = { canvasContainer, scales, zoomTransform };
  lastZoomPassAt = performance.now();

  const viewbox = computeViewbox(canvasContainer, scales, zoomTransform);
  // Rescale by zoom transform so footprints grow/shrink correctly as the user zooms.
  const zoomedXScale = zoomTransform.rescaleX(scales.xScale);
  const zoomedYScale = zoomTransform.rescaleY(scales.yScale);
  const { service, nodes } = persistentNodeClustering;

  const { activeClusters, rescuedUids, serverGroups } = service.updateClusteringSemanticZoom(
    viewbox,
    zoomedXScale,
    zoomedYScale,
    canvasContainer.clientWidth,
    canvasContainer.clientHeight,
    // Stale-key cuts only mid-gesture (issue #315 round 4): at rest the
    // exact arrival applies once via onCutReady — no A-then-B inset flip.
    gestureActiveFn?.() ?? false
  );

  // Average DoI per cluster from leaf ranges (issue #315 phase C1): a
  // cluster's members ARE the points its label marks, so iterating the range
  // gives the identical mean without the per-point label/Map pass over all
  // nodes — which ran BEFORE the unchanged-cut gate on every settled tick
  // (measured hot at 1M).
  //
  // The mean is taken over the VISIBLE members only (issue #315 §10.2 package
  // B2): since coarse-first/flood routing cuts the FULL-dataset tree, a
  // candidate's leaf range covers mostly unselected near-zero-DoI leaves and
  // the plain mean dilutes below insetDoiThreshold for EVERY candidate — the
  // user got annotations and zero insets, silently. Visibility is the hidden
  // threshold (the left thumb of the hidden/annotations/insets slider row).
  // With everything visible (uniform DoI, or a 0 threshold) this is
  // bit-identical to the plain mean. Classification only: saliency scoring,
  // budgets and hysteresis keep reading the unmasked DoI.
  //
  // In server-select mode (issue #315 P7 S2) the frame carries the split
  // outright — same masked visible-member mean, same thresholds, computed
  // server-side over the winners only — so this entire pass is skipped.
  const annotationActive: ClusterTreeNode[] = [];
  const insetActive: ClusterTreeNode[] = [];
  if (serverGroups) {
    for (const c of activeClusters) {
      const group = serverGroups.get(c.uid) ?? 0;
      if (group === 2) insetActive.push(c);
      else if (group === 1) annotationActive.push(c);
    }
  } else {
    const { annotationDoiThreshold, insetDoiThreshold, grayOutDoiThreshold } = (
      store.getState() as RootState
    ).visualizationSettings;
    const clusterDoi = new Map<string, number>();
    // Cached per-service DoI prefix (issue #315): building it per pass was
    // an O(1M) alloc+scan per settled tick; DoI changes rebuild the service.
    const doiPrefix =
      activeClusters.length > 0 ? service.getVisibleDoiPrefix(grayOutDoiThreshold) : null;
    for (const c of activeClusters) {
      const mean = doiPrefix ? service.clusterVisibleMeanFromPrefix(c, doiPrefix) : null;
      if (mean != null) {
        clusterDoi.set(c.uid, mean);
        continue;
      }
      const memberIdx = service.membersOfCluster(c);
      let sum = 0;
      let visible = 0;
      for (let i = 0; i < memberIdx.length; i++) {
        const doi = nodes[memberIdx[i]]?.DoI ?? 0;
        if (doi >= grayOutDoiThreshold) {
          sum += doi;
          visible += 1;
        }
      }
      clusterDoi.set(c.uid, visible > 0 ? sum / visible : 0);
    }

    // Split active clusters by average DoI
    activeClusters.forEach((c) => {
      const doi = clusterDoi.get(c.uid) ?? 0;
      if (doi >= insetDoiThreshold) insetActive.push(c);
      else if (doi >= annotationDoiThreshold) annotationActive.push(c);
    });
  }

  // Unchanged-cut gate: same split uid lists on the same hierarchy produce
  // byte-identical per-node assignments and dispatch payloads, so skip both.
  // `force` (refreshClusterActivation) bypasses the gate — settings-driven
  // refreshes are rare and must always re-dispatch.
  const cutSignature =
    annotationActive.map((c) => c.uid).join(",") + "||" + insetActive.map((c) => c.uid).join(",");
  const cachedCut = persistentNodeClustering.lastZoomCut;
  if (!opts?.force && cachedCut && cachedCut.signature === cutSignature) {
    ledgerEvent("zoomPass:unchanged");
    return cachedCut.result;
  }
  // Task 2 attribution (#315): stamp the settle-driven activation dispatch.
  ledgerEvent("zoomPass:dispatch", `ann=${annotationActive.length} inset=${insetActive.length}`);
  for (const c of insetActive) ledgerMark(c.uid, "insetActive");

  const annSet = new Set(annotationActive.map((c) => c.uid));
  const insetSet = new Set(insetActive.map((c) => c.uid));

  // Delta cluster-id assignment via leaf ranges (issue #315 C1, mirrors the
  // midpoint path): clear the previous actives' members, assign the new
  // ones — O(old ∪ new members) instead of relabeling every point. The
  // full-clear fallback establishes the invariant after (re)init.
  // Unchanged clusters (same uid, same group) skip both loops entirely: a
  // uid's member range is immutable, so its writes are already correct —
  // at overview zoom actives cover the whole dataset and the blanket
  // clear+assign was ~2M property writes per cut-changed pass (measured as
  // the budget-slider's dominant main-thread cost at 1M).
  // Server lane: no per-point cluster ids at all (issue #315 R1a step 5, CS
  // decision 2026-08-02). The uid rides the member group (groupClusterUid),
  // which is where every live reader now takes it from — the inline-draft and
  // tf-idf label resolvers and cluster-uid labeling. The winners span the
  // dataset at boot, so this deletes ~2M property writes from the first apply
  // and lets the boot clear-loops below become no-ops as well.
  const stampClusterIds = !isServerCutActive();
  const prevActives = persistentNodeClustering.lastAssignedActives;
  const prevGroups = persistentNodeClustering.lastAssignedGroups;
  const nextGroups = new Map<string, "inset" | "annotation">();
  for (const c of activeClusters) {
    if (insetSet.has(c.uid)) nextGroups.set(c.uid, "inset");
    else if (annSet.has(c.uid)) nextGroups.set(c.uid, "annotation");
  }
  if (!stampClusterIds) {
    // Nothing to clear or assign — record what the next pass would diff
    // against so a later lane switch still behaves.
    persistentNodeClustering.lastAssignedActives = activeClusters;
    persistentNodeClustering.lastAssignedGroups = nextGroups;
  } else if (prevActives) {
    for (const c of prevActives) {
      if (prevGroups) {
        const prevGroup = prevGroups.get(c.uid);
        if (prevGroup === undefined) continue; // was active but never assigned
        if (nextGroups.get(c.uid) === prevGroup) continue; // unchanged — keep writes
      }
      // Range fast path (issue #315 I2): iterate the leaf order in place —
      // materializing each winner's member array cost ~1M-element allocs on
      // the boot first-apply, where the winners span the whole dataset.
      const range = service.leafRangeMembers(c);
      if (range) {
        const { order, first, last } = range;
        for (let i = first; i < last; i++) {
          const pt = nodes[order[i]];
          if (pt) {
            pt.annotationClusterId = undefined;
            pt.insetClusterId = undefined;
          }
        }
      } else {
        const memberIdx = service.membersOfCluster(c);
        for (let i = 0; i < memberIdx.length; i++) {
          const pt = nodes[memberIdx[i]];
          if (pt) {
            pt.annotationClusterId = undefined;
            pt.insetClusterId = undefined;
          }
        }
      }
    }
  } else {
    clearNodeClusterIds(nodes);
  }
  for (const c of stampClusterIds ? activeClusters : []) {
    const group = nextGroups.get(c.uid);
    if (!group) continue;
    if (prevActives && prevGroups && prevGroups.get(c.uid) === group) continue;
    const isInset = group === "inset";
    markClusterIdsStamped();
    const range = service.leafRangeMembers(c);
    if (range) {
      const { order, first, last } = range;
      for (let i = first; i < last; i++) {
        const pt = nodes[order[i]];
        if (!pt) continue;
        if (isInset) pt.insetClusterId = c.uid;
        else pt.annotationClusterId = c.uid;
      }
    } else {
      const memberIdx = service.membersOfCluster(c);
      for (let i = 0; i < memberIdx.length; i++) {
        const pt = nodes[memberIdx[i]];
        if (!pt) continue;
        if (isInset) pt.insetClusterId = c.uid;
        else pt.annotationClusterId = c.uid;
      }
    }
  }
  persistentNodeClustering.lastAssignedActives = activeClusters;
  persistentNodeClustering.lastAssignedGroups = nextGroups;

  // Dispatch active sets for both groups
  store.dispatch(updateAnnotationActiveClusters(annotationActive));
  store.dispatch(updateInsetActiveClusters(insetActive));

  // Base-vs-chain composition for the settings-panel readout (node clusters
  // only).  Sits behind the unchanged-cut gate like the dispatches above; a
  // cluster flipping rescued→area-passing at constant cut can lag one cut
  // change, which is fine for a status display.
  const rescuedSet = new Set(rescuedUids ?? []);
  const chainCount =
    annotationActive.filter((c) => rescuedSet.has(c.uid)).length +
    insetActive.filter((c) => rescuedSet.has(c.uid)).length;
  store.dispatch(
    setActiveClusterStats({
      base: annotationActive.length + insetActive.length - chainCount,
      chain: chainCount,
    })
  );

  // No GeoJSON features on the zoom path (issue #315 C1): activeUids is the
  // change signal, and useClustering — the only consumer of this result —
  // reads nothing else. Building 1M turf points per cut change was pure
  // allocation churn. The initial-clustering path keeps its features.
  const result = {
    annotation: {
      clusters: featureCollection([]),
      clusterCount: annSet.size,
      activeUids: annotationActive.map((c) => c.uid).sort(),
    },
    inset: {
      clusters: featureCollection([]),
      clusterCount: insetSet.size,
      activeUids: insetActive.map((c) => c.uid).sort(),
    },
  };
  persistentNodeClustering.lastZoomCut = { signature: cutSignature, result };
  return result;
}

/**
 * Re-runs the semantic-zoom active-cluster computation using the viewport params
 * captured during the last updateClusteringForZoom call.  Call this whenever
 * clusterSettings change (e.g. slider drag) to update the active set without
 * requiring a zoom or pan interaction.
 *
 * Returns true if a refresh was performed, false if no viewport params are
 * stored yet (clustering hasn't run once with a valid viewport).
 */
/**
 * True once the midpoint (edge) clustering has run a zoom cut at least once,
 * i.e. refreshClusterActivation() would refresh the edge pipeline too.
 * Lets programmatic settings writers (deep links) wait for the edge pipeline
 * instead of firing a refresh that silently skips it.
 */
export function hasMidpointClusteringViewport(): boolean {
  return Boolean(persistentMidpointClustering?.lastViewport);
}

// Server-cut arrival scheduling (issue #315; chessslim-vs-segmenttiles
// smoothness gap CS observed). Two rules:
// 1. Coalesce: the points and midpoints cuts usually land in the same window,
//    and each used to trigger its own refresh of BOTH clustering paths.
// 2. Align with the settled cadence: the local walk runs synchronously INSIDE
//    a settled tick — one burst, aligned with the gesture. A cut arrival lands
//    a round trip later, so refreshing immediately produced an extra
//    mid-gesture burst. Instead, defer past one settled-throttle period: if a
//    normal zoom pass ran meanwhile (continuous gesture), it consumed the
//    stash synchronously and the standalone refresh is skipped; at gesture
//    end the timer fires once.
let cutRefreshScheduled = false;
let lastZoomPassAt = 0;
/**
 * Rule 3, REVISED (issue #315 T0b; the original 170 ms and its H3 history
 * are in plan-315-arc2-destination.md): the long defer existed because the
 * refresh replayed the STORED `lastViewport` transform, which mid-ease was
 * already stale — hence "just past the 150 ms wheel ease". With the live
 * transform provider below, the refresh lays out for where the view IS (or
 * for the announced wheel destination), so the defer's only remaining job
 * is rule 1's coalescing of the points+midpoints arrivals landing in the
 * same window. Traced before shrinking (2026-07-23): rendered overlay
 * geometry is identity-space + the live CSS matrix, so a destination-keyed
 * ACTIVE SET is safe mid-glide; the only thing that must stay on the live
 * per-event transform is applyAnnotationTransform/--invk, which this module
 * never touches.
 */
const CUT_REFRESH_DEFER_MS = 32; // ~2 frames: coalesce same-window arrivals
function scheduleCutRefresh(): void {
  if (cutRefreshScheduled) return;
  cutRefreshScheduled = true;
  const arrivedAt = performance.now();
  setTimeout(() => {
    cutRefreshScheduled = false;
    // A zoom pass after the arrival already consumed the stashed cut.
    if (lastZoomPassAt > arrivedAt) return;
    // Mid-gesture arrivals stay stashed (issue #315): applying them would
    // re-render the annotation subtree per tick — the settle pass consumes
    // the warm stash instead.
    if (gestureActiveFn?.()) return;
    refreshClusterActivation({ force: false });
  }, CUT_REFRESH_DEFER_MS);
}

/**
 * Retire both persistent clustering pipelines at a dataset SWITCH (issue
 * #315 round 4): the aggregate-first base replaces the old scatter at click
 * time, but the OLD dataset's services kept answering settled ticks and
 * re-dispatched their actives right after the switch cleared them — CS saw
 * the previous dataset's insets/contours over the new base for the whole
 * download. The new dataset's init rebuilds both pipelines.
 */
export function clearPersistentClusteringForSwitch(): void {
  persistentNodeClustering = undefined;
  persistentMidpointClustering = null;
}
// Registered through the dependency-free gate so the renderer switch path
// never imports this module (worker-factory import.meta poisons jest graphs).
registerSwitchClear(clearPersistentClusteringForSwitch);
// The select lane's doiRevision coherence gate (issue #315 P7 §1.5.3) needs the
// client's committed server DoI revision. Injected from here — this module
// already imports both halves — so clusteringService keeps its light graph.
setCommittedDoiRevisionProvider(getLastDoiRevision);

/**
 * True when the node clustering runs in server-cut mode (issue #315): App's
 * #322 pan gate consults this — server-cut datasets prefetch cuts during
 * gestures and apply once at settle.
 */
export function isServerCutActive(): boolean {
  return persistentNodeClustering?.service.serverCutMode ?? false;
}

/**
 * Gesture-state provider (issue #315): registered by App so cut ARRIVALS
 * landing mid-gesture don't run the full pipeline (reconcile + React inset
 * mounts + annealer were the measured insets-on stutter; the compositor
 * shows a cached frame during the gesture anyway). The stash stays warm and
 * the gesture-end pass applies it.
 */
let gestureActiveFn: (() => boolean) | null = null;
export function setGestureActiveProvider(fn: (() => boolean) | null): void {
  gestureActiveFn = fn;
}

/**
 * Live transform provider (issue #315 T0b): registered by App as
 * "wheel-burst destination ?? per-event current". refreshClusterActivation
 * prefers it over the STORED lastViewport transform, so cut arrivals lay
 * the annotation surface out for where the view is GOING (zoom) or IS
 * (pan/trackpad) — never for the transform of the last committed pass.
 */
let currentTransformFn: (() => d3.ZoomTransform | null) | null = null;
export function setCurrentTransformProvider(
  fn: (() => d3.ZoomTransform | null) | null
): void {
  currentTransformFn = fn;
}

/**
 * Mid-gesture cut prefetch (issue #315): fire the server cut fetch for the
 * current viewport without scoring/dispatch — the settle pass then applies
 * a warm stash instantly. The midpoint tree prefetches only when the edge
 * pipeline is visible (#261 budget-0 semantics).
 */
export function prefetchServerCut(
  canvasContainer: HTMLDivElement,
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> },
  zoomTransform: d3.ZoomTransform
): void {
  const ctx = persistentNodeClustering;
  if (!ctx?.service.serverCutMode) return;
  const viewbox = computeViewbox(canvasContainer, scales, zoomTransform);
  const w = canvasContainer.clientWidth;
  const h = canvasContainer.clientHeight;
  ctx.service.prefetchCut(viewbox, w, h);
  const mctx = persistentMidpointClustering;
  if (mctx?.service.serverCutMode) {
    const edgeBudget = (store.getState() as RootState).clusterSettings.relationInsetBudget;
    if (edgeBudget > 0) mctx.service.prefetchCut(viewbox, w, h);
  }
}

export function refreshClusterActivation(opts?: { force?: boolean }): boolean {
  // Default force: settings-driven refreshes must always re-dispatch. The
  // server-cut arrival path (onCutReady) passes force:false so an unchanged
  // cut is absorbed by the cutSignature gate instead of churning Redux +
  // reconcile on every settled gesture (CS's flamechart, 2026-07-18).
  const force = opts?.force ?? true;
  const vp = persistentNodeClustering?.lastViewport;
  if (!vp) return false;
  // T0b: the live/destination transform when App registered a provider
  // (headless/test paths fall back to the stored one).
  const live = currentTransformFn?.() ?? null;
  updateClusteringForZoom(0, vp.canvasContainer, vp.scales, live ?? vp.zoomTransform, { force });
  const mvp = persistentMidpointClustering?.lastViewport;
  if (mvp) {
    updateTrajectoryMidpointClusteringForZoom(0, mvp.canvasContainer, mvp.scales, live ?? mvp.zoomTransform, {
      force,
    });
  }
  return true;
}
