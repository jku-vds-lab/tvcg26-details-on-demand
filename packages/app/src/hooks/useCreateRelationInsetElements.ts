import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import type { ConsolidatedRelation } from "src/clustering/clusterRelations";
import {
  createEmptyDataPoint,
  type DataPoint,
} from "src/dataPreprocessing/dataPreprocessing";
import { getSnapshot as layoutGet, schedulePatch } from "src/layout/layoutStore";
import { VisualElementType } from "src/models/VisualElement";
import type { RootState } from "src/store";
import type { ClusterItem } from "./reconcileClusterItems";
import { reconcileClusterItems } from "./reconcileClusterItems";

/**
 * Synthetic DataPoint that carries the start and end DataPoints of a relation
 * transition so the per-dataset edge-diff renderers (Chess, CCTV, Rubiks…) can
 * access them via `(sample as EdgeAugmentedPoint).edgeStart` and `.edgeEnd`.
 */
export type EdgeAugmentedPoint = DataPoint & {
  edgeStart?: DataPoint;
  edgeEnd?: DataPoint;
  /** Full member samples of the transition's start/end clusters (array
   * references, attached when the caller provides a uid lookup). For
   * renderers whose diff compares the two CLUSTERS rather than the
   * single-step transition endpoints — one physics step barely changes a
   * gym render, so boundary-pair means wash out (see GymDatasetRenderer). */
  edgeClusterStart?: DataPoint[];
  edgeClusterEnd?: DataPoint[];
};

/** Build the synthetic edge samples for one relation (exported for tests).
 * `startSamples`/`endSamples` come from the relation's dominant direction, so
 * the start cluster is uidA exactly when the forward direction dominates
 * (mirrors consolidateRelations' `dominant` pick). */
export function buildRelationEdgeSamples(
  rel: ConsolidatedRelation,
  resolveClusterSamples?: (uid: string) => DataPoint[] | undefined
): EdgeAugmentedPoint[] {
  const startUid = rel.forwardScore >= rel.backwardScore ? rel.uidA : rel.uidB;
  const endUid = startUid === rel.uidA ? rel.uidB : rel.uidA;
  const clusterStart = resolveClusterSamples?.(startUid);
  const clusterEnd = resolveClusterSamples?.(endUid);
  return rel.startSamples.map((start, i): EdgeAugmentedPoint => {
    const end = rel.endSamples[i];
    // Use the precomputed on-curve spline midpoint when available (gives accurate
    // placement for on-spline insets). Fall back to straight-line midpoint if absent.
    const curveMid = rel.midSamples?.[i];
    const mx = curveMid ? curveMid.x : (start.x + (end?.x ?? start.x)) / 2;
    const my = curveMid ? curveMid.y : (start.y + (end?.y ?? start.y)) / 2;
    return {
      ...createEmptyDataPoint(),
      x: mx,
      y: my,
      line: 0,
      id: start.id,
      action: rel.actionHistogram
        ? (Object.entries(rel.actionHistogram).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "")
        : "",
      DoI: 1,
      edgeStart: start,
      edgeEnd: end,
      edgeClusterStart: clusterStart,
      edgeClusterEnd: clusterEnd,
    };
  });
}

/**
 * Convert a list of {@link ConsolidatedRelation} objects into {@link ClusterItem}
 * elements rendered by the existing edge-inset pipeline.
 *
 * One inset per UNORDERED pair {A, B}.  Canonical id: `edge-inset-<uidA>~<uidB>::h<hierarchyId>`.
 * Relation anchors (with directional scores) are attached synchronously during
 * item creation so leader lines appear immediately without a second render pass.
 */
export function useCreateRelationInsetElements(
  relations: ConsolidatedRelation[],
  nodeElementMap?: ReadonlyMap<string, { samples: DataPoint[] }>
): {
  clusterItems: ClusterItem[];
  visibleClusterItems: ClusterItem[];
} {
  const { datasetType } = useSelector((s: RootState) => s.dataset);
  const insetVersion = useSelector(
    (s: RootState) => s.clustering.insetClusterVersion
  );
  const annotationVersion = useSelector(
    (s: RootState) => s.clustering.annotationClusterVersion
  );

  const hierarchyId = useSelector(
    (s: RootState) =>
      (s.clustering.insetClusteringResults?.hierarchyId ?? 0) * 10000 +
      (s.clustering.annotationClusteringResults?.hierarchyId ?? 0)
  );
  const hierarchySuffix = `::h${hierarchyId}`;

  const [clusterItems, setClusterItems] = useState<ClusterItem[]>([]);
  const prevHierarchyId = useRef(hierarchyId);
  const prevDatasetType = useRef(datasetType);
  const shouldForceSeedRef = useRef(false);

  useEffect(() => {
    const groups: Record<string, DataPoint[]> = {};

    for (const rel of relations) {
      const pairKey = `${rel.uidA}~${rel.uidB}`;
      groups[pairKey] = buildRelationEdgeSamples(rel, (uid) =>
        nodeElementMap?.get(uid)?.samples
      );
    }

    const resetAll =
      hierarchyId !== prevHierarchyId.current ||
      datasetType !== prevDatasetType.current;
    shouldForceSeedRef.current = resetAll;

    // Build a lookup for anchor attachment (applied synchronously below).
    const relMap = new Map<string, ConsolidatedRelation>(
      relations.map((r) => [`${r.uidA}~${r.uidB}`, r])
    );

    setClusterItems((prev) => {
      const next = reconcileClusterItems(prev, groups, {
        kind: "edge",
        type: VisualElementType.Inset,
        datasetType,
        resetAll,
        idSuffix: hierarchySuffix,
      });

      // Attach relation anchors synchronously so leader lines render on first pass.
      for (const item of next) {
        // id format: "edge-inset-<uidA>~<uidB>::h<hierarchyId>"
        const raw = item.element.id
          .replace(/^edge-inset-/, "")
          .replace(/::h\d+$/, "");
        const rel = relMap.get(raw);
        if (rel) {
          item.element.relationAnchors = {
            uidA: rel.uidA,
            uidB: rel.uidB,
            forwardScore: rel.forwardScore,
            backwardScore: rel.backwardScore,
            onSpline: rel.sizeA === 1 && rel.sizeB === 1,
          };

          // Attach the full cluster memberships to the element's CURRENT
          // samples: reconcile keeps the old sample instances whenever the
          // membership ids are unchanged, so fields set at build time are
          // dropped for reused items — and the first pass often runs before
          // nodeElementMap has filled. Swapping the array identity when the
          // refs change makes the memoized item child re-render (it keys on
          // the samples prop identity).
          const startUid =
            rel.forwardScore >= rel.backwardScore ? rel.uidA : rel.uidB;
          const endUid = startUid === rel.uidA ? rel.uidB : rel.uidA;
          const clusterStart = nodeElementMap?.get(startUid)?.samples;
          const clusterEnd = nodeElementMap?.get(endUid)?.samples;
          const first = item.element.samples[0] as EdgeAugmentedPoint | undefined;
          if (
            clusterStart &&
            clusterEnd &&
            first &&
            (first.edgeClusterStart !== clusterStart ||
              first.edgeClusterEnd !== clusterEnd)
          ) {
            for (const s of item.element.samples as EdgeAugmentedPoint[]) {
              s.edgeClusterStart = clusterStart;
              s.edgeClusterEnd = clusterEnd;
            }
            item.element.samples = [...item.element.samples];
          }
        }
      }

      return next;
    });

    prevHierarchyId.current = hierarchyId;
    prevDatasetType.current = datasetType;
  }, [relations, datasetType, hierarchyId, hierarchySuffix, nodeElementMap]);

  // Seed layout positions for newly created items
  useLayoutEffect(() => {
    const { positions } = layoutGet();
    const patch = new Map<string, { x: number; y: number }>();
    const forceSeed = shouldForceSeedRef.current;
    for (const { element } of clusterItems) {
      if (forceSeed || !positions.has(element.id)) {
        patch.set(element.id, { ...element.position });
      }
    }
    shouldForceSeedRef.current = false;
    if (patch.size) schedulePatch(patch);
  }, [clusterItems]);

  // All relation insets are "visible" — the budget cap is applied upstream.
  const visibleClusterItems = useMemo(
    () => clusterItems,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clusterItems, insetVersion, annotationVersion]
  );

  return { clusterItems, visibleClusterItems };
}
