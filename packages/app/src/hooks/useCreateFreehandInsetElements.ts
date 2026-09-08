import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { useDataRef } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { rowAt } from "src/dataPreprocessing/lazyRows";
import { columnsOf, indexOfId } from "src/dataPreprocessing/pointColumns";
import { getSnapshot as layoutGet, schedulePatch } from "src/layout/layoutStore";
import { VisualElementType } from "src/models/VisualElement";
import type { RootState } from "src/store";
import {
    ClusterItem,
    GroupsMap,
    reconcileClusterItems,
} from "./reconcileClusterItems";

/**
 * Builds one inset ClusterItem per freehand lasso, with membership exactly
 * the lassoed points (`freehand.insets` in Redux). Deliberately bypasses the
 * clustering/activation pipeline: unlike useCreateInsetClusterElements, items
 * are NOT filtered against `insetClusteringResults.activeClusters`, so the
 * semantic-zoom cut and the cluster budget can never cull them. Once created
 * they are regular node insets (annealed placement, hull, leader line).
 */
export const useCreateFreehandInsetElements = (): {
  visibleClusterItems: ClusterItem[];
} => {
  const { datasetType } = useSelector((s: RootState) => s.dataset);
  const freehandInsets = useSelector((s: RootState) => s.freehand.insets);
  const dataRef = useDataRef();

  const [clusterItems, setClusterItems] = useState<ClusterItem[]>([]);
  const prevDatasetType = useRef(datasetType);
  const shouldForceSeedRef = useRef(false);

  useEffect(() => {
    const groups: GroupsMap = {};
    // The id→point map is O(dataset) — 143 ms at 1M per effect run (issue
    // #315 F1) — so it is built ONLY when there are insets to resolve;
    // the empty case (freehand mode toggles, boot, clears) skips it and
    // reconciles straight to zero groups.
    if (freehandInsets.length > 0) {
      const points = dataRef.current;
      // Resolve members through the id index + the row seam (issue #315 R1b):
      // O(members) rows instead of an O(dataset) id→row map, and the only rows
      // that get built are the ones the insets actually show.
      const indexed = columnsOf(points) !== null;
      const byId = new Map<number, DataPoint>();
      if (!indexed) for (const node of points) byId.set(node.id, node);
      for (const inset of freehandInsets) {
        const members: DataPoint[] = [];
        for (const id of inset.memberIds) {
          let node: DataPoint | undefined;
          if (indexed) {
            const i = indexOfId(points, id);
            node = i === undefined ? undefined : rowAt(points, i);
          } else {
            node = byId.get(id);
          }
          if (node) members.push(node);
        }
        if (members.length) groups[inset.id] = members;
      }
    }

    const resetAll = datasetType !== prevDatasetType.current;
    shouldForceSeedRef.current = resetAll;
    setClusterItems((prev) =>
      reconcileClusterItems(prev, groups, {
        kind: "node",
        type: VisualElementType.Inset,
        datasetType,
        resetAll,
        idSuffix: "::freehand",
      })
    );
    prevDatasetType.current = datasetType;
  }, [datasetType, freehandInsets, dataRef]);

  // Seed layout positions after commit (same pattern as
  // useCreateInsetClusterElements — no render-phase updates).
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

  return { visibleClusterItems: clusterItems };
};
