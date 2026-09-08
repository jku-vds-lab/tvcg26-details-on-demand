/**
 * clusterRelations.ts
 *
 * Pure helpers for deriving cluster-conditioned edge relations from visible
 * trajectory midpoints.  A relation A→B exists for each midpoint whose
 * startPoint is assigned to active node cluster A and whose endPoint is
 * assigned to active node cluster B (A ≠ B).
 *
 * These are deliberately dependency-free (no React, no Redux) so the logic
 * can be unit-tested in isolation.
 */

import type { DataPoint, TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One directed one-hop relation A→B between two active node clusters.
 * Produced by {@link extractClusterRelations} before consolidation.
 */
export interface ClusterRelation {
  /** uid of the source active cluster (transition starts here) */
  uidA: string;
  /** uid of the target active cluster (transition ends here) */
  uidB: string;
  /** number of one-hop midpoints connecting A → B */
  support: number;
  /** per-action counts accumulated from midpoint.action */
  actionHistogram: Record<string, number>;
  /** startPoints of all transitions (DataPoints in cluster A, edgeStart for the glyph) */
  startSamples: DataPoint[];
  /** endPoints of all transitions (DataPoints in cluster B, edgeEnd for the glyph) */
  endSamples: DataPoint[];
  /** on-curve midpoints (from TrajectoryMidpoint.midPoint) — parallel to startSamples/endSamples */
  midSamples: { x: number; y: number }[];
  /** composite score — higher is more salient */
  score: number;
  /** member count of the source cluster A */
  sizeA: number;
  /** member count of the target cluster B */
  sizeB: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Saturating constant k in support_factor = support / (support + k).
 * Prevents tiny high-purity clusters from dominating.
 */
const SUPPORT_K = 10;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve which active cluster a DataPoint belongs to.
 *
 * Checks inset cluster assignment first (higher DoI priority), then annotation
 * cluster assignment.  Returns null when the point is in neither active set.
 */
export function clusterOf(
  point: DataPoint,
  activeInsetUids: ReadonlySet<string>,
  activeAnnotationUids: ReadonlySet<string>
): string | null {
  if (point.insetClusterId != null) {
    const uid = String(point.insetClusterId);
    if (activeInsetUids.has(uid)) return uid;
  }
  if (point.annotationClusterId != null) {
    const uid = String(point.annotationClusterId);
    if (activeAnnotationUids.has(uid)) return uid;
  }
  return null;
}

/**
 * Extract and score cluster-conditioned edge relations from a set of visible
 * trajectory midpoints.
 *
 * @param midpoints       - all visible TrajectoryMidpoints (from the R-tree search)
 * @param activeInsetUids - uids of currently active inset clusters
 * @param activeAnnotationUids - uids of currently active annotation clusters
 * @param clusterSizes    - map from cluster uid → member count (ClusterTreeNode.size;
 *                          callers include freehand inset sizes here too)
 * @param freehandAssignments - optional point-id → freehand-inset-uid map. Freehand
 *                          membership takes priority over the automated cluster
 *                          assignment: a freehand-pinned point relates as its
 *                          freehand cluster, so edge insets form between
 *                          freehand-pinned clusters connected by trajectories.
 *
 * Returns relations sorted by score descending.  Relations with score === 0
 * (can arise if a cluster has size 0 in the map) are omitted.
 */
export function extractClusterRelations(
  midpoints: TrajectoryMidpoint[],
  activeInsetUids: ReadonlySet<string>,
  activeAnnotationUids: ReadonlySet<string>,
  clusterSizes: ReadonlyMap<string, number>,
  freehandAssignments?: ReadonlyMap<number, string>
): ClusterRelation[] {
  type Accum = {
    support: number;
    actionHistogram: Record<string, number>;
    startSamples: DataPoint[];
    endSamples: DataPoint[];
    midSamples: { x: number; y: number }[];
  };

  // keyed by "uidA~uidB" — UIDs are hex strings so ~ is safe as separator
  const accum = new Map<string, Accum>();
  // totals for purity computation
  const outgoingTotal = new Map<string, number>();
  const incomingTotal = new Map<string, number>();

  const resolve = (p: DataPoint): string | null =>
    freehandAssignments?.get(p.id) ??
    clusterOf(p, activeInsetUids, activeAnnotationUids);

  for (const m of midpoints) {
    const uidA = resolve(m.startPoint);
    const uidB = resolve(m.endPoint);
    if (uidA === null || uidB === null || uidA === uidB) continue;

    const key = `${uidA}~${uidB}`;
    let rec = accum.get(key);
    if (!rec) {
      rec = { support: 0, actionHistogram: {}, startSamples: [], endSamples: [], midSamples: [] };
      accum.set(key, rec);
    }
    rec.support += 1;
    const action = m.action ?? "";
    rec.actionHistogram[action] = (rec.actionHistogram[action] ?? 0) + 1;
    rec.startSamples.push(m.startPoint);
    rec.endSamples.push(m.endPoint);
    rec.midSamples.push(m.midPoint);

    outgoingTotal.set(uidA, (outgoingTotal.get(uidA) ?? 0) + 1);
    incomingTotal.set(uidB, (incomingTotal.get(uidB) ?? 0) + 1);
  }

  const relations: ClusterRelation[] = [];
  for (const [key, rec] of accum) {
    const tildeIdx = key.indexOf("~");
    const uidA = key.slice(0, tildeIdx);
    const uidB = key.slice(tildeIdx + 1);

    const { support } = rec;
    const outTotal = outgoingTotal.get(uidA) ?? 1;
    const inTotal = incomingTotal.get(uidB) ?? 1;

    const outgoingPurity = support / outTotal;
    const incomingPurity = support / inTotal;

    // Distinct participating points (proxy for coverage numerator)
    const distinctStarts = new Set(rec.startSamples.map((p) => p.id)).size;
    const distinctEnds = new Set(rec.endSamples.map((p) => p.id)).size;

    const sizeA = clusterSizes.get(uidA) ?? support;
    const sizeB = clusterSizes.get(uidB) ?? support;
    const sourceCoverage = Math.min(1, distinctStarts / Math.max(1, sizeA));
    const targetCoverage = Math.min(1, distinctEnds / Math.max(1, sizeB));
    const supportFactor = support / (support + SUPPORT_K);

    const score =
      outgoingPurity * incomingPurity * sourceCoverage * targetCoverage * supportFactor;

    if (score <= 0) continue;

    relations.push({
      uidA,
      uidB,
      support,
      actionHistogram: rec.actionHistogram,
      startSamples: rec.startSamples,
      endSamples: rec.endSamples,
      midSamples: rec.midSamples,
      score,
      sizeA,
      sizeB,
    });
  }

  relations.sort((a, b) => b.score - a.score);
  return relations;
}

// ---------------------------------------------------------------------------
// Consolidation: merge ordered A→B and B→A into one unordered pair
// ---------------------------------------------------------------------------

/**
 * A merged representation of all transitions between an unordered cluster
 * pair {A, B}.  uidA ≤ uidB lexicographically (canonical order).
 * "Forward" always means uidA→uidB; "backward" means uidB→uidA.
 */
export interface ConsolidatedRelation {
  /** Canonical first uid (lexicographically ≤ uidB). */
  uidA: string;
  /** Canonical second uid. */
  uidB: string;
  /** Transition count for the uidA→uidB direction. */
  forwardSupport: number;
  /** Transition count for the uidB→uidA direction. */
  backwardSupport: number;
  /** Score for the uidA→uidB direction (0 when absent). */
  forwardScore: number;
  /** Score for the uidB→uidA direction (0 when absent). */
  backwardScore: number;
  /** Combined score used for ranking (forwardScore + backwardScore). */
  score: number;
  /** Start samples from the dominant direction (higher score) for the diff glyph. */
  startSamples: DataPoint[];
  /** End samples from the dominant direction for the diff glyph. */
  endSamples: DataPoint[];
  /** On-curve midpoints (from TrajectoryMidpoint.midPoint) — parallel to startSamples/endSamples. */
  midSamples: { x: number; y: number }[];
  /** Action histogram from the dominant direction. */
  actionHistogram: Record<string, number>;
  /** Member count of the canonical uidA cluster. */
  sizeA: number;
  /** Member count of the canonical uidB cluster. */
  sizeB: number;
}

/**
 * Merge ordered {@link ClusterRelation} pairs A→B and B→A into one
 * {@link ConsolidatedRelation} per unordered pair {A, B}.
 *
 * The canonical key is `min(uid)~max(uid)`.  The dominant direction
 * (higher individual score) provides the diff-glyph samples.  Results are
 * sorted by combined score descending.
 */
export function consolidateRelations(
  relations: ClusterRelation[]
): ConsolidatedRelation[] {
  type Pair = {
    uidA: string;
    uidB: string;
    fwd: ClusterRelation | null;
    bwd: ClusterRelation | null;
  };
  const byPair = new Map<string, Pair>();

  for (const rel of relations) {
    const [a, b] = rel.uidA <= rel.uidB ? [rel.uidA, rel.uidB] : [rel.uidB, rel.uidA];
    const key = `${a}~${b}`;
    let pair = byPair.get(key);
    if (!pair) {
      pair = { uidA: a, uidB: b, fwd: null, bwd: null };
      byPair.set(key, pair);
    }
    if (rel.uidA === a) {
      pair.fwd = rel;
    } else {
      pair.bwd = rel;
    }
  }

  const result: ConsolidatedRelation[] = [];
  for (const { uidA, uidB, fwd, bwd } of byPair.values()) {
    const fwdScore = fwd?.score ?? 0;
    const bwdScore = bwd?.score ?? 0;
    const dominant = fwdScore >= bwdScore ? fwd : bwd;
    // fwd = a→b: fwd.sizeA = size(a), fwd.sizeB = size(b)
    // bwd = b→a: bwd.sizeA = size(b), bwd.sizeB = size(a)  ← note the flip
    const sizeA = fwd?.sizeA ?? bwd?.sizeB ?? 1;
    const sizeB = fwd?.sizeB ?? bwd?.sizeA ?? 1;
    result.push({
      uidA,
      uidB,
      forwardSupport: fwd?.support ?? 0,
      backwardSupport: bwd?.support ?? 0,
      forwardScore: fwdScore,
      backwardScore: bwdScore,
      score: fwdScore + bwdScore,
      startSamples: dominant?.startSamples ?? [],
      endSamples: dominant?.endSamples ?? [],
      midSamples: dominant?.midSamples ?? [],
      actionHistogram: dominant?.actionHistogram ?? {},
      sizeA,
      sizeB,
    });
  }

  result.sort((a, b) => b.score - a.score);
  return result;
}
