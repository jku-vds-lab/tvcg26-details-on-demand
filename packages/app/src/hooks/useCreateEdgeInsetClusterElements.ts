import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import type { DataPoint, TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";
import { isServerCutActive } from "src/clustering/hdbscanClustering";
import { getSnapshot as layoutGet, schedulePatch } from "src/layout/layoutStore";
import { VisualElementType, parseClusterUid } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { groupBy } from "src/utils/utils";
import { buildMidpointGroupsFromActiveClusters, mapMidpointsToPseudoPoints } from "./cutDrivenGroups";
import { ClusterItem, reconcileClusterItems } from "./reconcileClusterItems";

const EMPTY_ACTIVE_CLUSTERS: never[] = [];

export const useCreateEdgeInsetClusterElements = (
  midpoints: TrajectoryMidpoint[]
): {
  clusters: ClusterItem[];
  visibleClusterItems: ClusterItem[];
} => {
  const { datasetType } = useSelector((s: RootState) => s.dataset);
  const activeClusterNodes = useSelector(
    (s: RootState) => s.clustering.edgeInsetClusteringResults?.activeClusters ?? EMPTY_ACTIVE_CLUSTERS
  );
  const hierarchyId = useSelector(
    (s: RootState) => s.clustering.edgeInsetClusteringResults?.hierarchyId
  );
  const hierarchySuffix = `::h${hierarchyId ?? 0}`;
  // Budget 0 hides the whole edge pipeline (#261) → skip group building.
  const edgePipelineActive = useSelector(
    (s: RootState) => s.clusterSettings.relationInsetBudget > 0
  );
  // Content version for the midpoint group cache.
  const edgeAnnotationVersion = useSelector((s: RootState) => s.clustering.edgeAnnotationClusterVersion);
  const edgeInsetVersion = useSelector((s: RootState) => s.clustering.edgeInsetClusterVersion);
  const contentVersion = edgeAnnotationVersion * 0x4000000 + edgeInsetVersion;

  const [clusterItems, setClusterItems] = useState<ClusterItem[]>([]);
  const prevHierarchyId = useRef(hierarchyId);
  const prevDatasetType = useRef(datasetType);
  const shouldForceSeedRef = useRef(false);

  useEffect(() => {
    // relationInsetBudget = 0 hides the whole edge pipeline (#261) — skip
    // building groups entirely (the pseudo-point mapping over big midpoint
    // memberships showed at 11.5% of 1M interaction CPU with budget 0).
    // Cut-driven groups (issue #315 phase C1b2) — leaf ranges instead of a
    // full-midpoint filter+groupBy; legacy path stays as the fallback.
    const cutDriven = edgePipelineActive
      ? buildMidpointGroupsFromActiveClusters(activeClusterNodes, hierarchyId, contentVersion)
      : null;
    // Issue #315 plan G0: skip the O(midpoints) fallback during the one-tick
    // server-cut hierarchy race — see useCreateInsetClusterElements. Budget 0
    // must NOT skip (it clears items via the empty groups below).
    if (edgePipelineActive && cutDriven === null && isServerCutActive()) return;
    const grouped = !edgePipelineActive
      ? ({} as Record<string, TrajectoryMidpoint[]>)
      : cutDriven ??
        groupBy(
          midpoints.filter((m) => m.clusterId && m.clusterId !== "noise"),
          (m) => m.clusterId!
        );
    const groups: Record<string, DataPoint[]> = {};
    for (const [id, arr] of Object.entries(grouped)) {
      // Pseudo-point arrays are cached by the (cached) midpoint array's
      // identity, so unchanged clusters reuse instances and reconcile's
      // pairwise fast path fires.
      groups[id] = mapMidpointsToPseudoPoints(arr);
    }
    const resetAll =
      hierarchyId !== prevHierarchyId.current ||
      datasetType !== prevDatasetType.current;
    shouldForceSeedRef.current = resetAll;
    setClusterItems((prev) =>
      reconcileClusterItems(prev, groups, {
        kind: "edge",
        type: VisualElementType.Inset,
        datasetType,
        resetAll,
        idSuffix: hierarchySuffix,
      })
    );
    prevHierarchyId.current = hierarchyId;
    prevDatasetType.current = datasetType;
  }, [midpoints, datasetType, hierarchyId, hierarchySuffix, activeClusterNodes, contentVersion, edgePipelineActive]);

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

  const visibleClusterItems = useMemo(() => {
    const activeMap = new Map(activeClusterNodes.map((c) => [c.uid, c] as const));
    return clusterItems
      .filter(({ element }) => activeMap.has(parseClusterUid(element.id)))
      .map((item) => ({
        ...item,
        cluster: activeMap.get(parseClusterUid(item.element.id))!,
      }));
  }, [clusterItems, activeClusterNodes]);

  return { clusters: clusterItems, visibleClusterItems };
};
