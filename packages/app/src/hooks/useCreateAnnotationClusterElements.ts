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

// Stable reference so `|| []` fallbacks don't produce new arrays on every selector run.
const EMPTY_ACTIVE_CLUSTERS: never[] = [];

export const useCreateAnnotationClusterElements = (
  annotationNodes: DataPoint[]
): {
  clusters:            ClusterItem[];
  visibleClusterItems: ClusterItem[];
} => {
  const { datasetType } = useSelector((s: RootState) => s.dataset);
  const activeClusterNodes = useSelector(
    (s: RootState) =>
      s.clustering.annotationClusteringResults?.activeClusters ?? EMPTY_ACTIVE_CLUSTERS
  );
  const hierarchyId = useSelector(
    (s: RootState) => s.clustering.annotationClusteringResults?.hierarchyId
  );
  const hierarchySuffix = `::h${hierarchyId ?? 0}`;
  // Content version for the group cache — see useCreateInsetClusterElements.
  const annotationVersion = useSelector((s: RootState) => s.clustering.annotationClusterVersion);
  const insetVersion = useSelector((s: RootState) => s.clustering.insetClusterVersion);
  const contentVersion = annotationVersion * 0x4000000 + insetVersion;

  const [clusterItems, setClusterItems] = useState<ClusterItem[]>([]);

  const prevHierarchyId    = useRef(hierarchyId);
  const prevDatasetType    = useRef(datasetType);
  const shouldForceSeedRef = useRef(false);

  useEffect(() => {
    // Cut-driven groups (issue #315 phase C1) — see useCreateInsetClusterElements.
    const cutDriven = buildGroupsFromActiveClusters(activeClusterNodes, hierarchyId, "annotation", contentVersion);
    // Issue #315 plan G0: skip the O(dataset) fallback during the one-tick
    // server-cut hierarchy race — see useCreateInsetClusterElements.
    if (cutDriven === null && isServerCutActive()) return;
    const groups = cutDriven?.groups ?? groupBy(annotationNodes, (n) => n.annotationClusterId ?? "noise");

    const resetAll =
      hierarchyId !== prevHierarchyId.current ||
      datasetType !== prevDatasetType.current;
    shouldForceSeedRef.current = resetAll;
    const precomputedHulls = new Map<string, [number, number][]>();
    for (const c of activeClusterNodes) {
      if (c.precomputedHull?.length) precomputedHulls.set(c.uid, c.precomputedHull);
    }
    setClusterItems((prev) =>
      reconcileClusterItems(prev, groups, {
        kind: "node",
        type: VisualElementType.Annotation,
        datasetType,
        resetAll,
        idSuffix: hierarchySuffix,
        precomputedHulls,
        precomputedCenters: cutDriven?.centers,
      })
    );

    prevHierarchyId.current = hierarchyId;
    prevDatasetType.current = datasetType;
  }, [
    annotationNodes,
    datasetType,
    hierarchySuffix,
    hierarchyId,
    activeClusterNodes,
    contentVersion,
  ]);

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
    if (patch.size) schedulePatch(patch);
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
