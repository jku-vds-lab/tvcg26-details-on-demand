import {
    groupMeanPoint,
    groupMemberIndexAt,
    groupMembersOf,
    type GroupMemberSpec,
} from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getSnapshot as layoutGet } from "src/layout/layoutStore";
import { ledgerMark } from "src/utils/insetLedger";
import { ClusterConvexHull } from "src/models/ClusterConvexHull";
import {
    ElementKind,
    VisualElement,
    VisualElementType,
    makeElementId,
} from "src/models/VisualElement";

export interface ClusterItem {
  element: VisualElement;
  hull: ClusterConvexHull | null;
}

export type GroupsMap = Record<string, DataPoint[]>; // key is cluster id (e.g., uid or 'noise')

const insetWorldPositionMemory = new Map<string, { x: number; y: number }>();
const insetWorldPositionByElementId = new Map<string, { x: number; y: number }>();

// Perf (issue #322): sampleKey/membershipSignature/sameMembership dominated
// pan-time CPU on large datasets — reconcile runs on every settled zoom tick
// and scanned every member of every cluster. Points are hydrated once and
// member arrays are never mutated in place (reconcile swaps the reference),
// so per-point keys and per-array signatures are safe to cache in WeakMaps,
// and an unchanged membership can be detected by pairwise identity (groupBy
// rebuilds groups in stable dataset order every pass).

const sampleKeyCache = new WeakMap<DataPoint, string>();

function sampleKey(p: DataPoint): string {
  const cached = sampleKeyCache.get(p);
  if (cached !== undefined) return cached;
  const idPart = Number.isFinite(p.id) ? String(p.id) : "na";
  const linePart = Number.isFinite(p.line) ? String(p.line) : "na";
  const key = `${idPart}:${linePart}`;
  sampleKeyCache.set(p, key);
  return key;
}

// Numeric membership hashing (1M-scale follow-up to the #322 caches): the
// sorted-string signature was O(n log n) string work per NEW array instance,
// and groupBy rebuilds every group array on every reconcile pass — at 1M
// members that alone cost seconds per zoom tick. The hash is a commutative
// (order-independent) pair of 32-bit mixes over per-point hashes, cached per
// point and per array reference, so unchanged memberships (same array
// identity) cost O(1) and changed ones one O(n) numeric pass.
// The per-point hash is cached as a NON-ENUMERABLE own property: a WeakMap
// costs a hashed lookup per member per digest (measured 11.5% of interaction
// CPU at 1M), a plain property read is near-free. Non-enumerable keeps it out
// of JSON exports, Object.keys, and the feature scan.
interface HashedPoint extends DataPoint {
  __memberHash?: number;
}

function pointHash(p: DataPoint): number {
  const cached = (p as HashedPoint).__memberHash;
  if (cached !== undefined) return cached;
  const id = Number.isFinite(p.id) ? (p.id as number) : -1;
  const line = Number.isFinite(p.line) ? (p.line as number) : -1;
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(line ^ 0x27d4eb2f, 0xc2b2ae35);
  h = (h ^ (h >>> 15)) >>> 0;
  Object.defineProperty(p, "__memberHash", { value: h, enumerable: false, configurable: true, writable: false });
  return h;
}

const membershipHashCache = new WeakMap<DataPoint[], string>();

/** The full-membership leaf-range marker `cutDrivenGroups` attaches when the
 * doiGroup gate kept EVERY member (issue #315): the array IS the cluster's
 * leaf range, so tree + fit + hierarchyId + ranges determine the membership
 * exactly — an O(ranges) digest instead of an O(members) per-point pass (the
 * boot winners span the whole dataset: 1M `pointHash` installs, ~0.25 s). */
interface LeafRangeMarker {
  tree: string;
  ranges: Array<[number, number]>;
  fit?: string;
  hierarchyId?: number;
}

function leafRangeOf(samples: DataPoint[]): LeafRangeMarker | undefined {
  return (samples as DataPoint[] & { __leafRange?: LeafRangeMarker }).__leafRange;
}

function rangeSig(marker: LeafRangeMarker, length: number): string {
  const ranges = marker.ranges.map(([a, b]) => `${a}-${b}`).join(",");
  return `R:${marker.tree}:${marker.fit ?? ""}:${marker.hierarchyId ?? ""}:${ranges}:${length}`;
}

/** Order-independent membership digest: length + additive and xor mixes.
 * Range-marked (full-membership) arrays digest by their exact range
 * signature instead — same collision contract (a collision is cosmetic for
 * `memoryKey`, and the range signature is exact, not probabilistic). */
function membershipHash(samples: DataPoint[]): string {
  const cached = membershipHashCache.get(samples);
  if (cached !== undefined) return cached;
  const range = leafRangeOf(samples);
  if (range) {
    const hash = rangeSig(range, samples.length);
    membershipHashCache.set(samples, hash);
    return hash;
  }
  // Index-backed filtered groups (issue #315 R1c): the array carries no
  // rows (holey slots), so digest the member-index sequence instead —
  // exact under a hierarchy, and the "I:" representation never equals a
  // range signature or a point-hash digest (same cross-representation
  // rule as "R:"). Full-membership specs are range-marked and hit above.
  const spec = groupMembersOf(samples);
  if (spec) {
    let add = 0;
    let xor = 0;
    for (let k = 0; k < samples.length; k++) {
      const i = groupMemberIndexAt(spec, k);
      let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
      h = (h ^ (h >>> 15)) >>> 0;
      add = (add + h) | 0;
      xor ^= h;
    }
    const hash = `I:${spec.hierarchyId}:${samples.length}:${(add >>> 0).toString(36)}:${(xor >>> 0).toString(36)}`;
    membershipHashCache.set(samples, hash);
    return hash;
  }
  let add = 0;
  let xor = 0;
  for (let i = 0; i < samples.length; i++) {
    const h = pointHash(samples[i]);
    add = (add + h) | 0;
    xor ^= h;
  }
  const hash = `${samples.length}:${(add >>> 0).toString(36)}:${(xor >>> 0).toString(36)}`;
  membershipHashCache.set(samples, hash);
  return hash;
}

/** Exact spec-vs-spec membership compare (issue #315 R1c): same hierarchy
 * ⇒ pairwise index compare (leaf order is deterministic, so equal
 * memberships arrive in equal order); different hierarchies ⇒ changed
 * (leaf positions renumber — the range-digest rule). */
function sameSpecMembership(sa: GroupMemberSpec, sb: GroupMemberSpec, n: number): boolean {
  if (sa.hierarchyId !== sb.hierarchyId) return false;
  if (sa.kind === "range" && sb.kind === "range") {
    return sa.first === sb.first && sa.last === sb.last && sa.order === sb.order;
  }
  for (let k = 0; k < n; k++) {
    if (groupMemberIndexAt(sa, k) !== groupMemberIndexAt(sb, k)) return false;
  }
  return true;
}

function sameMembership(a: DataPoint[], b: DataPoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;

  // Two full-membership arrays: the range signature decides exactly — and
  // skips the O(members) pairwise scan per settled tick at 1M. Mixed
  // (one marked, one not) falls through to the exact paths below: their
  // digest REPRESENTATIONS differ, so only equality can be trusted here.
  const ra = leafRangeOf(a);
  const rb = leafRangeOf(b);
  if (ra && rb) return rangeSig(ra, a.length) === rangeSig(rb, b.length);

  // Index-backed groups (issue #315 R1c) MUST be decided from their specs
  // BEFORE the pairwise loop: their slots are holes, and two different
  // holey memberships would compare `undefined === undefined` pairwise and
  // false-report "identical". A spec'd vs plain-row pair is a residency
  // transition — report changed (one spurious samples-swap + reheat; the
  // element-id position memory keeps the inset where it was).
  const sa = groupMembersOf(a);
  const sb = groupMembersOf(b);
  if (sa || sb) {
    if (!sa || !sb) return false;
    return sameSpecMembership(sa, sb, a.length);
  }

  // Fast path: unchanged memberships arrive as pairwise-identical instances
  // (stable dataset order) — pure pointer compares, no strings, no maps.
  let pairwiseIdentical = true;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      pairwiseIdentical = false;
      break;
    }
  }
  if (pairwiseIdentical) return true;

  // Cheap numeric reject: different digests ⇒ definitely different members.
  // Only when both digests use the SAME representation — a range signature
  // never equals a point-hash digest, so a mixed pair must fall through to
  // the exact identity-set comparison below.
  if (!!ra === !!rb && membershipHash(a) !== membershipHash(b)) return false;

  // Exact identity-set comparison. Reordered-but-unchanged memberships are
  // the COMMON case during zoom/pan at scale — rbush returns hits in
  // viewport-dependent order, so groupBy rebuilds every group array in a new
  // order each tick. Memberships are canonical DataPoint instances, so
  // reference equality is exact; the old string-multiset fallback cost
  // seconds per tick at 1M members.
  const as = new Set<DataPoint>(a);
  if (as.size !== a.length) {
    // Duplicate instances (shouldn't happen) — exact string multiset fallback.
    const ac = new Map<string, number>();
    const bc = new Map<string, number>();
    for (const p of a) {
      const k = sampleKey(p);
      ac.set(k, (ac.get(k) ?? 0) + 1);
    }
    for (const p of b) {
      const k = sampleKey(p);
      bc.set(k, (bc.get(k) ?? 0) + 1);
    }
    if (ac.size !== bc.size) return false;
    for (const [k, n] of ac) {
      if ((bc.get(k) ?? 0) !== n) return false;
    }
    return true;
  }
  for (let i = 0; i < b.length; i++) {
    if (!as.has(b[i])) return false;
  }
  return true;
}

function memoryKey(kind: ElementKind, samples: DataPoint[], namespace?: string): string {
  // Position memory keys use the digest, not an exact signature: a collision
  // merely restores a remembered world position for a different membership —
  // cosmetic, and ~2^-64-rare — while exact signatures cost an O(n log n)
  // string sort per new array instance.
  return `${kind}:${namespace ?? "global"}:${membershipHash(samples)}`;
}

function clearInsetMembershipMemoryForKind(kind: ElementKind): void {
  const prefix = `${kind}:`;
  for (const key of insetWorldPositionMemory.keys()) {
    if (key.startsWith(prefix)) {
      insetWorldPositionMemory.delete(key);
    }
  }
}

function meanPoint(samples: DataPoint[]): { x: number; y: number } {
  if (!samples.length) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < samples.length; i++) {
    sx += samples[i].x;
    sy += samples[i].y;
  }
  return { x: sx / samples.length, y: sy / samples.length };
}

function meanOfPoints(points: Array<{ x: number; y: number }>): { x: number; y: number } | null {
  if (!points.length) return null;
  const sx = points.reduce((acc, p) => acc + p.x, 0);
  const sy = points.reduce((acc, p) => acc + p.y, 0);
  return { x: sx / points.length, y: sy / points.length };
}

function chooseOppositeContourPoint(
  center: { x: number; y: number },
  hullPoints: Array<[number, number]> | null | undefined,
  insetBarycenter: { x: number; y: number } | null
): { x: number; y: number } {
  if (!hullPoints || hullPoints.length === 0) {
    return center;
  }

  if (!insetBarycenter) {
    // Fallback for first-frame placement without any prior labels.
    let best = hullPoints[0];
    let bestDist2 = -Infinity;
    for (const p of hullPoints) {
      const dx = p[0] - center.x;
      const dy = p[1] - center.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > bestDist2) {
        bestDist2 = d2;
        best = p;
      }
    }
    return { x: best[0], y: best[1] };
  }

  let dx = center.x - insetBarycenter.x;
  let dy = center.y - insetBarycenter.y;
  const norm = Math.hypot(dx, dy);
  if (norm < 1e-9) {
    dx = 0;
    dy = -1;
  } else {
    dx /= norm;
    dy /= norm;
  }

  let best = hullPoints[0];
  let bestScore = -Infinity;
  for (const p of hullPoints) {
    const vx = p[0] - center.x;
    const vy = p[1] - center.y;
    const score = vx * dx + vy * dy;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return { x: best[0], y: best[1] };
}

function pushPointOutsideContour(
  center: { x: number; y: number },
  contourPoint: { x: number; y: number },
  factor = 1.35
): { x: number; y: number } {
  const dx = contourPoint.x - center.x;
  const dy = contourPoint.y - center.y;
  const n = Math.hypot(dx, dy);
  if (n < 1e-9) return contourPoint;
  return {
    x: center.x + dx * factor,
    y: center.y + dy * factor,
  };
}

/**
 * Reconcile cluster items with latest group membership.
 * - Preserves existing item identity when id persists.
 * - Updates samples, hull, and sourcePosition when membership changes.
 * - Creates items for new ids; drops items for removed ids.
 * - If resetAll is true, drops all previous items and rebuilds from groups.
 */
export function reconcileClusterItems(
  prevItems: ClusterItem[],
  groups: GroupsMap,
  opts: {
    kind: ElementKind;
    type: VisualElementType;
    datasetType: string;
    resetAll?: boolean;
    idSuffix?: string;
    /** Server-computed contours per group id (issue #315 D1). */
    precomputedHulls?: Map<string, [number, number][]>;
    /** O(1) prefix centroids per group id (issue #315 C2) — meanPoint over
     * members was 15.7% of 1M interaction CPU. */
    precomputedCenters?: Map<string, { x: number; y: number }>;
    /** Server-computed non-overlapping inset seeds per group id (issue #315
     * S3/S4, data coords). Used only for genuinely NEW insets without a
     * remembered position — the mental-map memory still wins. */
    precomputedInsetPositions?: Map<string, { x: number; y: number }>;
  }
): ClusterItem[] {
  const { kind, type, datasetType, resetAll, idSuffix } = opts;
  const memoryNamespace = idSuffix ?? "global";
  const layoutPositions = layoutGet().positions;
  const layoutLabelPositions: Array<{ x: number; y: number }> = [];
  layoutPositions.forEach((pos, id) => {
    if (id.includes("-inset-") || id.includes("-annotation-")) {
      layoutLabelPositions.push(pos);
    }
  });
  const insetBarycenter = layoutLabelPositions.length
    ? {
        x: layoutLabelPositions.reduce((acc, p) => acc + p.x, 0) / layoutLabelPositions.length,
        y: layoutLabelPositions.reduce((acc, p) => acc + p.y, 0) / layoutLabelPositions.length,
      }
    : null;

  // Keep a rolling memory of settled inset world coordinates for mental-map consistency.
  if (type === VisualElementType.Inset) {
    if (resetAll) {
      const elementIdPrefix = `${kind}-${type}-`;
      for (const id of insetWorldPositionByElementId.keys()) {
        if (id.startsWith(elementIdPrefix)) {
          insetWorldPositionByElementId.delete(id);
        }
      }
      clearInsetMembershipMemoryForKind(kind);
    }

    if (!resetAll) {
      for (const item of prevItems) {
        const pos = layoutPositions.get(item.element.id) ?? item.element.center;
        insetWorldPositionByElementId.set(item.element.id, { x: pos.x, y: pos.y });
        insetWorldPositionMemory.set(
          memoryKey(item.element.kind, item.element.samples, memoryNamespace),
          {
            x: pos.x,
            y: pos.y,
          }
        );
      }
    }
  }

  const nextMap = new Map<string, ClusterItem>();
  const prevMap = resetAll
    ? new Map<string, ClusterItem>()
    : new Map(prevItems.map((it) => [it.element.id, it] as const));

  const clusterCenters = new Map<string, { x: number; y: number }>();
  for (const [id, nodes] of Object.entries(groups)) {
    // Index-backed groups (issue #315 R1c) have holey slots — their
    // centroid reads the x/y columns at the member indices instead.
    clusterCenters.set(
      id,
      opts.precomputedCenters?.get(id) ?? groupMeanPoint(nodes) ?? meanPoint(nodes)
    );
  }

  function peerBarycenter(clusterId: string): { x: number; y: number } | null {
    const peers: Array<{ x: number; y: number }> = [];
    for (const [otherId, c] of clusterCenters) {
      if (otherId === clusterId) continue;
      peers.push(c);
    }
    return meanOfPoints(peers);
  }

  for (const [id, nodes] of Object.entries(groups)) {
    const key = makeElementId(kind, type, `${id}${idSuffix ?? ""}`);
    const exists = prevMap.get(key);
    if (!exists) {
      // Task 2 attribution (#315): the DOM uid is `${id}${idSuffix}`.
      if (type === VisualElementType.Inset) ledgerMark(`${id}${idSuffix ?? ""}`, "reconcileCreate");
      // Creation fast path (issue #315): centroid comes from the O(1) prefix
      // (or the map built above) and content synthesis is DEFERRED — the
      // React render synthesizes and measures the same content one frame
      // later, so the double-synthesis here was half the activation burst.
      const el = new VisualElement(
        key,
        kind,
        type,
        1,
        0,
        datasetType,
        nodes,
        { center: clusterCenters.get(id), deferMeasure: true }
      );
      const hull =
        kind === "node"
          ? new ClusterConvexHull(
              `hull-${type === VisualElementType.Inset ? "inset" : "annotation"}-${id}`,
              nodes,
              opts.precomputedHulls?.get(id)
            )
          : null;

      const center = clusterCenters.get(id) ?? groupMeanPoint(nodes) ?? meanPoint(nodes);
      const contourAnchor = peerBarycenter(id) ?? insetBarycenter;
      const contourPos = chooseOppositeContourPoint(center, hull?.hullPoints, contourAnchor);

      if (type === VisualElementType.Annotation) {
        el.center = contourPos;
      }

      if (type === VisualElementType.Inset) {
        const rememberedById = resetAll ? undefined : insetWorldPositionByElementId.get(key);
        const rememberedByLayout = resetAll ? undefined : layoutPositions.get(key);
        const rememberedByMembership = resetAll
          ? undefined
          : insetWorldPositionMemory.get(memoryKey(kind, nodes, memoryNamespace));
        const remembered = rememberedById ?? rememberedByLayout ?? rememberedByMembership;

        const serverSeed = opts.precomputedInsetPositions?.get(id);
        if (remembered) {
          el.center = { x: remembered.x, y: remembered.y };
          // Reintroduced inset should stay where it was, not restart optimization.
          el.temperature = 0;
        } else if (serverSeed) {
          // Server-computed placement (issue #315 S3/S4): the cut response
          // ships a non-overlapping seed — start cold, the annealer only
          // polishes (the selective-reheat pass still fixes real conflicts).
          el.center = { x: serverSeed.x, y: serverSeed.y };
          el.temperature = 0;
        } else if (kind === "node") {
          // New node insets start outside the contour to avoid being born inside
          // cluster hulls when no remembered position is available.
          el.center = pushPointOutsideContour(center, contourPos);
        }
      }

      nextMap.set(key, { element: el, hull });
      continue;
    }

    // Update existing item when membership changes OR the source centroid
    // moves. Centroids were already computed for clusterCenters above.
    const item = exists;
    const { x: cx, y: cy } = clusterCenters.get(id)!;
    const membershipChanged = !sameMembership(item.element.samples, nodes);
    const sourceShift = Math.hypot(
      item.element.sourcePosition.x - cx,
      item.element.sourcePosition.y - cy
    );
    const clusterChanged = membershipChanged || sourceShift > 1e-9;

    if (type === VisualElementType.Annotation && clusterChanged) {
      item.element.samples = nodes;
      item.element.sourcePosition = { x: cx, y: cy };
      // No re-measure here (issue #315): the React render re-synthesizes the
      // content for the new samples and sets the bbox in the same frame —
      // the synchronous synthesis here doubled every activation's cost.
      item.hull?.updateSamples(nodes, opts.precomputedHulls?.get(id));

      if (kind === "node") {
        const contourAnchor = peerBarycenter(id) ?? insetBarycenter;
        const reseedContour = chooseOppositeContourPoint(
          { x: cx, y: cy },
          item.hull?.hullPoints,
          contourAnchor
        );
        item.element.center = reseedContour;
      } else {
        item.element.center = { x: cx, y: cy };
      }

      // ensure the optimizer can resolve local overlaps from the new anchor
      item.element.temperature = Math.max(item.element.temperature, 1.0);
    } else if (clusterChanged) {
      if (type === VisualElementType.Inset) ledgerMark(`${id}${idSuffix ?? ""}`, "reconcileUpdate");
      item.element.samples = nodes;
      // reset source anchor to new centroid for correct leader lines
      item.element.sourcePosition = { x: cx, y: cy };
      // No re-measure — see the annotation branch above.
      item.hull?.updateSamples(nodes, opts.precomputedHulls?.get(id));

      if (type === VisualElementType.Inset && !item.element.pinned) {
        if (kind === "node") {
          const reseedContour = chooseOppositeContourPoint(
            { x: cx, y: cy },
            item.hull?.hullPoints,
            insetBarycenter
          );
          item.element.center = pushPointOutsideContour({ x: cx, y: cy }, reseedContour);
        } else {
          item.element.center = { x: cx, y: cy };
        }
      }

      // give it a little heat so the optimizer revisits placement — unless the
      // user dragged it there (#290): samples/anchor still update above, but a
      // pinned inset keeps its dropped position until re-dragged.
      if (!item.element.pinned) {
        item.element.temperature = Math.max(item.element.temperature, 1.0);
      }
    }
    nextMap.set(key, item);
  }

  return Array.from(nextMap.values());
}
