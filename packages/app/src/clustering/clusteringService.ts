// packages/app/src/clustering/clusteringService.ts

import type * as d3 from "d3";
import RBush from "rbush";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import { doiGroupOfPoint } from "../doiPropagation/bakedDoi";
import { getPropagationPrecomputation } from "../doiPropagation/propagateDoi";
import {
  ClusterTreeNode,
  ExtendedHDBSCAN,
  ExtendedHDBSCANOptions,
  ZoomUpdateResult,
} from "./ExtendedHDBSCAN";
import type {
  ClusterCutProvider,
  CutCandidate,
  CutPushEvent,
  CutRequest,
  SelectAckEvent,
  SelectCutRequest,
  SelectFrame,
  SelectParams,
  SelectPushEvent,
  SelectedActive,
} from "../scaling.types";
import { resolveSplitThresholdPx } from "../semanticZoom/footprint";
import { computeDoiNonUniform } from "../semanticZoom/saliencyScorer";
import { buildSelectParams } from "../semanticZoom/selectParams";
import { takeStaticBootFrame } from "../semanticZoom/staticBootFrame";
import { SemanticZoomService } from "../semanticZoom/semanticZoomService";
import type { SemanticZoomConfig, Viewbox } from "../semanticZoom/types";
import store from "../store";
import { ledgerEvent, ledgerMark, ledgerNote } from "../utils/insetLedger";
import { warnServerLoss } from "../utils/serverLoss";

/**
 * Frontier node from a server-side cut response (issue #315 S2b). Carries
 * exactly what the post-walk pipeline reads: uid (hysteresis/identity), a
 * numeric id (labels buffer + uidMap; derived from the uid so it is stable
 * and unique within a tree), stability/bbox (scoring), and the leaf range
 * (membersOf slices the pseudo-root's _leafOrder).
 */
function syntheticCutNode(candidate: CutCandidate): ClusterTreeNode {
  return {
    uid: candidate.uid,
    id: parseInt(candidate.uid.slice(2), 16),
    size: candidate.size,
    stability: candidate.stability,
    bbox: candidate.bbox ?? undefined,
    firstLeaf: candidate.leafRanges[0]?.[0] ?? 0,
    lastLeaf: candidate.leafRanges[0]?.[1] ?? 0,
    precomputedHull: candidate.hull ?? undefined,
    insetPos: candidate.insetPos ?? undefined,
    // Server-stamped DoI mass (issue #315 A3 / P-d, §6e): carried onto the
    // synthetic node so scoring prefers it over the leaf-order prefix. A
    // move-only delta spreads the existing candidate (adoptPushedCut), so the
    // stamp survives the mirror rebuild — but only WITHIN one server DoI
    // revision: the server's re-ship test (`_stable_part`) does not include
    // doiMass, so adoptPushedCut wipes carried-over stamps whenever the
    // frame's `doiRevision` advances. Undefined when no server DoI state.
    doiMass: candidate.doiMass,
    distance: 0,
    leftChild: null,
    rightChild: null,
  } as unknown as ClusterTreeNode;
}

/**
 * Frontier node from a server-SELECTED frame (issue #315 P7 S2) — the answer
 * lane's twin of `syntheticCutNode`. Same `ClusterTreeNode` shape (so members,
 * hulls, inset seeds and identity all resolve unchanged), plus the three fields
 * the server now owns: `saliency`, the classification `group`, and the
 * `rescued`/`reserved` pair. `doiMass` is carried verbatim — the select lane
 * never recomputes or compares it client-side, which is what keeps the f32
 * coherence trap (plan §3b.6) out of this path.
 */
function syntheticSelectNode(active: SelectedActive): ClusterTreeNode {
  return {
    uid: active.uid,
    id: parseInt(active.uid.slice(2), 16),
    size: active.size,
    stability: active.stability,
    bbox: active.bbox ?? undefined,
    firstLeaf: active.leafRanges[0]?.[0] ?? 0,
    lastLeaf: active.leafRanges[0]?.[1] ?? 0,
    precomputedHull: active.hull ?? undefined,
    insetPos: active.insetPos ?? undefined,
    doiMass: active.doiMass,
    saliency: active.saliency,
    group: active.group,
    rescued: active.rescued,
    reserved: active.reserved,
    distance: 0,
    leftChild: null,
    rightChild: null,
  } as unknown as ClusterTreeNode;
}

/**
 * The client's committed server DoI revision (issue #315 P7 §1.5.3), injected
 * rather than imported: the select lane's coherence gate needs it, but pulling
 * `doiPropagation/serverPropagation` (and with it `@scaling`) into this module's
 * graph would poison every ClusteringService consumer's module graph.
 * `hdbscanClustering` registers `getLastDoiRevision` at module scope.
 */
let committedDoiRevisionFn: (() => number | null) | null = null;
export function setCommittedDoiRevisionProvider(
  fn: (() => number | null) | null
): void {
  committedDoiRevisionFn = fn;
}

/**
 * Leaf-order prefix pair for visibility-masked aggregates (issue #315 §10.2
 * package B2): `sum` accumulates the value of the VISIBLE leaves only,
 * `count` how many leaves were visible, so a mean over the visible members of
 * any contiguous leaf range is two O(1) range differences.
 */
export interface MaskedLeafPrefix {
  sum: Float64Array;
  count: Float64Array;
}

/** Simple max-heap for selecting top items without full sort. */
class MaxHeap<T> {
  private a: T[] = [];
  constructor(private cmp: (x: T, y: T) => number) {}
  build(items: T[]) {
    this.a = items.slice();
    for (let i = (this.a.length >> 1) - 1; i >= 0; i--) this.down(i);
  }
  empty() {
    return this.a.length === 0;
  }
  pop(): T | undefined {
    const n = this.a.length;
    if (n === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    if (n > 1) {
      this.a[0] = last;
      this.down(0);
    }
    return top;
  }
  private down(i: number) {
    const a = this.a;
    const n = a.length;
    while (true) {
      const l = (i << 1) + 1;
      if (l >= n) break;
      const r = l + 1;
      let best = l;
      if (r < n && this.cmp(a[r], a[l]) > 0) best = r; // max-heap
      if (this.cmp(a[i], a[best]) >= 0) break;
      [a[i], a[best]] = [a[best], a[i]];
      i = best;
    }
  }
}

/** Small epsilon for bbox containment checks to avoid float issues. */
const EPS = 1e-9;

/** Zero-area rbush items for a point set — columnar when the array carries
 * columns (issue #315 R3d: the lazy client lane may build these indexes
 * before residency; `map` over a holey array would hand rbush undefined
 * items), the row walk for subset copies (resident by contract §3.3). */
function pointBoxItems(
  nodes: readonly DataPoint[]
): Array<{ minX: number; minY: number; maxX: number; maxY: number }> {
  const cols = columnsOf(nodes);
  if (cols) {
    const items = new Array<{ minX: number; minY: number; maxX: number; maxY: number }>(
      nodes.length
    );
    for (let i = 0; i < nodes.length; i++) {
      const x = cols.x[i];
      const y = cols.y[i];
      items[i] = { minX: x, minY: y, maxX: x, maxY: y };
    }
    return items;
  }
  return nodes.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }));
}

export class ClusteringService {
  private hdbscan: ExtendedHDBSCAN;
  /** DOI-filtered nodes that were actually clustered. */
  private nodes: DataPoint[] = [];
  /** Full dataset — used as denominator when useGlobalCountingNodes is on. Defaults to nodes. */
  private allNodes: DataPoint[] = [];

  // Keep a handle to the current root (used for DFS leaf-order slicing)
  private root: ClusterTreeNode | null = null;
  private static readonly EMPTY: number[] = [];

  // Hierarchy + spatial indexes
  private parentMap: Map<number, ClusterTreeNode | null> = new Map();
  private clusterIndex = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    node: ClusterTreeNode;
  }>();
  /** Spatial index for the DOI-filtered group nodes (useGlobalCountingNodes = false).
   * LAZY (issue #315 boot): the eager bulk loads over all points were ~40% of
   * the 1M boot main-thread CPU (rbush sort comparators), while the only
   * consumers — the chain-rescue whitespace probe and the legacy
   * relative-threshold count — are rare and latency-tolerant. Built on first
   * search via ensureGroupPointIndex/ensureAllPointIndex. */
  private groupPointIndex = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>();
  private groupPointIndexReady = false;
  /** Spatial index for the full dataset (useGlobalCountingNodes = true). */
  private allPointIndex = new RBush<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>();
  private allPointIndexReady = false;

  private ensureGroupPointIndex(): RBush<{ minX: number; minY: number; maxX: number; maxY: number }> {
    if (!this.groupPointIndexReady) {
      this.groupPointIndex.clear();
      this.groupPointIndex.load(pointBoxItems(this.nodes));
      this.groupPointIndexReady = true;
    }
    return this.groupPointIndex;
  }

  private ensureAllPointIndex(): RBush<{ minX: number; minY: number; maxX: number; maxY: number }> {
    if (!this.allPointIndexReady) {
      this.allPointIndex.clear();
      this.allPointIndex.load(pointBoxItems(this.allNodes));
      this.allPointIndexReady = true;
    }
    return this.allPointIndex;
  }

  // Euler timestamps for O(1) ancestry queries
  private tin = new Map<number, number>();
  private tout = new Map<number, number>();
  private timeCounter = 0;

  // Label buffers with generation stamping
  private labelsBuffer: Int32Array = new Int32Array();
  /** Zoom-cut labels cache (issue #315 C1): reused while the cut signature is
   * unchanged; invalidated by every labelsBuffer re-allocation. */
  private lastZoomCutSig?: string;
  private lastZoomCutLabels?: number[];
  private labelGen: Int32Array = new Int32Array();
  private currentGen = 0;

  // Lightweight caching of last result
  private lastLabels: number[] = [];
  private lastActiveClusters: ClusterTreeNode[] = [];

  // Signature to detect changes in viewbox/settings/hierarchy
  private hierarchyRev = 0;
  private lastSig?: string;

  // Cache for "points in viewbox" count per quantized viewbox
  private lastViewCountSig?: string;
  private lastViewCount = 0;

  // Semantic-zoom pipeline (footprint-based hierarchy cut + hysteresis)
  private semanticZoomService = new SemanticZoomService();

  // ── Server-side cut mode (issue #315 S2b) ────────────────────────────────
  // When a cut provider is installed the walk happens server-side: the
  // settled-transform pass sends a cut request keyed on its inputs; while no
  // stash matches, the LAST result stays active (frozen-cut degradation) and
  // the resolved fetch triggers one refresh via onCutReady. Everything
  // downstream (scoring, hysteresis, labels) runs over synthetic frontier
  // nodes exactly like locally-walked ones.
  private cutProvider: ClusterCutProvider | null = null;
  private cutTree: CutRequest["tree"] = "points";
  private cutStashKey?: string;
  private cutStash?: ClusterTreeNode[];
  private cutFetchKey?: string;
  /** Monotone request/stash counters (issue #315 stuck-actives): responses
   * adopt freshest-wins so a continuous gesture — where every response used
   * to be superseded by the next tick's fetch and dropped — still streams
   * cut updates in instead of freezing actives at gesture-start state. */
  private cutFetchSeq = 0;
  private cutStashSeq = 0;
  /** Viewport subscription (issue #315 Plan H0): when up, ensureCutFetch
   * degrades to a fire-and-forget viewport push and walked frontiers arrive
   * via adoptPushedCut; when it drops, the pull path resumes seamlessly
   * (frozen-cut degradation). */
  private cutSubscribed = false;
  private cutUnsubscribe?: () => void;
  /** Mirror of the server's pushed frontier, uid → candidate (issue #315
   * H1). Deltas mutate it; the stash is rebuilt from it per applied frame.
   * `cutMirrorValid` is false whenever a delta could not be applied — the
   * next viewport push then asks for a full frame. */
  private cutMirror = new Map<string, CutCandidate>();
  private cutMirrorValid = false;
  /** Server DoI revision the last APPLIED cut frame was stamped under (issue
   * #315 A3 / P-d, §6e). Candidate `doiMass` stamps are only valid within one
   * revision, so a change here expires every stamp the mirror carried over —
   * see the wipe in adoptPushedCut. `undefined` means "no server DoI state",
   * which is itself a distinct revision value for that comparison. */
  private lastAppliedDoiRevision?: number;
  /** Lazy leaf-order DoI prefix for O(1) candidate doiMass during scoring —
   * safe to cache per service instance because DoI changes rebuild the
   * ClusteringService (see SemanticZoomService.computeActiveClusterIds). */
  private scoreDoiPrefix?: Float64Array | null;
  /** Masked twin of scoreDoiPrefix for the annotation/inset classification
   * (issue #315 §10.2 package B2) — same per-instance lifetime, plus the
   * hidden threshold it was built with: that one IS user-draggable without a
   * service rebuild, so it keys the cache. */
  private visibleDoiPrefix?: MaskedLeafPrefix | null;
  private visibleDoiPrefixThreshold?: number;
  private lastCutResult?: ZoomUpdateResult;
  private onCutReady?: () => void;

  // ── Server-select mode (issue #315 P7 S2) ────────────────────────────────
  // When the provider advertises `"select-cut"` the server also SCORES and
  // SELECTS: the frame is the ≤ budget answer, so this service stops running
  // computeActiveClusterIds, the client hysteresis, and the masked visible-mean
  // classification pass altogether. It keeps exactly one piece of that state:
  // the hysteresis ECHO (contract b), which is the pool split of the last
  // APPLIED frame and travels in every request.
  /** Last applied frame's main-pool uids (`reserved === false`). */
  private echoMain: string[] = [];
  /** Last applied frame's reserve-pool uids (`reserved === true`) — keyed by
   * the slot won, NOT by rescue eligibility (plan §3b.1). */
  private echoRescue: string[] = [];
  /** The freshest arrived select frame; the answer-lane twin of `cutStash`
   * (which stays undefined in select mode). Shares `cutStashKey`/`cutStashSeq`
   * so freshest-wins adoption is literally the same bookkeeping. */
  private selectStash?: SelectFrame;
  /** `subOrdinal` of the last ADOPTED pushed select frame (issue #315 P7 S3,
   * seq contract A2/A3). A server-initiated re-select re-answers the
   * subscription's CURRENT seq, so seq alone cannot order two frames; this
   * per-stream monotone counter can. 0 = nothing pushed has been adopted. */
  private lastAppliedSubOrdinal = 0;
  /** The last select request issued (pull or push). The pushed-frame stale-
   * revision path re-asks the same question from it — a pushed frame carries no
   * request object of its own. */
  private lastSelectRequest?: SelectCutRequest;
  /** Boot warm-frame state (issue #315 insets-at-boot I1). `bootFrameKey`:
   * the adopted boot frame's key while the live lane has not yet asked ANY
   * question — the first `ensureCutFetch` must push even on a stash-key hit,
   * or the fresh subscription would never register its select question
   * server-side (A3 reselects, `content_pushed` memory). `selectStashIsBoot`:
   * the current stash came from the boot warmer — the registration push's
   * answer is normally identical, and re-applying an identical frame re-runs
   * the O(members) first-apply work for zero visual change. */
  private bootFrameKey?: string;
  private selectStashIsBoot = false;
  /** Static boot-frame gate (issue #315 insets-at-boot I3, CLIENT lane).
   * Armed by hdbscanClustering's precomputed-hierarchy boot path ONLY — the
   * artifact's uids/leaf ranges live in the shipped tree's vocabulary, so a
   * worker-fit tree (uploads, reprojection, subset refits) must never adopt.
   * One-shot: the FIRST zoom pass disarms it whether or not the artifact
   * arrived, and takeStaticBootFrame tombstones the dataset's slot, so a
   * slow fetch or a later select-all recluster can never apply the boot
   * view mid-session. */
  private staticBootArmed = false;

  /**
   * Data-space half-extent added to leaf-node bboxes.
   * Derived from the data range so single-point clusters have a footprint
   * that grows with zoom, making them labelable at sufficient zoom-in depth.
   */
  private leafPadX = 0;
  private leafPadY = 0;

  constructor(options: ExtendedHDBSCANOptions) {
    this.hdbscan = new ExtendedHDBSCAN(options);
  }

  /** Return member indices for a node across both legacy & lightweight trees. */
  private membersOf(n: ClusterTreeNode): number[] {
    // 1) Legacy or lazy getter present
    if (Array.isArray(n.children)) return n.children;

    // 2) Lightweight leaf
    if (n.leafIndex != null) return [n.leafIndex];

    // 3) Lightweight internal (slice the global leaf order if available)
    const order = this.root?._leafOrder;
    if (order && n.firstLeaf != null && n.lastLeaf != null) {
      // Server-cut leaf orders are Uint32Array (issue #315 P7 S6a); the
      // members contract downstream is a plain array of indices.
      return Array.isArray(order)
        ? order.slice(n.firstLeaf, n.lastLeaf)
        : Array.from(order.subarray(n.firstLeaf, n.lastLeaf));
    }

    // 4) Fallback: empty
    return ClusteringService.EMPTY;
  }

  /**
   * Public membership resolution for cut-driven grouping (issue #315 phase
   * C1): indices into the clustering input array for any active cluster.
   * Same semantics as the private membersOf.
   */
  public membersOfCluster(n: ClusterTreeNode): number[] {
    return this.membersOf(n);
  }

  /**
   * Allocation-free membership access for tight per-member loops (issue
   * #315 I2): the boot first-apply spans the whole dataset, and
   * membersOfCluster materialized ~1M-element index arrays only to be
   * iterated once. Returns the raw leaf order + half-open range, or null
   * whenever membersOf would NOT take the leaf-range branch (legacy
   * children array, lightweight leaf, no order) — callers must fall back
   * to membersOfCluster then, so both paths always agree.
   */
  public leafRangeMembers(
    n: ClusterTreeNode
  ): { order: ArrayLike<number>; first: number; last: number } | null {
    if (Array.isArray(n.children) || n.leafIndex != null) return null;
    const order = this.root?._leafOrder;
    if (order && n.firstLeaf != null && n.lastLeaf != null) {
      return { order, first: n.firstLeaf, last: n.lastLeaf };
    }
    return null;
  }

  /** Raw boot-once leaf order (issue #315 I2) for `__leafRange`-marked
   * consumers resolving canonical indices without a tree node in hand. */
  public leafOrderView(): ArrayLike<number> | null {
    return this.root?._leafOrder ?? null;
  }

  /**
   * Leaf-order prefix sums of valueOf(pointIndex) — one tight O(n) pass so
   * per-cluster aggregates become O(1) range differences (issue #315 C1:
   * the per-cluster member loops cost ~27% of interaction CPU at 1M, most
   * of it per-member accessor overhead). Returns null for legacy trees
   * without a global leaf order.
   */
  public buildLeafOrderPrefix(valueOf: (idx: number) => number): Float64Array | null {
    const order = this.root?._leafOrder;
    if (!order) return null;
    const p = new Float64Array(order.length + 1);
    for (let i = 0; i < order.length; i++) p[i + 1] = p[i] + valueOf(order[i]);
    return p;
  }

  /** Lazily-built leaf-order x/y prefix sums (issue #315 C2/D2): positions
   * are immutable for a hierarchy's lifetime (reprojection rebuilds the
   * clustering), so cluster centroids become O(1) range differences —
   * meanPoint over members was 15.7% of 1M interaction CPU. */
  private xyPrefix?: { px: Float64Array; py: Float64Array } | null;

  public clusterCentroidFromPrefix(n: ClusterTreeNode): { x: number; y: number } | null {
    if (n.firstLeaf == null || n.lastLeaf == null || n.lastLeaf <= n.firstLeaf) return null;
    if (this.xyPrefix === undefined) {
      // Columnar fast path (issue #315 I2): the per-point object walk cost
      // 121–232 ms at 1M on the first boot-frame apply; cols.x/cols.y carry
      // the same immutable positions as the point objects.
      const cols = columnsOf(this.nodes);
      const px = cols
        ? this.buildLeafOrderPrefixFromArray(cols.x)
        : this.buildLeafOrderPrefix((i) => this.nodes[i]?.x ?? 0);
      const py = cols
        ? this.buildLeafOrderPrefixFromArray(cols.y)
        : this.buildLeafOrderPrefix((i) => this.nodes[i]?.y ?? 0);
      this.xyPrefix = px && py ? { px, py } : null;
    }
    const pre = this.xyPrefix;
    if (!pre || n.lastLeaf > pre.px.length - 1 || n.firstLeaf < 0) return null;
    const cnt = n.lastLeaf - n.firstLeaf;
    return {
      x: (pre.px[n.lastLeaf] - pre.px[n.firstLeaf]) / cnt,
      y: (pre.py[n.lastLeaf] - pre.py[n.firstLeaf]) / cnt,
    };
  }

  /** Callback-free twin of buildLeafOrderPrefix over a typed-array column
   * (issue #315 D2): the per-element closure call dominated the pass. */
  public buildLeafOrderPrefixFromArray(values: ArrayLike<number>): Float64Array | null {
    const order = this.root?._leafOrder;
    if (!order) return null;
    const p = new Float64Array(order.length + 1);
    for (let i = 0; i < order.length; i++) p[i + 1] = p[i] + (values[order[i]] ?? 0);
    return p;
  }

  /** The lazy per-service leaf-order DoI prefix (issue #315): built once —
   * DoI changes rebuild the ClusteringService, so caching per instance is
   * safe (see SemanticZoomService.computeActiveClusterIds). Rebuilding it
   * per settled tick was 7.6% of pan CPU at 1M. Null for legacy trees. */
  public getDoiPrefix(): Float64Array | null {
    if (this.scoreDoiPrefix === undefined) {
      const cols = columnsOf(this.nodes);
      this.scoreDoiPrefix = cols
        ? this.buildLeafOrderPrefixFromArray(cols.doi)
        : this.buildLeafOrderPrefix((i) => {
            const d = this.nodes[i]?.DoI;
            return d !== undefined && isFinite(d) ? d : 0;
          });
    }
    return this.scoreDoiPrefix;
  }

  /** O(1) DoI mass for a contiguous-leaf-range candidate via the lazy DoI
   * prefix, or null (→ caller falls back to the member loop). Keeps the
   * per-settled-tick scoring pass off O(points-in-viewport) member scans now
   * that stale-stash scoring runs mid-gesture (issue #315 stuck-actives). */
  public clusterDoiMassFromPrefix(n: ClusterTreeNode): number | null {
    // Server-stamped mass wins when present (issue #315 A3 / P-d, §6e): the
    // server prefix-summed its own DoI vector over this candidate's leafRanges,
    // so the client's leaf-order prefix is redundant. Absent ⇒ fall through to
    // the existing computation unchanged (client-complete stays bit-identical).
    if (n.doiMass !== undefined) return n.doiMass;
    if (n.firstLeaf == null || n.lastLeaf == null || n.lastLeaf <= n.firstLeaf) return null;
    const pre = this.getDoiPrefix();
    if (!pre || n.lastLeaf > pre.length - 1 || n.firstLeaf < 0) return null;
    return pre[n.lastLeaf] - pre[n.firstLeaf];
  }

  /** Mean of the prefix-summed value over n's members, or null when n has no
   * contiguous leaf range (legacy children arrays, single leaves). */
  public clusterMeanFromPrefix(n: ClusterTreeNode, prefix: Float64Array): number | null {
    if (n.firstLeaf == null || n.lastLeaf == null) return null;
    const first = n.firstLeaf;
    const last = n.lastLeaf;
    if (first < 0 || last > prefix.length - 1 || last <= first) return null;
    return (prefix[last] - prefix[first]) / (last - first);
  }

  /**
   * Masked twin of buildLeafOrderPrefix (issue #315 §10.2 package B2): prefix
   * sums of the value AND of the visibility indicator `value >= threshold`.
   * Same null semantics as buildLeafOrderPrefix (legacy trees without a global
   * leaf order).
   */
  public buildLeafOrderMaskedPrefix(
    valueOf: (idx: number) => number,
    threshold: number
  ): MaskedLeafPrefix | null {
    const order = this.root?._leafOrder;
    if (!order) return null;
    const sum = new Float64Array(order.length + 1);
    const count = new Float64Array(order.length + 1);
    for (let i = 0; i < order.length; i++) {
      const v = valueOf(order[i]);
      const visible = v >= threshold;
      sum[i + 1] = sum[i] + (visible ? v : 0);
      count[i + 1] = count[i] + (visible ? 1 : 0);
    }
    return { sum, count };
  }

  /**
   * The lazy leaf-order MASKED DoI prefix for the annotation/inset split
   * (issue #315 §10.2 package B2). Cached per service instance exactly like
   * getDoiPrefix (DoI changes rebuild the service) and additionally keyed on
   * `hiddenThreshold`, which a slider drag can change without a rebuild.
   */
  public getVisibleDoiPrefix(hiddenThreshold: number): MaskedLeafPrefix | null {
    if (
      this.visibleDoiPrefix === undefined ||
      this.visibleDoiPrefixThreshold !== hiddenThreshold
    ) {
      const cols = columnsOf(this.nodes);
      const valueOf = cols
        ? (i: number) => cols.doi[i] ?? 0
        : (i: number) => {
            const d = this.nodes[i]?.DoI;
            return d !== undefined && isFinite(d) ? d : 0;
          };
      this.visibleDoiPrefix = this.buildLeafOrderMaskedPrefix(valueOf, hiddenThreshold);
      this.visibleDoiPrefixThreshold = hiddenThreshold;
    }
    return this.visibleDoiPrefix;
  }

  /**
   * Mean over the VISIBLE members of n (issue #315 §10.2 package B2) — the
   * classification mean for the annotation/inset split. Under a full-tree
   * (coarse/flood) cut a candidate's leaf range covers mostly unselected,
   * near-zero-DoI leaves, so the plain mean dilutes below every threshold and
   * NO cluster ever classifies as an inset; masking to the visible leaves
   * restores the pre-full-tree meaning of the split.
   *
   * An all-hidden cluster reports 0 — neither annotation nor inset. Null
   * exactly where clusterMeanFromPrefix is null (no contiguous leaf range).
   * With every leaf visible (uniform DoI, or a 0 threshold) the result is
   * identical to clusterMeanFromPrefix over the unmasked prefix.
   */
  public clusterVisibleMeanFromPrefix(
    n: ClusterTreeNode,
    prefix: MaskedLeafPrefix
  ): number | null {
    if (n.firstLeaf == null || n.lastLeaf == null) return null;
    const first = n.firstLeaf;
    const last = n.lastLeaf;
    if (first < 0 || last > prefix.count.length - 1 || last <= first) return null;
    const visible = prefix.count[last] - prefix.count[first];
    if (visible === 0) return 0;
    return (prefix.sum[last] - prefix.sum[first]) / visible;
  }

  /**
   * Compute leaf-bbox padding proportional to the overall data range.
   * 0.1 % of each axis range — invisible at normal zoom but grows with zoom
   * so leaf clusters can exceed labelMinFraction when zoomed in far enough.
   */
  private computeLeafPad(data: number[][]): void {
    if (data.length === 0) { this.leafPadX = 0; this.leafPadY = 0; return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of data) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.leafPadX = Math.max((maxX - minX) * 1e-3, Number.EPSILON);
    this.leafPadY = Math.max((maxY - minY) * 1e-3, Number.EPSILON);
  }

  /**
   * Overwrite leaf-node bboxes with the current leafPad values.
   * Must be called after assignBBoxes (parent bboxes are already set and are
   * not updated here — the padding is tiny relative to the data range so it
   * has no meaningful effect on spatial lookups against parent bboxes).
   */
  private patchLeafBBoxes(node: ClusterTreeNode, data: number[][]): void {
    if (!node.leftChild && !node.rightChild) {
      const idx = this.membersOf(node)[0]!;
      // Coords, not rows (issue #315 R3d): `data` carries the same immutable
      // positions in the same fit index space, and stays index-complete on
      // the client lazy lane where the row array still has holes.
      const p = data[idx];
      node.bbox = {
        minX: p[0] - this.leafPadX,
        maxX: p[0] + this.leafPadX,
        minY: p[1] - this.leafPadY,
        maxY: p[1] + this.leafPadY,
      };
      return;
    }
    if (node.leftChild) this.patchLeafBBoxes(node.leftChild, data);
    if (node.rightChild) this.patchLeafBBoxes(node.rightChild, data);
  }

  /** Assign bboxes to all nodes (bottom-up). */
  private assignBBoxes(node: ClusterTreeNode, data: number[][]): void {
    if (node.bbox) return;

    if (!node.leftChild && !node.rightChild) {
      // leaf — coords, not rows (issue #315 R3d, see patchLeafBBoxes).
      const idx = this.membersOf(node)[0]!;
      const p = data[idx];
      node.bbox = { minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] };
      return;
    }

    if (node.leftChild) this.assignBBoxes(node.leftChild, data);
    if (node.rightChild) this.assignBBoxes(node.rightChild, data);

    const b1 = node.leftChild!.bbox!;
    const b2 = node.rightChild!.bbox!;
    node.bbox = {
      minX: Math.min(b1.minX, b2.minX),
      minY: Math.min(b1.minY, b2.minY),
      maxX: Math.max(b1.maxX, b2.maxX),
      maxY: Math.max(b1.maxY, b2.maxY),
    };
  }

  private indexAllNodes(node: ClusterTreeNode): void {
    if (!node.bbox) return;
    this.clusterIndex.insert({
      minX: node.bbox.minX,
      minY: node.bbox.minY,
      maxX: node.bbox.maxX,
      maxY: node.bbox.maxY,
      node,
    });
    if (node.leftChild) this.indexAllNodes(node.leftChild);
    if (node.rightChild) this.indexAllNodes(node.rightChild);
  }

  public computeClustering(
    data: number[][],
    nodes: DataPoint[],
    allNodes?: DataPoint[]
  ): number[] {
    this.nodes = nodes;
    this.allNodes = allNodes ?? nodes;

    const labels = this.hdbscan.fit(data);
    const root = this.hdbscan.getHierarchyTree();
    this.root = root ?? null;

    if (root) {
      this.computeLeafPad(data);
      if (!root.bbox) this.assignBBoxes(root, data);
      this.patchLeafBBoxes(root, data);
      this.clusterIndex.clear();
      this.indexAllNodes(root);
      this.createParentMap();

      // Euler tour timestamps
      this.tin.clear();
      this.tout.clear();
      this.timeCounter = 0;
      const dfs = (n: ClusterTreeNode) => {
        this.tin.set(n.id, this.timeCounter++);
        if (n.leftChild) dfs(n.leftChild);
        if (n.rightChild) dfs(n.rightChild);
        this.tout.set(n.id, this.timeCounter++);
      };
      dfs(root);
    }

    // Spatial indexes — invalidated here, built lazily on first use.
    this.groupPointIndexReady = false;
    this.allPointIndexReady = false;

    // Buffers + caches
    this.labelsBuffer = new Int32Array(data.length);
    this.labelGen = new Int32Array(data.length);
    this.currentGen = 0;
    this.lastZoomCutSig = undefined;
    this.lastZoomCutLabels = undefined;

    this.lastLabels = [];
    this.lastActiveClusters = [];

    // Hierarchy revision bump
    this.hierarchyRev++;
    this.lastSig = undefined;

    // Reset semantic-zoom hysteresis so stale UIDs don't carry over.
    this.semanticZoomService.reset();
    this.resetSelectEcho();

    return labels;
  }

  /**
   * Server-cut mode setup (issue #315 S2b): no tree is shipped or fit — the
   * provider answers "cut for viewbox V" per settled transform. Mirrors
   * rehydrateHierarchy minus all tree work (no bbox pass, no node R-tree, no
   * parent map, no Euler tour: nothing downstream of the semantic-zoom path
   * reads them). The pseudo-root carries the boot-once leaf→pointIndex
   * permutation so membersOf() slices members unchanged.
   */
  /** Fitted-subset scope of the active server cut (issue #315 F2c):
   * range-marked member arrays must carry it so inset requests resolve
   * against the FITTED leaf order, not the base tree's. */
  public get serverCutFit(): string | undefined {
    return this.cutProvider?.fit;
  }

  public initServerCut(
    provider: ClusterCutProvider,
    tree: CutRequest["tree"],
    leafOrder: number[] | Uint32Array,
    nodes: DataPoint[],
    allNodes?: DataPoint[]
  ): void {
    this.nodes = nodes;
    this.allNodes = allNodes ?? nodes;
    this.cutProvider = provider;
    this.cutTree = tree;
    this.semanticZoomService.debugTag = tree;
    this.root = { _leafOrder: leafOrder } as unknown as ClusterTreeNode;

    // Viewport subscription (issue #315 Plan H0): prefer pushed cuts when
    // the provider supports them. Opening replaces any previous stream for
    // this backend+tree (module-level registry), so retired services from
    // earlier clustering runs are implicitly cut off.
    this.cutUnsubscribe?.();
    this.cutUnsubscribe = undefined;
    this.cutSubscribed = false;
    this.cutMirror = new Map();
    this.cutMirrorValid = false;
    // The push lane serves BOTH lanes (issue #315 P7 S3): a viewport push
    // carrying the `select` block is answered with `event: sel` full frames, one
    // without it with the candidate deltas. Which one arrives is decided per
    // push by buildCutRequest, so no capability check is needed here.
    if (provider.subscribe && provider.pushViewport) {
      this.cutUnsubscribe = provider.subscribe(tree, {
        onCut: (event) => {
          if (this.serverSelectMode) {
            // Cannot happen with an S3 server (select pushes answer `sel`), but
            // an OLDER server ignores the unknown `select` field and answers
            // with candidates. Adopting them under a select stash key would mix
            // the lanes; ledger and drop, and the pull fallback keeps the view
            // alive via the frozen-cut degradation.
            ledgerEvent("sel:cutIgnored", event.key);
            return;
          }
          this.adoptPushedCut(event);
        },
        onSelect: (event) => this.adoptPushedSelect(event),
        onSelectAck: (event) => this.adoptSelectAck(event),
        onDown: () => {
          // Frozen-cut degradation: resume the pull path. Clear the
          // in-flight key — its pushed answer will never arrive, and
          // leaving it set would make ensureCutFetch skip the refetch.
          // The mirror dies with the stream: a reconnect gets a fresh
          // subId and therefore a fresh server-side frontier.
          this.cutSubscribed = false;
          this.cutFetchKey = undefined;
          this.cutMirrorValid = false;
          ledgerEvent("cut:subDown", this.cutTree);
          // §8.8d: stream loss is the client's FIRST definitive server-loss
          // signal — probe once and warn IMMEDIATELY when the server is gone,
          // instead of waiting for the next interaction's fetch to fail
          // (CS 2026-08-05: the interaction-triggered banner arrived seconds
          // late and was easy to miss). The provider-identity guard drops a
          // probe that resolves after a dataset switch moved on.
          void provider.probeHealth?.().then((ok) => {
            if (ok || this.cutProvider !== provider) return;
            warnServerLoss();
          });
        },
      });
      this.cutSubscribed = true;
      ledgerEvent("cut:subscribe", tree);
    }

    // Spatial indexes (chain rescue's whitespace probe + view counting) —
    // invalidated here, built lazily on first use: the two eager 1M-item
    // bulk loads were ~40% of the boot main-thread CPU (issue #315).
    this.groupPointIndexReady = false;
    this.allPointIndexReady = false;

    // Buffers + caches
    this.labelsBuffer = new Int32Array(nodes.length);
    this.labelGen = new Int32Array(nodes.length);
    this.currentGen = 0;
    this.lastZoomCutSig = undefined;
    this.lastZoomCutLabels = undefined;
    this.lastLabels = [];
    this.lastActiveClusters = [];
    this.cutStashKey = undefined;
    this.cutStash = undefined;
    this.cutFetchKey = undefined;
    this.cutFetchSeq = 0;
    this.cutStashSeq = 0;
    this.scoreDoiPrefix = undefined;
    this.visibleDoiPrefix = undefined;
    this.visibleDoiPrefixThreshold = undefined;
    this.doiNonUniformCached = undefined;
    this.lastFrameFocusActive = undefined;
    this.lastAppliedDoiRevision = undefined;
    this.lastCutResult = undefined;
    this.selectStash = undefined;
    this.bootFrameKey = undefined;
    this.selectStashIsBoot = false;
    // Provider lanes never adopt the static artifact (issue #315 I3) — the
    // server lane has the LIVE warm frame (I1), exact for the real canvas.
    this.staticBootArmed = false;
    // A fresh subscription starts its own ordinal space at 1 (issue #315 P7 S3).
    this.lastAppliedSubOrdinal = 0;
    this.lastSelectRequest = undefined;

    this.hierarchyRev++;
    this.lastSig = undefined;
    this.semanticZoomService.reset();
    // Epoch / hierarchyId / dataset switch: a refit renumbers uids, so the echo
    // must go with the hysteresis it mirrors (P7 §1.5.4 — the first post-refit
    // frame then selects hysteresis-free, today's semantics).
    this.resetSelectEcho();

    // Boot warm frame (issue #315 insets-at-boot I1): the boot warmer's
    // subscription already received the full boot-viewport answer while the
    // dataset was still downloading. Adopt it as the seq-0 stash so the first
    // settled zoom pass mounts insets from it instead of waiting for the
    // fresh subscription's push round trip. cutStashSeq stays 0 — every real
    // frame (seq ≥ 1) supersedes it under the existing drop rules; fit-scoped
    // providers never yield one (vocabulary mismatch), and a fit tag in the
    // frame key is rejected the same way adoptPushedSelect rejects it.
    if (this.serverSelectMode) {
      const boot = provider.takeBootSelectFrame?.(tree);
      if (boot && !boot.aborted) {
        const bootFit = /(?:^|:)fit=([^:]*)/.exec(boot.key)?.[1] || undefined;
        if (bootFit === (provider.fit ?? undefined)) {
          this.selectStash = boot;
          this.cutStashKey = boot.key;
          this.bootFrameKey = boot.key;
          this.selectStashIsBoot = true;
          this.lastFrameFocusActive = boot.focusActive;
          this.lastAppliedDoiRevision = boot.doiRevision ?? undefined;
          ledgerEvent("sel:bootFrame", `${boot.key} n=${boot.actives.length}`);
        }
      }
    }
  }

  /** Drop the hysteresis echo (issue #315 P7 §1.5.4). Called at every site that
   * resets `semanticZoomService` — the echo IS the server-side twin of that
   * state, so the two must never reset apart. */
  private resetSelectEcho(): void {
    this.echoMain = [];
    this.echoRescue = [];
  }

  /** Called when an async cut lands so the caller can re-run the zoom pass. */
  public setOnCutReady(callback: (() => void) | undefined): void {
    this.onCutReady = callback;
  }

  /** Whether cuts are arriving pushed rather than pulled (issue #315 Plan
   * H) — diagnostics and tests; it flips back to false when a stream drops
   * and the service falls back to pulling.
   *
   * NOT a licence to shorten the caller's refresh defer: that defer orders
   * the annotation refresh AFTER the wheel ease, independently of how the
   * cut arrived. See scheduleCutRefresh. */
  public isCutSubscribed(): boolean {
    return this.cutSubscribed;
  }

  /** Cut request for the current viewport — shared by the zoom pass and the
   * gesture prefetch path. `doiNonUniform` is cached per service instance
   * (DoI changes rebuild the service): the O(dataset) uniformity scan ran
   * twice per settled tick before. */
  private doiNonUniformCached?: boolean;
  /** The `focus_active` bit of the latest adopted cut frame (issue #315 A3 /
   * P-d, §6e): a server that owns the DoI vector knows non-uniformity for
   * free, so once frames carry it the client skips the O(dataset) scan. Undefined
   * until a stamped frame lands — the scan is the (correct) fallback. */
  private lastFrameFocusActive?: boolean;
  private buildCutRequest(
    viewbox: Viewbox,
    canvasWidthPx: number,
    canvasHeightPx: number,
    selectionActive: boolean
  ): CutRequest | SelectCutRequest {
    // Prefer the server-stamped focus_active from the latest cut frame (§6e);
    // fall back to the cached O(n) uniformity scan when no stamped frame has
    // arrived (client-complete datasets, or the first request before any frame).
    let focusFromDoi: boolean;
    if (this.lastFrameFocusActive !== undefined) {
      focusFromDoi = this.lastFrameFocusActive;
    } else {
      if (this.doiNonUniformCached === undefined) {
        this.doiNonUniformCached = computeDoiNonUniform(this.nodes);
      }
      focusFromDoi = this.doiNonUniformCached;
    }
    const settings = store.getState().clusterSettings;
    const request: CutRequest = {
      tree: this.cutTree,
      viewbox,
      canvasWidth: canvasWidthPx,
      canvasHeight: canvasHeightPx,
      splitThresholdFraction: settings.splitThresholdFraction,
      gapDisclosurePx: settings.gapDisclosurePx,
      focusActive: selectionActive || focusFromDoi,
    };
    // Server-select mode (issue #315 P7 S2): the same request, plus the answer
    // lane's block. Added HERE so both entry points — the settled zoom pass and
    // the mid-gesture prefetch — key and fetch the same question.
    if (this.serverSelectMode) {
      return { ...request, select: this.buildSelectParams() } as SelectCutRequest;
    }
    return request;
  }

  /**
   * True when the server also scores + selects for this service (issue #315 P7
   * S2): the resolved provider exposes `selectCut`, its manifest advertises the
   * `"select-cut"` capability, and the tree is `points`.
   *
   * The midpoints tree deliberately stays on the candidates lane (plan G9): the
   * server has no midpoint→endpoint DoI index, so relation insets keep their
   * client pipeline while the points tree runs the answer lane.
   */
  public get serverSelectMode(): boolean {
    const provider = this.cutProvider;
    if (!provider?.selectCut) return false;
    if (!provider.manifest.capabilities?.includes("select-cut")) return false;
    return this.cutTree === "points";
  }

  /**
   * The `select` block for the current settings + echo (issue #315 P7 §1.1).
   * Delegates to the shared builder so the boot warmer's push (which has no
   * service and therefore an empty echo) asks the SAME question — see
   * `semanticZoom/selectParams.ts`.
   */
  private buildSelectParams(settled = true): SelectParams {
    // The pools the client holds going INTO this frame (contract b).
    return buildSelectParams(
      { main: this.echoMain, rescue: this.echoRescue },
      settled
    );
  }

  /** Fire the fetch for `request` unless its response is already stashed or
   * in flight; returns the request key. Freshest-wins adoption (issue #315
   * stuck-actives): every response newer than the current stash is adopted —
   * during a continuous gesture the next tick's fetch supersedes every
   * response before it lands, and discarding those froze actives at
   * gesture-start state. Out-of-order OLDER responses are the only drop. */
  private ensureCutFetch(request: CutRequest | SelectCutRequest): string {
    const key = this.cutProvider!.cutKey(request);
    // Boot warm frame (issue #315 insets-at-boot I1): the adopted boot stash
    // answered a question this client never asked, so the stash-key hit must
    // NOT swallow the first real request — the server still has to learn this
    // subscription's select question (A3 reselects, content memory). One-shot:
    // any issued question clears the marker (a different key supersedes the
    // boot frame through the normal lanes anyway).
    if (this.bootFrameKey === undefined) {
      if (this.cutStashKey === key || this.cutFetchKey === key) return key;
    } else {
      this.bootFrameKey = undefined;
      if (this.cutFetchKey === key) return key;
    }
    this.cutFetchKey = key;
    const seq = ++this.cutFetchSeq;
    if ("select" in request) this.lastSelectRequest = request;
    // Registration marker (issue #315 ack fix): the server may ack an
    // identical re-ask ONLY when the asker holds the frame — which is
    // exactly this state: the adopted boot stash answers `key` and this
    // push exists purely to register the question. The marker rides an
    // outgoing COPY so `lastSelectRequest` stays unmarked (a later stale-
    // revision re-ask of the same question is not a registration).
    let outgoing: CutRequest | SelectCutRequest = request;
    if (
      "select" in request &&
      this.selectStashIsBoot &&
      this.selectStash !== undefined &&
      this.cutStashKey === key
    ) {
      outgoing = { ...request, registration: true };
    }
    // Subscription mode (issue #315 Plan H0, extended to the answer lane by P7
    // S3): stream the viewport up and return — the walked frontier arrives via
    // adoptPushedCut, the selected frame via adoptPushedSelect. This is the lane
    // that answers DURING a gesture instead of one RTT after it settles, so it
    // comes FIRST for both request shapes; a dead registry entry (false) falls
    // straight through to the pull path below. `wantReset` is candidate-lane
    // bookkeeping — select frames are always full — and the server ignores it
    // on a select push.
    if (this.cutSubscribed && this.cutProvider!.pushViewport) {
      if (this.cutProvider!.pushViewport(outgoing, seq, key, !this.cutMirrorValid)) {
        ledgerEvent("select" in outgoing ? "sel:push" : "cut:push", key);
        return key;
      }
      this.cutSubscribed = false;
    }
    // Server-select mode (issue #315 P7 S2): the ANSWER lane, pulled — the
    // permanent fallback whenever no stream is up.
    if ("select" in outgoing) {
      this.fetchSelect(outgoing, key, seq);
      return key;
    }
    ledgerEvent("cut:fetch", key);
    this.cutProvider!
      .getCut(request)
      .then((response) => {
        if (seq <= this.cutStashSeq) {
          ledgerEvent("cut:dropOld", key);
          return;
        }
        this.cutStash = response.candidates.map(syntheticCutNode);
        this.cutStashKey = key;
        this.cutStashSeq = seq;
        // Server-stamped focus_active (§6e) feeds the NEXT cut request's
        // focusActive, retiring the client scan once DoI state exists.
        if (response.focus_active !== undefined) {
          this.lastFrameFocusActive = response.focus_active;
        }
        // A pull response is a FULL frontier — every candidate's stamp was
        // computed under this frame's revision, so nothing needs wiping here.
        // Recording the revision keeps the push path's expiry check coherent
        // across a pull↔push transition (issue #315 A3 / P-d, §6e).
        this.lastAppliedDoiRevision = response.doiRevision;
        // Task 2 attribution: stamp every candidate's arrival + the spans
        // its range-keyed content request will embed (harness-side join).
        ledgerEvent("cut:stash", `${key} n=${response.candidates.length}`);
        for (const c of response.candidates) {
          ledgerMark(c.uid, "cutStash");
          ledgerNote(c.uid, "spans", c.leafRanges.map(([a, b]) => `${a}-${b}`).join(","));
        }
        // Superseded arrivals only warm the stash (issue #315 at-rest
        // flips): a fresher fetch is in flight, and a cut walked for a
        // slightly different viewbox returns a DIFFERENT uid frontier, so
        // applying each arrival reshuffled the actives — insets visibly
        // jumped seconds after the gesture ended. Only the response for
        // the freshest requested key triggers a refresh; intermediate
        // stashes are consumed by that pass (or the next settled tick).
        if (this.cutFetchKey === key) {
          ledgerEvent("cut:ready", key);
          this.onCutReady?.();
        }
      })
      .catch(() => this.handleCutFetchFailure(key));
    return key;
  }

  /** Unreachable service / aborted: keep the last cut active (frozen-cut
   * degradation); a later settled transform retries. Shared by both lanes. */
  private handleCutFetchFailure(key: string): void {
    if (this.cutFetchKey !== key) return;
    this.cutFetchKey = undefined;
    // The freshest fetch died after an older arrival was adopted silently —
    // apply that freshest stash now so the view degrades to it instead of
    // freezing on the pre-gesture cut.
    if (this.cutStash || this.selectStash) this.onCutReady?.();
  }

  /**
   * Fire one server-SELECT request (issue #315 P7 S2, pull lane). Same
   * freshest-wins bookkeeping as the candidates lane — the frame is just an
   * answer instead of a frontier, so nothing is scored on arrival.
   */
  private fetchSelect(request: SelectCutRequest, key: string, seq: number): void {
    ledgerEvent("select:fetch", key);
    this.cutProvider!
      .selectCut!(request)
      .then((frame) => {
        if (seq <= this.cutStashSeq) {
          ledgerEvent("cut:dropOld", key);
          return;
        }
        // A superseded walk answers nothing to apply (the pull endpoint never
        // aborts; the push lane's walker does — S3); the view stays on the last
        // applied frame and the in-flight key is released.
        if (frame.aborted) {
          ledgerEvent("select:aborted", key);
          if (this.cutFetchKey === key) this.cutFetchKey = undefined;
          return;
        }
        // doiRevision coherence (P7 §1.5.3): a frame selected under an OLDER
        // revision than the last applied propagate is stale, and there is no
        // candidate stash to re-score locally — so freeze the current actives
        // and re-ask with the current echo.
        //
        // A2(i): revision 0 / absent is NOT stale — it is a server that holds no
        // DoI state (or restarted), and its frame is server truth. That is also
        // what makes the re-request terminate: server revisions only advance.
        const committed = committedDoiRevisionFn?.() ?? null;
        const revision = frame.doiRevision ?? 0;
        if (revision > 0 && committed !== null && revision < committed) {
          ledgerEvent("select:doiStale", `${key} rev=${revision} committed=${committed}`);
          if (this.cutFetchKey === key) {
            this.cutFetchKey = undefined;
            // Same key (the echo is deliberately not part of it), so the
            // re-request re-enters the fetch lane cleanly.
            this.ensureCutFetch({ ...request, select: this.buildSelectParams() });
          }
          return;
        }
        // Boot-frame duplicate on the PULL lane (issue #315 insets-at-boot
        // I1) — same rationale as adoptPushedSelect's twin branch: keep the
        // already-applied stash object, adopt only the bookkeeping, skip the
        // refresh that would re-run the O(members) first-apply for an
        // identical answer.
        if (
          this.selectStashIsBoot &&
          this.selectStash &&
          this.cutStashKey === key &&
          ClusteringService.sameSelectFrame(this.selectStash, frame)
        ) {
          this.selectStashIsBoot = false;
          this.cutStashSeq = seq;
          this.lastFrameFocusActive = frame.focusActive;
          this.lastAppliedDoiRevision = frame.doiRevision ?? undefined;
          ledgerEvent("sel:bootDup", `${key} n=${frame.actives.length}`);
          return;
        }
        this.selectStash = frame;
        this.selectStashIsBoot = false;
        this.cutStash = undefined;
        this.cutStashKey = key;
        this.cutStashSeq = seq;
        // The server owns the non-uniformity bit (§3b.4) — feed the next
        // request's focusActive from it and skip the O(dataset) scan.
        this.lastFrameFocusActive = frame.focusActive;
        this.lastAppliedDoiRevision = frame.doiRevision ?? undefined;
        ledgerEvent(
          "select:stash",
          `${key} n=${frame.actives.length} examined=${frame.examined}` +
            `${frame.clipped ? " clipped" : ""}${frame.fallbackRanking ? " fallback" : ""}`
        );
        for (const active of frame.actives) {
          ledgerMark(active.uid, "cutStash");
          ledgerNote(active.uid, "spans", active.leafRanges.map(([a, b]) => `${a}-${b}`).join(","));
        }
        if (this.cutFetchKey === key) {
          ledgerEvent("cut:ready", key);
          this.onCutReady?.();
        }
      })
      .catch(() => this.handleCutFetchFailure(key));
  }

  /** Content equality for the boot-dup check (issue #315 insets-at-boot I1):
   * same winners, same classification, same DoI state. Geometry (hull /
   * insetPos) is a deterministic function of these on a warm server and is
   * deliberately not compared. */
  private static sameSelectFrame(a: SelectFrame, b: SelectFrame): boolean {
    if (a.actives.length !== b.actives.length) return false;
    if (a.focusActive !== b.focusActive) return false;
    if ((a.doiRevision ?? 0) !== (b.doiRevision ?? 0)) return false;
    for (let i = 0; i < a.actives.length; i++) {
      const x = a.actives[i];
      const y = b.actives[i];
      if (
        x.uid !== y.uid ||
        x.group !== y.group ||
        x.rescued !== y.rescued ||
        x.reserved !== y.reserved
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Apply one server-selected frame (issue #315 P7 S2): synthesize the dozens
   * of winner nodes, carry the server's group split out to the dispatch tail,
   * and advance the echo. NO scoring, NO hysteresis, NO masked-prefix
   * classification, and no O(dataset) labels materialization — the frame IS the
   * answer (design §4.1/§4.3).
   */
  private applySelectFrame(frame: SelectFrame): ZoomUpdateResult {
    const clusters = frame.actives.map(syntheticSelectNode);
    const serverGroups = new Map<string, 0 | 1 | 2>();
    const rescuedUids: string[] = [];
    const echoMain: string[] = [];
    const echoRescue: string[] = [];
    for (const active of frame.actives) {
      serverGroups.set(active.uid, active.group);
      if (active.rescued) rescuedUids.push(active.uid);
      // Echo pools split by RESERVED — which pool won the slot (plan §3b.1).
      // Splitting by `rescued` would echo a rescue-eligible MAIN winner into the
      // reserve pool and lose its main-pool retention.
      if (active.reserved) echoRescue.push(active.uid);
      else echoMain.push(active.uid);
    }
    this.echoMain = echoMain;
    this.echoRescue = echoRescue;
    const result: ZoomUpdateResult = {
      // The zoom-cut labels array has no reader on the server path (census
      // actives-consumers Q4.2) and materializing it is O(dataset) per frame.
      labels: ClusteringService.EMPTY,
      activeClusters: clusters,
      rescuedUids,
      serverGroups,
    };
    this.lastCutResult = result;
    return result;
  }

  /**
   * Adopt one PUSHED select frame (issue #315 P7 S3) — the push twin of
   * `fetchSelect`'s .then(), landing in the same `selectStash` + `cutStashKey` /
   * `cutStashSeq` bookkeeping so `updateClusteringSemanticZoom` applies pushed
   * and pulled frames through one code path (same key-at-rest, gesture and
   * frozen-degradation rules).
   *
   * The drop rules, in order (plan A2's race matrix + A3's seq contract):
   *  1. `aborted` — a superseded walk; nothing to apply.
   *  2. `seq < cutStashSeq` — an out-of-order frame from a retired seq space.
   *  3. `seq === cutStashSeq` — a server-initiated re-select re-answers the
   *     CURRENT seq (the server cannot invent a newer one), so this is the one
   *     case where a same-seq frame must WIN: it does so only when it is a
   *     later `subOrdinal` AND carries a newer `doiRevision` than the applied
   *     frame — i.e. it is the DoI commit's answer and not a duplicate.
   *  4. `doiRevision < committed` — selected before the propagate the client has
   *     already applied; freeze and re-ask (identical to the pull lane), with
   *     revision 0/absent explicitly NOT stale (A2(i): server truth).
   * Every drop writes a ledger line.
   */
  private adoptPushedSelect(event: SelectPushEvent): void {
    if (event.aborted) {
      // The walker abandoned a superseded walk: a fresher viewport is already
      // being walked, so there is nothing to apply here.
      ledgerEvent("sel:aborted", event.key);
      return;
    }
    // Cross-FIT frames must never adopt: after a deselect the service
    // re-inits on the BASE tree while the old fitted subscription can still
    // push a late re-select whose uids belong to the fitted subset's
    // vocabulary — applied "as-is" it resurrects insets from the old
    // selection region (CS 2026-07-25 rounds 4-7). The fit tag is part of
    // the frame key ("cut:<ds>:fit=<id>:…", keyPrefix()); the current
    // provider's fit is the only admissible scope, at rest AND mid-gesture.
    const eventFit = /(?:^|:)fit=([^:]*)/.exec(event.key)?.[1] || undefined;
    if (eventFit !== (this.cutProvider?.fit ?? undefined)) {
      ledgerEvent("sel:dropFitScope", `${event.key} fit=${eventFit ?? "base"}`);
      return;
    }
    if (event.seq < this.cutStashSeq) {
      ledgerEvent("sel:dropOld", `${event.key} seq=${event.seq}`);
      return;
    }
    const revision = event.doiRevision ?? 0;
    if (event.seq === this.cutStashSeq) {
      const applied = this.lastAppliedDoiRevision ?? 0;
      // A newer push with a DIFFERENT revision is adoptable — that includes
      // revision 0 after a DoI CLEAR (A2(i): server truth; requiring a
      // strictly newer revision silently dropped the corrected clustering
      // after every deselect — CS 2026-07-25). Equal revision = duplicate.
      if (!(event.subOrdinal > this.lastAppliedSubOrdinal && revision !== applied)) {
        ledgerEvent(
          "sel:dropSameSeq",
          `${event.key} seq=${event.seq} sub=${event.subOrdinal}/${this.lastAppliedSubOrdinal}` +
            ` rev=${revision}/${applied}`
        );
        return;
      }
      ledgerEvent(
        "sel:reselect",
        `${event.key} ${event.reselect ?? "?"} rev=${revision} sub=${event.subOrdinal}`
      );
    }
    const committed = committedDoiRevisionFn?.() ?? null;
    if (revision > 0 && committed !== null && revision < committed) {
      ledgerEvent("sel:doiStale", `${event.key} rev=${revision} committed=${committed}`);
      // Re-ask the SAME question with the current echo (same key). Terminates
      // because server revisions only advance — and the A3 commit push usually
      // beats this anyway.
      const again = this.rebuildSelectRequest(event.key);
      if (again && this.cutFetchKey === event.key) {
        this.cutFetchKey = undefined;
        this.ensureCutFetch(again);
      }
      return;
    }
    // Boot-frame duplicate (issue #315 insets-at-boot I1): the registration
    // push re-asks the question the warm frame already answered; a warm server
    // re-pushes an identical frame. Adopt the seq/ordinal bookkeeping but keep
    // the ALREADY-APPLIED stash object and skip the refresh — re-applying an
    // identical frame would re-run the O(members) first-apply work (the group /
    // digest caches key on node identity) for zero visual change.
    if (
      this.selectStashIsBoot &&
      this.selectStash &&
      this.cutStashKey === event.key &&
      ClusteringService.sameSelectFrame(this.selectStash, event)
    ) {
      this.selectStashIsBoot = false;
      this.cutStashSeq = event.seq;
      this.lastAppliedSubOrdinal = event.subOrdinal;
      this.lastFrameFocusActive = event.focusActive;
      this.lastAppliedDoiRevision = event.doiRevision ?? undefined;
      ledgerEvent("sel:bootDup", `${event.key} n=${event.actives.length}`);
      return;
    }
    this.selectStash = event;
    this.selectStashIsBoot = false;
    this.cutStash = undefined;
    this.cutStashKey = event.key;
    this.cutStashSeq = event.seq;
    this.lastAppliedSubOrdinal = event.subOrdinal;
    this.lastFrameFocusActive = event.focusActive;
    this.lastAppliedDoiRevision = event.doiRevision ?? undefined;
    const sms = event.serverMs;
    ledgerEvent(
      "select:stash",
      `${event.key} n=${event.actives.length} pushed examined=${event.examined}` +
        `${event.clipped ? " clipped" : ""}${event.fallbackRanking ? " fallback" : ""}` +
        `${sms ? ` srv=${sms.wait ?? 0}/${sms.walk ?? 0}/${sms.score ?? 0}` : ""}`
    );
    for (const active of event.actives) {
      ledgerMark(active.uid, "cutStash");
      ledgerNote(active.uid, "spans", active.leafRanges.map(([a, b]) => `${a}-${b}`).join(","));
    }
    // A pushed answer for the in-flight key refreshes exactly like a pulled one.
    // A server-initiated re-select has NO in-flight key (the request that asked
    // for it settled long ago) and must still refresh — that unrequested
    // refresh IS A3: lasso → recolor + new actives as one client-visible event.
    if (this.cutFetchKey === event.key) {
      ledgerEvent("cut:ready", event.key);
      this.onCutReady?.();
    } else if (event.reselect) {
      ledgerEvent("sel:readyUnrequested", event.key);
      this.onCutReady?.();
    }
  }

  /**
   * Adopt one registration-ACK (issue #315 insets-at-boot I3b): the server
   * registered this subscription's boot re-ask — arming A3 reselects and
   * content memory — without re-pushing the identical frame. Adopt exactly
   * the bookkeeping the skipped push would have carried (`sel:bootDup`'s
   * seq adoption) and consume the boot one-shot, so a LATER identical push
   * refreshes normally. The `sel:bootDup` suppression stays in place as the
   * fallback for older servers, which answer the re-ask with a full frame.
   */
  private adoptSelectAck(event: SelectAckEvent): void {
    // Same fit-scope gate as adoptPushedSelect: a cross-fit ack must never
    // touch live bookkeeping.
    const eventFit = /(?:^|:)fit=([^:]*)/.exec(event.key)?.[1] || undefined;
    if (eventFit !== (this.cutProvider?.fit ?? undefined)) {
      ledgerEvent("sel:ackDropFitScope", event.key);
      return;
    }
    // Only the boot registration is ever acked; anything else is stale.
    if (
      !this.selectStashIsBoot ||
      !this.selectStash ||
      this.cutStashKey !== event.key
    ) {
      ledgerEvent("sel:ackIgnored", event.key);
      return;
    }
    this.selectStashIsBoot = false;
    this.cutStashSeq = event.seq;
    // The subscription's ordinal did not advance (nothing was pushed);
    // lastAppliedSubOrdinal stays put so the next real push — including a
    // same-seq server re-select — orders normally.
    if (this.cutFetchKey === event.key) this.cutFetchKey = undefined;
    ledgerEvent("sel:bootAck", event.key);
  }

  /** The select question for `key`, rebuilt with a FRESH echo (issue #315 P7
   * S3): a PUSHED frame carries no request object to clone, and rebuilding from
   * the live viewport could change the key. Only the echo moved, and the echo is
   * deliberately not part of the key (§6.2). Undefined when the last issued
   * request no longer addresses `key` — then there is nothing to re-ask. */
  private rebuildSelectRequest(key: string): SelectCutRequest | undefined {
    const previous = this.lastSelectRequest;
    if (!previous || this.cutProvider!.cutKey(previous) !== key) return undefined;
    return { ...previous, select: this.buildSelectParams(previous.select.settled) };
  }

  /** Adopt one pushed subscription frame (issue #315 Plan H) — the push
   * twin of the getCut .then() above, with identical freshest-wins and
   * refresh-only-on-freshest-key semantics. `seq` echoes the viewport push
   * that produced the frame, so the existing counters carry over unchanged
   * (and stay coherent across a mid-session fallback to pull).
   *
   * Frames are cumulative deltas (H1), so an unapplicable one cannot just
   * be skipped like a superseded pull response: it invalidates the mirror,
   * and the next push asks the server for a full frame. */
  private adoptPushedCut(event: CutPushEvent): void {
    if (event.seq <= this.cutStashSeq) {
      // Out-of-order/stale. Frames arrive in order on one stream, so this
      // means the seq space moved under us (a pull interleaved, or a
      // reconnect) — the mirror can no longer be trusted for deltas.
      ledgerEvent("cut:dropOld", event.key);
      if (!event.reset) this.cutMirrorValid = false;
      return;
    }
    if (event.reset) {
      this.cutMirror = new Map(event.enter.map((c) => [c.uid, c]));
      this.cutMirrorValid = true;
    } else {
      if (!this.cutMirrorValid) {
        // A delta with nothing to apply it to: ask for a reset instead of
        // rendering a partial frontier.
        ledgerEvent("cut:deltaNoMirror", event.key);
        return;
      }
      for (const uid of event.leave) this.cutMirror.delete(uid);
      for (const c of event.enter) this.cutMirror.set(c.uid, c);
      for (const [uid, x, y] of event.move ?? []) {
        const existing = this.cutMirror.get(uid);
        // A patch for a uid we do not hold means the mirror diverged from
        // the server's frontier — rebuild rather than silently drop it.
        if (!existing) {
          this.cutMirrorValid = false;
          ledgerEvent("cut:moveMiss", uid);
          return;
        }
        this.cutMirror.set(uid, { ...existing, insetPos: [x, y] });
      }
    }
    // Stamp expiry (issue #315 A3 / P-d, §6e). The server only re-ships a
    // candidate whose STABLE part changed (`stats_server._stable_part` =
    // size/stability/bbox/leafRanges/hull) — `doiMass` is NOT in it. So when a
    // new DoI revision lands at an unchanged viewport, every candidate the
    // mirror carried over still holds the PREVIOUS revision's mass, and the
    // scorer would rank newly-hot clusters as cold. Wipe those stamps (the
    // frame's own `enter` candidates were stamped under this revision and keep
    // theirs) so clusterDoiMassFromPrefix / saliencyScorer fall through to the
    // exact client-side computation. O(carried candidates), and only on a
    // revision change: same-revision deltas keep the O(1) stamped path intact.
    // An undefined revision (no server DoI state / older server) is treated as
    // its own value — a transition to or from it expires stamps too.
    if (event.doiRevision !== this.lastAppliedDoiRevision) {
      if (!event.reset) {
        const fresh = new Set(event.enter.map((c) => c.uid));
        for (const [uid, candidate] of this.cutMirror) {
          if (candidate.doiMass === undefined || fresh.has(uid)) continue;
          this.cutMirror.set(uid, { ...candidate, doiMass: undefined });
        }
      }
      this.lastAppliedDoiRevision = event.doiRevision;
    }
    const frontier = [...this.cutMirror.values()];
    this.cutStash = frontier.map(syntheticCutNode);
    this.cutStashKey = event.key;
    this.cutStashSeq = event.seq;
    // Push twin of the pull path: adopt the frame's server-stamped focus_active
    // (§6e) so buildCutRequest skips the O(dataset) uniformity scan.
    if (event.focus_active !== undefined) {
      this.lastFrameFocusActive = event.focus_active;
    }
    const sms = event.serverMs;
    ledgerEvent(
      "cut:stash",
      `${event.key} n=${frontier.length} pushed${event.reset ? " reset" : ""}${
        sms ? ` srv=${sms.wait}/${sms.walk}/${sms.emit}` : ""
      }`
    );
    for (const c of event.enter) {
      ledgerMark(c.uid, "cutStash");
      ledgerNote(c.uid, "spans", c.leafRanges.map(([a, b]) => `${a}-${b}`).join(","));
    }
    if (this.cutFetchKey === event.key) {
      ledgerEvent("cut:ready", event.key);
      this.onCutReady?.();
    }
  }

  /**
   * Gesture prefetch (issue #315): fire the cut fetch for the current
   * viewport WITHOUT running scoring/dispatch — mid-gesture ticks call this
   * so the stash is warm when the gesture settles and the single at-rest
   * pass applies instantly. The compositor shows a cached frame during the
   * gesture anyway, so pipeline application mid-gesture had no visible
   * benefit — only the annotation-layer churn CS measured as stutter.
   */
  public prefetchCut(viewbox: Viewbox, canvasWidthPx: number, canvasHeightPx: number): void {
    if (!this.cutProvider || !viewbox) return;
    const selectionActive = this.nodes.length > 0 && this.nodes.length < this.allNodes.length;
    this.ensureCutFetch(this.buildCutRequest(viewbox, canvasWidthPx, canvasHeightPx, selectionActive));
  }

  public rehydrateHierarchy(
    tree: ClusterTreeNode,
    data: number[][],
    nodes: DataPoint[],
    allNodes?: DataPoint[]
  ): void {
    this.nodes = nodes;
    this.allNodes = allNodes ?? nodes;
    this.hdbscan.hierarchyTree = tree;

    const root = this.hdbscan.getHierarchyTree();
    this.root = root ?? null;

    if (root) {
      this.computeLeafPad(data);
      if (!root.bbox) this.assignBBoxes(root, data);
      this.patchLeafBBoxes(root, data);
      this.clusterIndex.clear();
      this.indexAllNodes(root);
      this.createParentMap();

      // Euler tour timestamps
      this.tin.clear();
      this.tout.clear();
      this.timeCounter = 0;
      const dfs = (n: ClusterTreeNode) => {
        this.tin.set(n.id, this.timeCounter++);
        if (n.leftChild) dfs(n.leftChild);
        if (n.rightChild) dfs(n.rightChild);
        this.tout.set(n.id, this.timeCounter++);
      };
      dfs(root);
    }

    // Spatial indexes — invalidated here, built lazily on first use.
    this.groupPointIndexReady = false;
    this.allPointIndexReady = false;

    // Buffers + caches
    this.labelsBuffer = new Int32Array(data.length);
    this.labelGen = new Int32Array(data.length);
    this.currentGen = 0;
    this.lastZoomCutSig = undefined;
    this.lastZoomCutLabels = undefined;

    this.lastLabels = [];
    this.lastActiveClusters = [];

    // Hierarchy revision bump
    this.hierarchyRev++;
    this.lastSig = undefined;

    // Reset semantic-zoom hysteresis so stale UIDs don't carry over.
    this.semanticZoomService.reset();
    this.resetSelectEcho();

    // A rehydrate re-decides static boot-frame eligibility (issue #315 I3):
    // the caller re-arms explicitly when the new tree is the shipped one.
    this.staticBootArmed = false;
  }

  /**
   * Arm the static boot-frame gate (issue #315 insets-at-boot I3). Client
   * lane only, and only after rehydrating the dataset's SHIPPED hierarchy —
   * the artifact's uids/leaf ranges are that tree's vocabulary. The first
   * zoom pass consumes the gate (see updateClusteringSemanticZoom).
   */
  public enableStaticBootFrame(): void {
    if (this.cutProvider) return;
    this.staticBootArmed = true;
  }

  private buildParentMap(node: ClusterTreeNode, parent: ClusterTreeNode | null): void {
    this.parentMap.set(node.id, parent);
    if (node.leftChild) this.buildParentMap(node.leftChild, node);
    if (node.rightChild) this.buildParentMap(node.rightChild, node);
  }

  public createParentMap(): void {
    this.parentMap.clear();
    const root = this.hdbscan.getHierarchyTree();
    if (!root) {
      throw new Error("Hierarchy tree not available. Call computeClustering or rehydrateHierarchy first.");
    }
    this.buildParentMap(root, null);
  }

  /** O(1) ancestry test using Euler tin/tout. */
  private isDescendant(a: ClusterTreeNode, b: ClusterTreeNode): boolean {
    const ta = this.tin.get(a.id)!;
    const tb = this.tin.get(b.id)!;
    const oa = this.tout.get(a.id)!;
    const ob = this.tout.get(b.id)!;
    return tb <= ta && oa <= ob;
  }

  private quantize(v: number) {
    return Math.round(v * 1e3) / 1e3;
  }

  private makeSig(
    viewbox?: { minX: number; minY: number; maxX: number; maxY: number }
  ): string {
    const { sizeThreshold, maxSizeThreshold, maxActiveClusters, useGlobalCountingNodes } =
      store.getState().clusterSettings;

    const vb = viewbox
      ? `${this.quantize(viewbox.minX)},${this.quantize(viewbox.minY)},${this.quantize(
          viewbox.maxX
        )},${this.quantize(viewbox.maxY)}`
      : "∅";

    return [
      `vb=${vb}`,
      `n=${maxActiveClusters}`,
      `minF=${sizeThreshold}`,
      `maxF=${maxSizeThreshold}`,
      `hrev=${this.hierarchyRev}`,
      `gcn=${useGlobalCountingNodes ? 1 : 0}`,
    ].join("|");
  }

  private countPointsInView(
    viewbox?: { minX: number; minY: number; maxX: number; maxY: number }
  ): number {
    // Read the toggle at call-time so it always reflects the current store state.
    const useGlobal = store.getState().clusterSettings.useGlobalCountingNodes;
    if (!viewbox) return useGlobal ? this.allNodes.length : this.nodes.length;

    // Include the flag in the cache key so a toggle with identical viewbox still misses.
    const gcn = useGlobal ? 1 : 0;
    const key = `${gcn}|${Math.round(viewbox.minX * 1e3)}|${Math.round(
      viewbox.minY * 1e3
    )}|${Math.round(viewbox.maxX * 1e3)}|${Math.round(viewbox.maxY * 1e3)}`;
    if (this.lastViewCountSig === key) return this.lastViewCount;

    const idx = useGlobal ? this.ensureAllPointIndex() : this.ensureGroupPointIndex();
    const count = idx.search(viewbox).length;
    this.lastViewCountSig = key;
    this.lastViewCount = count;
    return count;
  }

  private fullyInside(
    node: ClusterTreeNode,
    viewbox: { minX: number; minY: number; maxX: number; maxY: number }
  ): boolean {
    const b = node.bbox!;
    return (
      b.minX >= viewbox.minX - EPS &&
      b.maxX <= viewbox.maxX + EPS &&
      b.minY >= viewbox.minY - EPS &&
      b.maxY <= viewbox.maxY + EPS
    );
  }

  private getTopNClusters(
    _root: ClusterTreeNode,
    viewbox: { minX: number; minY: number; maxX: number; maxY: number } | undefined,
    n: number
  ): ClusterTreeNode[] {
    // Spatial candidate set
    let candidates: ClusterTreeNode[];
    if (!viewbox) {
      candidates = this.clusterIndex.all().map((e) => e.node);
    } else {
      candidates = this.clusterIndex
        .search(viewbox)
        .map((e) => e.node)
        .filter((node) => node.bbox !== undefined && this.fullyInside(node, viewbox));
    }

    // Size thresholds relative to points in view
    const { sizeThreshold: minFraction, maxSizeThreshold: maxFraction } =
      store.getState().clusterSettings;

    const pointsInViewbox = this.countPointsInView(viewbox);
    const minSizeThreshold = minFraction * pointsInViewbox;
    const maxSizeThreshold = maxFraction * pointsInViewbox;

    // Use node.size (O(1)) instead of materialized children (which may be absent).
    // Single-point clusters (size === 1) are always exempt from maxSizeThreshold:
    // at full zoom-in they represent individual points and must remain eligible
    // regardless of the user's upper-bound setting.
    const filtered = candidates.filter(
      (a) => a.size >= minSizeThreshold && (a.size === 1 || a.size <= maxSizeThreshold)
    );

    // Safe fast-path: when leaves are few and dominate stability
    const leaves = filtered.filter((c) => !c.leftChild && !c.rightChild);
    if (leaves.length <= n) {
      const minLeafStab =
        leaves.length > 0 ? leaves.reduce((m, c) => Math.min(m, c.stability), Infinity) : -Infinity;
      const maxAncestorStab = filtered
        .filter((c) => c.leftChild || c.rightChild)
        .reduce((m, c) => Math.max(m, c.stability), -Infinity);
      if (maxAncestorStab <= minLeafStab) {
        return leaves;
      }
    }

    // General selector: heap pop by stability, resolve nesting greedily
    const heap = new MaxHeap<ClusterTreeNode>((a, b) => a.stability - b.stability);
    heap.build(filtered); // O(k)

    const selected: ClusterTreeNode[] = [];
    while (!heap.empty() && selected.length < n) {
      const c = heap.pop()!;
      let conflict = false;
      for (const s of selected) {
        if (this.isDescendant(c, s) || this.isDescendant(s, c)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) selected.push(c);
    }
    return selected;
  }

  public updateClusteringForZoom(
    _relativeThreshold: number,
    viewbox?: { minX: number; minY: number; maxX: number; maxY: number }
  ): ZoomUpdateResult {
    const sig = this.makeSig(viewbox);
    if (this.lastLabels.length > 0 && this.lastSig === sig) {
      return { labels: this.lastLabels, activeClusters: this.lastActiveClusters };
    }

    const root = this.hdbscan.getHierarchyTree();
    if (!root) throw new Error("Hierarchy tree not available. Call computeClustering first.");

    const maxClusters = store.getState().clusterSettings.maxActiveClusters;
    const clusters = this.getTopNClusters(root, viewbox, maxClusters);

    // Generation-stamped labels write
    this.currentGen++;
    for (const cluster of clusters) {
      const members = this.membersOf(cluster);
      for (const idx of members) {
        this.labelsBuffer[idx] = cluster.id;
        this.labelGen[idx] = this.currentGen;
      }
    }

    const labels = Array.from(this.labelsBuffer, (lab, i) =>
      this.labelGen[i] === this.currentGen ? lab : -1
    );

    this.lastLabels = labels;
    this.lastActiveClusters = clusters;
    this.lastSig = sig;

    return { labels, activeClusters: clusters };
  }

  public getClusteringState(relativeThreshold: number) {
    return this.hdbscan.getClusteringState(relativeThreshold);
  }

  public getHierarchyTree(): ClusterTreeNode | null {
    return this.hdbscan.getHierarchyTree();
  }

  public getNodes(): DataPoint[] {
    return this.nodes;
  }

  /** True when a server-side cut provider drives this service (issue #315):
   * the zoom pass is then cheap enough to run per mid-pan settled tick. */
  public get serverCutMode(): boolean {
    return this.cutProvider !== null;
  }

  // ---------------------------------------------------------------------------
  // Semantic-zoom pipeline (replaces relative-count threshold approach)
  // ---------------------------------------------------------------------------

  /**
   * Local whitespace fraction around a cluster node, for chain rescue
   * (see saliencyScorer.RESCUE_WHITESPACE_MIN).
   *
   * Probes the group point index with the node's data-space bbox inflated 3×
   * per axis around its center, floored at 2.5% of the viewbox extent so
   * near-degenerate bboxes (tight 2–3-point clusters) still probe a
   * screen-meaningful neighborhood. Members always lie inside the probe
   * window, so foreign count = window count − member count without needing
   * point identity in the index.
   */
  private localWhitespaceOf(node: ClusterTreeNode, viewbox: Viewbox | undefined): number {
    if (!node.bbox) return 0;
    const memberCount = this.membersOf(node).length;
    if (memberCount === 0) return 0;

    const b = node.bbox;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const floorX = viewbox ? (viewbox.maxX - viewbox.minX) * 0.025 : this.leafPadX;
    const floorY = viewbox ? Math.abs(viewbox.maxY - viewbox.minY) * 0.025 : this.leafPadY;
    const halfW = Math.max(((b.maxX - b.minX) / 2) * 3, floorX);
    const halfH = Math.max(((b.maxY - b.minY) / 2) * 3, floorY);

    const windowCount = this.ensureGroupPointIndex().search({
      minX: cx - halfW,
      minY: cy - halfH,
      maxX: cx + halfW,
      maxY: cy + halfH,
    }).length;
    const foreign = Math.max(0, windowCount - memberCount);
    return memberCount / (memberCount + foreign);
  }

  /**
   * Trajectory through-flow test for singleton chain rescue (issue #258
   * phase C): true iff the node's single member has BOTH a predecessor and a
   * successor on its trajectory and both are in the clustered (selected)
   * subset. A stark-transition point on a selected bundle A→B→C qualifies;
   * a lasso-straggler (unselected trajectory neighbors) and trajectory
   * endpoints do not — deliberate strictness against annotating
   * uninteresting stray points.
   *
   * The pred/succ arrays MUST be built over `allNodes` (the full dataset,
   * WeakMap-cached in getPropagationPrecomputation): building them over the
   * DoI-filtered subset would stitch points together across the very gaps
   * this test is meant to detect. Membership is the `doiGroup` flag — the
   * filtered subset aliases the same DataPoint objects.
   */
  private trajectoryThroughFlowOf(node: ClusterTreeNode): boolean {
    const members = this.membersOf(node);
    if (members.length !== 1) return false;
    const point = this.nodes[members[0]];
    if (!point) return false;

    const { indexById, predIndex, succIndex } = getPropagationPrecomputation(this.allNodes);
    const idx = indexById.get(point.id);
    if (idx === undefined) return false;

    const inSubset = (i: number): boolean => {
      if (i < 0) return false;
      const node = this.allNodes[i];
      if (!node) return false;
      // Server-baked DoI (issue #315 P7 S5): no per-node string is written on
      // the provider path, so the same band test is evaluated from the adopted
      // f32 column. Unreachable in server-SELECT mode (the frame is the answer
      // and this scorer never runs), but a provider that propagates DoI
      // WITHOUT the select capability still walks the candidates lane here.
      const g = doiGroupOfPoint(node) ?? node.doiGroup;
      return g === "annotation" || g === "inset";
    };
    return inSubset(predIndex[idx]) && inSubset(succIndex[idx]);
  }

  /**
   * Compute the active cluster set for the current viewport using the
   * footprint-driven semantic-zoom pipeline.
   *
   * This replaces the relative-count threshold approach in `updateClusteringForZoom`
   * for interactive zoom/pan frames.  Uses pixel area of each cluster's bounding
   * box (data-space bbox projected through D3 scales) to decide:
   *   1. Where to cut the HDBSCAN hierarchy (zoom cut)
   *   2. Which nodes are eligible for labeling (labelMinFraction × viewport area)
   *   3. How to rank and select up to maxActiveClusters (saliency score)
   *   4. Hysteresis to suppress flicker on small zoom/pan changes
   *
   * @param viewbox       Data-space viewport bounding box.
   * @param xScale        Current D3 x-scale (data → canvas pixels).
   * @param yScale        Current D3 y-scale (data → canvas pixels).
   * @param canvasWidthPx Canvas width in pixels.
   * @param canvasHeightPx Canvas height in pixels.
   */
  public updateClusteringSemanticZoom(
    viewbox: Viewbox | undefined,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    canvasWidthPx: number,
    canvasHeightPx: number,
    /** Server-cut mode: whether a stale-key stash may be scored against the
     * current viewbox (issue #315 round 4). TRUE during gestures — actives
     * track the viewport at tick cadence. FALSE at rest: scoring the stale
     * frontier and then swapping to the exact one ~0.5 s later read as
     * insets flipping with no input; keep the current actives and let the
     * exact arrival's onCutReady refresh apply once. */
    allowStaleCut = true
  ): ZoomUpdateResult {
    const root = this.hdbscan.getHierarchyTree() ?? (this.cutProvider ? this.root : null);
    if (!root) throw new Error("Hierarchy tree not available. Call computeClustering first.");

    // Static boot frame (issue #315 insets-at-boot I3, CLIENT lane): the
    // FIRST zoom pass applies the prep-time artifact instead of the first
    // local scoring result — winners, groups, hulls and inset seeds arrive
    // ready-made through the same applySelectFrame tail the server lane
    // runs. One-shot both ways: the gate disarms on this pass regardless of
    // whether the artifact arrived (degrade, never block), and onCutReady
    // schedules the genuine local pass, which supersedes unconditionally
    // (the frame is seq-0/pre-scoring; client hysteresis stays untouched,
    // so the local pass selects exactly as an artifact-less boot would).
    if (this.staticBootArmed) {
      this.staticBootArmed = false;
      const artifact = takeStaticBootFrame(this.allNodes);
      if (artifact && artifact.frame.actives.length > 0) {
        ledgerEvent("sel:staticBoot", `n=${artifact.frame.actives.length}`);
        const result = this.applySelectFrame(artifact.frame);
        this.onCutReady?.();
        return result;
      }
    }

    const settings = store.getState().clusterSettings;
    // The split threshold is stored as a fraction of the view area and
    // resolved against the live canvas size here.  Canvas dimensions are part
    // of the SemanticZoomService cache signature, so a resize re-resolves the
    // threshold and refreshes the cut automatically.
    const config: SemanticZoomConfig = {
      splitThresholdPx: resolveSplitThresholdPx(
        settings.splitThresholdFraction,
        canvasWidthPx,
        canvasHeightPx
      ),
      labelMinFraction:          settings.labelMinFraction,
      stabilityWeight:           settings.stabilityWeight,
      doiMassWeight:             settings.doiMassWeight,
      footprintWeight:           settings.footprintWeight,
      doiDensityWeight:          settings.doiDensityWeight,
      chainDoiThreshold:         settings.chainDoiThreshold,
      gapDisclosurePx:           settings.gapDisclosurePx,
      chainRescueBudget:         settings.chainRescueBudget,
      hysteresisActivateFactor:  settings.hysteresisActivateFactor,
      hysteresisDeactivateFactor: settings.hysteresisDeactivateFactor,
    };

    // A selection / focus is active exactly when this hierarchy was built
    // from a DoI-filtered subset of the dataset (runHdbscanClustering only
    // feeds annotation/inset-group points to HDBSCAN).  No selection — or a
    // select-all feature search — clusters all points and keeps the flag
    // false, so gap disclosure and rescue stay inert.  unlabeledOnlyMode also
    // filters and thus counts as focus — intended.
    const selectionActive = this.nodes.length > 0 && this.nodes.length < this.allNodes.length;

    // Server-cut mode (issue #315 S2b): resolve the stashed frontier for the
    // current inputs, or fire the fetch and keep the previous result active
    // until it lands (the resolved fetch triggers one refresh via onCutReady).
    let precomputedCut: { cut: ClusterTreeNode[]; rev: string } | undefined;
    if (this.cutProvider) {
      if (!viewbox) {
        return this.lastCutResult ?? this.emptyCutResult();
      }
      const request = this.buildCutRequest(viewbox, canvasWidthPx, canvasHeightPx, selectionActive);
      const key = this.ensureCutFetch(request);
      // Server-select mode (issue #315 P7 S2): the frame is the answer — apply
      // it and return. Everything below (hybrid cut, scoring, hysteresis,
      // labels) is the candidates lane and is skipped entirely.
      if ("select" in request) {
        const stash = this.selectStash;
        if (!stash) {
          // Nothing has ever landed — frozen degradation until it does.
          return this.lastCutResult ?? this.emptyCutResult();
        }
        if (this.cutStashKey !== key) {
          if (!allowStaleCut && this.lastCutResult) {
            // At rest: keep the current actives until the exact frame lands —
            // one transition instead of an A-then-B flip.
            ledgerEvent("select:staleSuppressed", this.cutStashKey);
            return this.lastCutResult;
          }
          // Mid-gesture: display the freshest ARRIVED answer. Unlike the
          // candidates lane there is no re-scoring against the current viewbox
          // (P7 §1.5.5 retires that path) — the actives simply transform with
          // the canvas until the exact frame arrives.
          ledgerEvent("select:staleFrame", this.cutStashKey);
        }
        return this.applySelectFrame(stash);
      }
      if (this.cutStashKey !== key) {
        if (!this.cutStash) {
          // Nothing has ever landed — frozen-cut degradation until it does.
          return this.lastCutResult ?? this.emptyCutResult();
        }
        if (!allowStaleCut && this.lastCutResult) {
          // At rest: keep the current actives until the exact cut lands —
          // one transition instead of an A-then-B flip (see the parameter
          // doc above).
          ledgerEvent("cut:staleSuppressed", this.cutStashKey);
          return this.lastCutResult;
        }
        // Stale-key stash: score the freshest arrived frontier against the
        // CURRENT viewbox while the exact fetch is in flight. The scorer's
        // fully-inside filter drops candidates that left the view, so actives
        // track the viewport at settled-tick cadence instead of lagging a
        // full gesture behind.
        ledgerEvent("cut:staleKeyScore", this.cutStashKey);
        precomputedCut = { cut: this.cutStash, rev: this.cutStashKey! };
      } else {
        precomputedCut = { cut: this.cutStash!, rev: key };
      }
    }

    const smResult = this.semanticZoomService.computeActiveClusterIds(
      root,
      viewbox,
      xScale,
      yScale,
      canvasWidthPx,
      canvasHeightPx,
      this.membersOf.bind(this),
      this.nodes,
      settings.maxActiveClusters,
      config,
      this.hierarchyRev,
      (node) => this.localWhitespaceOf(node, viewbox),
      selectionActive,
      (node) => this.trajectoryThroughFlowOf(node),
      precomputedCut,
      (node) => this.clusterDoiMassFromPrefix(node)
    );

    const clusters = smResult.activeCandidates.map((c) => c.node);

    // Write generation-stamped labels from the FULL containment cut so that
    // every visible point belongs to a cluster (no "-1" gaps in point coloring).
    // Gated on the zoom-cut signature (issue #315 phase C1): the write loop +
    // the Array.from materialization are O(n) — a fresh 1M-element JS array
    // per settled tick was measured GC-hot — and their output only changes
    // when the cut does. Callers treat the labels array as read-only.
    const zoomCutSig = smResult.zoomCut.map((c) => c.uid).join(",");
    let labels: number[];
    if (this.lastZoomCutSig === zoomCutSig && this.lastZoomCutLabels) {
      labels = this.lastZoomCutLabels;
    } else {
      this.currentGen++;
      const order = this.root?._leafOrder;
      for (const cluster of smResult.zoomCut) {
        // Range nodes: walk the leaf order in place — membersOf's slice
        // allocated ~points-in-viewport ints per cut change, which now
        // happens per mid-gesture arrival (issue #315 stuck-actives).
        if (
          order &&
          !Array.isArray(cluster.children) &&
          cluster.leafIndex == null &&
          cluster.firstLeaf != null &&
          cluster.lastLeaf != null
        ) {
          for (let li = cluster.firstLeaf; li < cluster.lastLeaf; li++) {
            const idx = order[li];
            if (idx >= 0 && idx < this.labelsBuffer.length) {
              this.labelsBuffer[idx] = cluster.id;
              this.labelGen[idx] = this.currentGen;
            }
          }
          continue;
        }
        const members = this.membersOf(cluster);
        for (const idx of members) {
          if (idx >= 0 && idx < this.labelsBuffer.length) {
            this.labelsBuffer[idx] = cluster.id;
            this.labelGen[idx] = this.currentGen;
          }
        }
      }
      labels = Array.from(this.labelsBuffer, (lab, i) =>
        this.labelGen[i] === this.currentGen ? lab : -1
      );
      this.lastZoomCutSig = zoomCutSig;
      this.lastZoomCutLabels = labels;
    }

    // Which actives came in via the chain-rescue reserve (for the settings
    // readout).  Derived here because the `rescued` flag lives on the
    // ScoredCandidates and is not part of the ClusterTreeNode shape.
    const rescuedUids = smResult.activeCandidates
      .filter((c) => c.rescued)
      .map((c) => c.node.uid);

    const result = { labels, activeClusters: clusters, rescuedUids };
    if (this.cutProvider) this.lastCutResult = result;
    return result;
  }

  /** No-cut-yet placeholder (server-cut mode before the first response). */
  private emptyCutResult(): ZoomUpdateResult {
    return {
      labels: new Array<number>(this.nodes.length).fill(-1),
      activeClusters: [],
      rescuedUids: [],
    };
  }

  /**
   * Expose the SemanticZoomService for external reset (e.g., after full
   * recluster triggered by lasso or selection change).
   */
  public resetSemanticZoom(): void {
    this.semanticZoomService.reset();
    this.resetSelectEcho();
  }
}

export default ClusteringService;
