// packages/app/src/hooks/cutDrivenGroups.ts
//
// Cut-driven cluster grouping (issue #315 phase C1). Active clusters are
// contiguous leaf-order ranges — the clustering service resolves any
// cluster's member indices in O(members). Building groups from those
// ranges replaces the per-tick viewport re-derivation
// (rTree.search → map → filter → groupBy over every visible point), which
// was the measured interaction ceiling at 1M.
//
// Semantics vs the legacy scan (flagged in plan-315-c-interactivity.md):
// groups now contain a cluster's FULL membership, not just the
// viewport-visible portion — hulls of boundary clusters may extend past
// the view edge. The per-point doiGroup gate is preserved exactly.
//
// Member arrays are cached per cluster NODE keyed by a content version (the
// clustering version counters — every pipeline that mutates doiGroup /
// clusterId dispatches through them): unchanged clusters across cut changes
// reuse the SAME array instance, so reconcile's pairwise fast path fires,
// digests are skipped, and the per-bump GC churn (measured 20% of
// interaction CPU at 1M) drops to changed clusters only.

import { createEmptyDataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { DataPoint, TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "src/clustering/ExtendedHDBSCAN";
import { areRowsResident, isLazyRowArray, rowAt } from "src/dataPreprocessing/lazyRows";
import { doiGroupOf, doiGroupOfPoint, isDoiBaked } from "src/doiPropagation/bakedDoi";
import { registerGroupClusterUid } from "src/clustering/groupClusterUid";
import { registerGroupMembers } from "src/clustering/groupMembers";
import { getMidpointClusteringContext, getNodeClusteringContext } from "src/clustering/hdbscanClustering";
import { registerActionMajorityContext } from "src/utils/actionMajority";
import type { GroupsMap } from "./reconcileClusterItems";

const nodeGroupCache = new WeakMap<
  ClusterTreeNode,
  { v: number; g: string; arr: DataPoint[] }
>();
const midpointGroupCache = new WeakMap<
  ClusterTreeNode,
  { v: number; arr: TrajectoryMidpoint[] }
>();

/**
 * Groups for the given active clusters from their leaf ranges, or null when
 * the persistent clustering doesn't match `hierarchyId` (swap in flight —
 * caller falls back to the legacy viewport groupBy). `contentVersion` must
 * change whenever per-point doiGroup assignments can have changed (the
 * caller combines the clustering version counters).
 */
export interface CutDrivenGroups {
  groups: GroupsMap;
  /** O(1) prefix centroids, present only for clusters whose group is the
   * UNFILTERED full membership (the doiGroup gate kept every member) —
   * exactness: a filtered group's centroid must come from its own points. */
  centers: Map<string, { x: number; y: number }>;
}

/**
 * Range marker + columnar-majority context for a FULL-membership group
 * (issue #315): the array is exactly the cluster's leaf range — backend
 * inset requests ship the range instead of O(members) refs, reconcile
 * digests by range signature, and the overlay label resolves straight from
 * the sidecar action column. A filtered subset must NOT carry the marker
 * (the range would over-cover).
 */
function attachFullMembershipMarkers(
  pts: DataPoint[],
  cluster: ClusterTreeNode,
  ctx: NonNullable<ReturnType<typeof getNodeClusteringContext>>
): void {
  if (cluster.firstLeaf == null || cluster.lastLeaf == null) return;
  Object.defineProperty(pts, "__leafRange", {
    value: {
      tree: "points",
      ranges: [[cluster.firstLeaf, cluster.lastLeaf]],
      fit: ctx.service.serverCutFit,
      // Range digests (reconcile) must never equate ranges from two
      // different hierarchies — leaf positions renumber on recluster.
      hierarchyId: ctx.hierarchyId,
    },
    enumerable: false,
    configurable: true,
  });
  const order = ctx.service.leafOrderView();
  if (order) registerActionMajorityContext(pts, order, ctx.nodes);
}

export function buildGroupsFromActiveClusters(
  activeClusters: readonly ClusterTreeNode[],
  hierarchyId: number | undefined,
  doiGroup: "annotation" | "inset",
  contentVersion: number
): CutDrivenGroups | null {
  const ctx = getNodeClusteringContext();
  if (!ctx || hierarchyId == null || ctx.hierarchyId !== hierarchyId) return null;

  const groups: GroupsMap = {};
  const centers = new Map<string, { x: number; y: number }>();
  for (const cluster of activeClusters) {
    const cached = nodeGroupCache.get(cluster);
    let pts: DataPoint[];
    if (cached && cached.v === contentVersion && cached.g === doiGroup) {
      pts = cached.arr;
    } else {
      // Uniform revision-0 boot (issue #315 A3 P-a): server-cut datasets skip
      // the O(n) boot marking that used to stamp every node "inset", so an
      // UNWRITTEN doiGroup reads as "inset" there — same classification the
      // deleted pass produced (uniform DoI 1 ⇒ every active is inset-side).
      // The client lazy lane (issue #315 R3d) boots in the SAME unwritten
      // state: its marking pass is deferred past residency, so while the
      // array is lazy+non-resident no stamp exists on any lane and the
      // ladder reads uniform "inset" here too.
      const undefinedGroup =
        ctx.service.serverCutMode ||
        (isLazyRowArray(ctx.nodes) && !areRowsResident(ctx.nodes))
          ? "inset"
          : undefined;
      // Server-baked DoI (issue #315 P7 S5): on the provider path no per-node
      // doiGroup STRING is written any more — the ladder is EVALUATED from the
      // adopted f32 DoI column, same thresholds, same four bands, at dozens-of-
      // actives cost instead of an O(1M) write pass per commit. `baked` is null
      // on every client-owned path, which keeps the string read below exact.
      const baked = isDoiBaked();
      // Index-backed groups (issue #315 R1c): while the canonical array's
      // rows are NOT resident, no member row is resolved at build time —
      // R1b's per-member `rowAt` here repaid the whole deferred
      // materialization inside the select-frame apply (plan §4 R1b Finding
      // 2). The group is a HOLEY array of the kept count; its membership
      // lives in the groupMembers spec (leaf range, or kept canonical
      // indices when the baked doiGroup gate filters). Bounded consumers
      // materialize exactly their samples through the spec's `rowAt`
      // accessors; groups of ≤ 2 members get real rows eagerly so the
      // singleton special cases stay branch-free.
      const range =
        isLazyRowArray(ctx.nodes) && !areRowsResident(ctx.nodes)
          ? ctx.service.leafRangeMembers(cluster)
          : null;
      if (range) {
        const { order, first, last } = range;
        const size = last - first;
        let full = false;
        let indices: Int32Array | null = null;
        if (!baked) {
          // Uniform DoI: the unwritten ladder classifies every member as
          // undefinedGroup — no per-member test exists to run, so a full
          // group is O(1) and a mismatched layer is empty.
          full = undefinedGroup === doiGroup;
        } else {
          // Columnar gate: doiGroupOf(canonical index) evaluates the same
          // ladder doiGroupOfPoint reads through `p.DoI` (the adopted
          // column) — one f32 read + three compares per member, no rows.
          let kept = 0;
          for (let k = first; k < last; k++) {
            if (doiGroupOf(order[k] as number) === doiGroup) kept++;
          }
          if (kept === size) {
            full = true;
          } else if (kept > 0) {
            indices = new Int32Array(kept);
            let w = 0;
            for (let k = first; k < last; k++) {
              const i = order[k] as number;
              if (doiGroupOf(i) === doiGroup) indices[w++] = i;
            }
          }
        }
        const count = full ? size : (indices?.length ?? 0);
        if (count === 0) {
          pts = [];
        } else if (count <= 2) {
          // Real rows: consumers read samples[0]/[1] directly on singleton
          // and pair paths (hull circle, single-action label).
          pts = [];
          for (let k = 0; k < count; k++) {
            const i = full ? (order[first + k] as number) : indices![k];
            const p = rowAt(ctx.nodes, i);
            if (p) pts.push(p);
          }
        } else {
          pts = new Array<DataPoint>(count);
          registerGroupMembers(
            pts,
            full
              ? { kind: "range", nodes: ctx.nodes, hierarchyId: ctx.hierarchyId, order, first, last }
              : { kind: "list", nodes: ctx.nodes, hierarchyId: ctx.hierarchyId, indices: indices! }
          );
        }
        if (full && pts.length === size) attachFullMembershipMarkers(pts, cluster, ctx);
        // Dev-only observability (issue #315 R1c): `window.__groupSpecDebug =
        // true` counts which representation served each built group so
        // headless harnesses can prove the range/list spec branches actually
        // ran (a silent fall-through to the resident lane would pass an E2E
        // vacuously). No cost when the flag is unset.
        if ((window as unknown as { __groupSpecDebug?: boolean }).__groupSpecDebug) {
          const w = window as unknown as Record<string, Record<string, number>>;
          const c = (w.__groupSpecCounts ??= { range: 0, list: 0, eager: 0, empty: 0, resident: 0 });
          if (count === 0) c.empty++;
          else if (count <= 2) c.eager++;
          else if (full) c.range++;
          else c.list++;
        }
      } else {
        const memberIdx = ctx.service.membersOfCluster(cluster);
        pts = [];
        for (let i = 0; i < memberIdx.length; i++) {
          // THE row seam (issue #315 R1b, plan §2.2/§4): on the resident /
          // client lane (and the no-leaf-range fallback) members resolve as
          // rows. `rowAt` builds a member's row on first ask and memoizes it
          // into the canonical array, so the identity every downstream
          // consumer relies on (reconcile's Set<DataPoint>, __memberHash,
          // Object.create prototyping) is one instance per index.
          const p = rowAt(ctx.nodes, memberIdx[i]);
          if (!p) continue;
          const g = baked ? doiGroupOfPoint(p) : (p.doiGroup ?? undefinedGroup);
          if (g === doiGroup) pts.push(p);
        }
        if (pts.length === memberIdx.length) attachFullMembershipMarkers(pts, cluster, ctx);
        if ((window as unknown as { __groupSpecDebug?: boolean }).__groupSpecDebug) {
          const w = window as unknown as Record<string, Record<string, number>>;
          const c = (w.__groupSpecCounts ??= { range: 0, list: 0, eager: 0, empty: 0, resident: 0 });
          c.resident++;
        }
      }
      nodeGroupCache.set(cluster, { v: contentVersion, g: doiGroup, arr: pts });
    }
    if (pts.length === 0) continue;
    groups[cluster.uid] = pts;
    // Cluster identity rides the group (issue #315 R1a step 5): the label
    // resolvers and cluster-uid labeling read it from here instead of from a
    // cluster id stamped onto every member point.
    registerGroupClusterUid(pts, cluster.uid);
    if (pts.length === (cluster.size ?? -1)) {
      const c = ctx.service.clusterCentroidFromPrefix(cluster);
      if (c) centers.set(cluster.uid, c);
    }
  }
  return { groups, centers };
}

/**
 * Midpoint twin (issue #315 phase C1b2): groups for the edge hooks from the
 * midpoint clustering's leaf ranges. The `clusterId === uid` gate reproduces
 * the legacy filter exactly (midpoints whose id was cleared by the DoI
 * threshold pass stay excluded).
 */
export function buildMidpointGroupsFromActiveClusters(
  activeClusters: readonly ClusterTreeNode[],
  hierarchyId: number | undefined,
  contentVersion: number
): Record<string, TrajectoryMidpoint[]> | null {
  const ctx = getMidpointClusteringContext();
  if (!ctx || hierarchyId == null || ctx.hierarchyId !== hierarchyId) return null;

  const groups: Record<string, TrajectoryMidpoint[]> = {};
  for (const cluster of activeClusters) {
    const cached = midpointGroupCache.get(cluster);
    if (cached && cached.v === contentVersion) {
      if (cached.arr.length > 0) groups[cluster.uid] = cached.arr;
      continue;
    }
    const memberIdx = ctx.service.membersOfCluster(cluster);
    const arr: TrajectoryMidpoint[] = [];
    for (let i = 0; i < memberIdx.length; i++) {
      const m = ctx.midpoints[memberIdx[i]];
      if (m && m.clusterId === cluster.uid) arr.push(m);
    }
    midpointGroupCache.set(cluster, { v: contentVersion, arr });
    if (arr.length > 0) groups[cluster.uid] = arr;
  }
  return groups;
}

type EdgeAugmentedPoint = DataPoint & {
  edgeStart?: DataPoint;
  edgeEnd?: DataPoint;
};

const pseudoPointCache = new WeakMap<readonly TrajectoryMidpoint[], DataPoint[]>();

/**
 * The edge hooks' midpoint→pseudo-DataPoint mapping, cached by the midpoint
 * array's identity: the group cache above keeps unchanged clusters' arrays
 * stable, so this allocation (previously per effect run, per member) only
 * happens for genuinely changed clusters.
 */
export function mapMidpointsToPseudoPoints(arr: readonly TrajectoryMidpoint[]): DataPoint[] {
  const cached = pseudoPointCache.get(arr);
  if (cached) return cached;
  const mapped = arr.map(
    (m) =>
      ({
        ...createEmptyDataPoint(),
        x: m.midPoint.x,
        y: m.midPoint.y,
        line: 0,
        id: m.id,
        action: m.action,
        DoI: 1,
        edgeStart: m.startPoint as DataPoint,
        edgeEnd: m.endPoint as DataPoint,
      }) as EdgeAugmentedPoint
  );
  pseudoPointCache.set(arr, mapped);
  return mapped;
}
