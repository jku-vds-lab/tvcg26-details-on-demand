import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { isServerCutActive } from "src/clustering/hdbscanClustering";
import { getSnapshot as layoutGet, schedulePatch } from "src/layout/layoutStore";
import { VisualElementType, parseClusterUid } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { groupBy } from "src/utils/utils";
import { buildGroupsFromActiveClusters } from "./cutDrivenGroups";
import { ClusterItem, reconcileClusterItems } from "./reconcileClusterItems";

const EMPTY_ACTIVE_CLUSTERS: never[] = [];

export const useCreateInsetClusterElements = (
  insetNodes: DataPoint[]
): {
  clusters:            ClusterItem[];
  visibleClusterItems: ClusterItem[];
} => {
  const { datasetType } = useSelector((s: RootState) => s.dataset);
  const activeClusterNodes = useSelector(
    (s: RootState) => s.clustering.insetClusteringResults?.activeClusters ?? EMPTY_ACTIVE_CLUSTERS
  );
  const hierarchyId = useSelector(
    (s: RootState) => s.clustering.insetClusteringResults?.hierarchyId
  );
  const hierarchySuffix = `::h${hierarchyId ?? 0}`;
  // Content version for the group cache: any pipeline that changes doiGroup
  // or cluster assignments bumps one of these counters.
  const annotationVersion = useSelector((s: RootState) => s.clustering.annotationClusterVersion);
  const insetVersion = useSelector((s: RootState) => s.clustering.insetClusterVersion);
  const contentVersion = annotationVersion * 0x4000000 + insetVersion;

  const [clusterItems, setClusterItems] = useState<ClusterItem[]>([]);

  const prevHierarchyId    = useRef(hierarchyId);
  const prevDatasetType    = useRef(datasetType);
  const shouldForceSeedRef = useRef(false);

  useEffect(() => {
    // Cut-driven groups (issue #315 phase C1): O(active members) from leaf
    // ranges instead of re-deriving from a viewport scan. Also skips the
    // legacy "noise" pseudo-group (it was never rendered — visibleClusterItems
    // filters to actives — but its hull was computed). Falls back to the
    // viewport groupBy when the persistent clustering doesn't match (swap in
    // flight, selection-subset hierarchies without a live context).
    const cutDriven = buildGroupsFromActiveClusters(activeClusterNodes, hierarchyId, "inset", contentVersion);
    // Issue #315 plan G0: in server-cut mode a hierarchy swap is a one-tick
    // race (context persisted, dispatch in flight) — the legacy fallback
    // below is O(dataset) + uid/numeric hull-key misses → client computeHull
    // (the measured drag-release spike). Keep the previous items for that
    // tick; the aligned effect follows immediately. Skip BEFORE the prev-ref
    // updates so resetAll is computed against the true previous hierarchy.
    if (cutDriven === null && isServerCutActive()) return;
    const groups = cutDriven?.groups ?? groupBy(insetNodes, (n) => n.insetClusterId ?? "noise");

    const resetAll =
      hierarchyId !== prevHierarchyId.current ||
      datasetType !== prevDatasetType.current;
    shouldForceSeedRef.current = resetAll;
    // Server-computed contours (issue #315 D1) and inset seeds (S3/S4),
    // keyed like the groups.
    const precomputedHulls = new Map<string, [number, number][]>();
    const precomputedInsetPositions = new Map<string, { x: number; y: number }>();
    for (const c of activeClusterNodes) {
      if (c.precomputedHull?.length) precomputedHulls.set(c.uid, c.precomputedHull);
      if (c.insetPos) precomputedInsetPositions.set(c.uid, { x: c.insetPos[0], y: c.insetPos[1] });
    }
    setClusterItems((prev) =>
      reconcileClusterItems(prev, groups, {
        kind: "node",
        type: VisualElementType.Inset,
        datasetType,
        resetAll,
        idSuffix: hierarchySuffix,
        precomputedHulls,
        precomputedInsetPositions,
        precomputedCenters: cutDriven?.centers,
      })
    );

    prevHierarchyId.current = hierarchyId;
    prevDatasetType.current = datasetType;
  }, [datasetType, hierarchySuffix, insetNodes, hierarchyId, activeClusterNodes, contentVersion]);

  // 🔹 Seed layout positions after commit (no render-phase updates)
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
    if (patch.size) schedulePatch(patch); // rAF-batched, idempotent
  }, [clusterItems]);

  const visibleClusterItems = useMemo(() => {
    const activeMap = new Map(
      activeClusterNodes.map((c) => [c.uid, c] as const)
    );
    return clusterItems
      .filter(({ element }) => activeMap.has(parseClusterUid(element.id)))
      .map((item) => ({
        ...item,
        cluster: activeMap.get(parseClusterUid(item.element.id))!,
      }));
  }, [clusterItems, activeClusterNodes]);

  return { clusters: clusterItems, visibleClusterItems };
};
