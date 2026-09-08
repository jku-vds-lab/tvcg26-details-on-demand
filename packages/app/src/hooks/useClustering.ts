// src/hooks/useClustering.ts
import * as d3 from "d3";
import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import {
    updateClusteringForZoom as runZoom,
    updateTrajectoryMidpointClusteringForZoom,
} from "../clustering/hdbscanClustering";
import type { ClusterSettings, VisualizationSettings } from "../store";
import store, {
    incrementAnnotationTreeCutVersion,
    incrementEdgeAnnotationTreeCutVersion,
    incrementEdgeInsetTreeCutVersion,
    incrementInsetTreeCutVersion,
} from "../store";
import { useInlineBusy } from "./useInlineBusy";

export function useClustering(
  visualSettings: VisualizationSettings,
  _clusterSettings: ClusterSettings,
  canvasContainerRef: RefObject<HTMLDivElement>,
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null,
  zoomTransform: d3.ZoomTransform
) {
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  const lastClusterIdsRef = useRef<{
    annotation: string[] | null;
    inset: string[] | null;
    edgeAnnotation: string[] | null;
    edgeInset: string[] | null;
  }>({
    annotation: null,
    inset: null,
    edgeAnnotation: null,
    edgeInset: null,
  });

  const performZoomClusteringImpl = useCallback(() => {
    const container = canvasContainerRef.current;
    const currentScales = scales;
    if (!container || !currentScales) {
      // nothing to do until we have both DOM and scales
      return;
    }
    setBusy(true);

    const norm =
      (visualSettings.maxZoom - zoomTransform.k) /
      (visualSettings.maxZoom - visualSettings.minZoom);
    const normalizedFactor = Math.max(0, Math.min(1, norm));

    // runZoom now returns both annotation and inset results from a single unified
    // clustering hierarchy (split by average DoI per cluster).
    const zoomResult = runZoom(normalizedFactor, container, currentScales, zoomTransform);
    const results = {
      annotation: zoomResult?.annotation ?? null,
      inset: zoomResult?.inset ?? null,
    };

    const midpointResults = updateTrajectoryMidpointClusteringForZoom(
      normalizedFactor,
      container,
      currentScales,
      zoomTransform
    );

    (["annotation", "inset"] as const).forEach((group) => {
      const result = results[group];
      if (!result) return;
      // activeUids (issue #315 C1) is the same change signal as the sorted
      // per-feature id list (memberships per uid are immutable), without the
      // O(n log n) sort over up to 1M features per settled tick.
      const newIds =
        result.activeUids ??
        result.clusters.features
          .filter((f) => f.properties?.cluster != null)
          .map((f) => f.properties!.cluster)
          .sort();
      const oldIds = lastClusterIdsRef.current[group];
      const changed =
        !oldIds ||
        oldIds.length !== newIds.length ||
        newIds.some((id, i) => id !== oldIds[i]);

      if (changed) {
        if (group === "annotation") {
          dispatch(incrementAnnotationTreeCutVersion());
        } else {
          dispatch(incrementInsetTreeCutVersion());
        }
        lastClusterIdsRef.current[group] = newIds;
      }
    });

    if (midpointResults) {
      const edgeGroups = {
        edgeAnnotation: midpointResults.annotation,
        edgeInset: midpointResults.inset,
      } as const;
      (["edgeAnnotation", "edgeInset"] as const).forEach((group) => {
        const result = edgeGroups[group];
        const newIds =
          result.activeUids ??
          result.clusters.features
            .filter((f) => f.properties?.cluster != null)
            .map((f) => f.properties!.cluster)
            .sort();
        const oldIds = lastClusterIdsRef.current[group];
        const changed =
          !oldIds ||
          oldIds.length !== newIds.length ||
          newIds.some((id, i) => id !== oldIds[i]);
        if (changed) {
          if (group === "edgeAnnotation") {
            dispatch(incrementEdgeAnnotationTreeCutVersion());
          } else {
            dispatch(incrementEdgeInsetTreeCutVersion());
          }
          lastClusterIdsRef.current[group] = newIds;
        }
      });
    }

    setBusy(false);
  }, [visualSettings, zoomTransform, dispatch, canvasContainerRef, scales]);

  // Keep a stable ref so the subscription always calls the latest function.
  const performZoomClusteringRef = useRef(performZoomClusteringImpl);
  useEffect(() => { performZoomClusteringRef.current = performZoomClusteringImpl; });

  // Public identity is stable across renders (the impl recreates on every
  // settled zoom tick because it closes over zoomTransform). Callers invoke it
  // imperatively; a churning identity only re-created downstream callbacks —
  // e.g. featureSearchDeps re-rendered the whole side panel per tick.
  const performZoomClustering = useCallback(() => {
    performZoomClusteringRef.current();
  }, []);

  // Subscribe directly to the Redux store so that ANY clusterSettings change
  // triggers a re-run. The RAF cancel+reschedule pattern debounces rapid slider
  // events: the computation fires once per quiet period, never synchronously
  // inside an input event handler.
  useEffect(() => {
    let prevSettings = store.getState().clusterSettings;
    let raf: number | null = null;
    const unsubscribe = store.subscribe(() => {
      const next = store.getState().clusterSettings;
      if (next !== prevSettings) {
        prevSettings = next;
        if (raf !== null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          raf = null;
          performZoomClusteringRef.current();
        });
      }
    });
    return () => { unsubscribe(); if (raf !== null) cancelAnimationFrame(raf); };
  }, []); // intentionally empty — subscription lifetime equals hook lifetime

  const isReclustering = useInlineBusy(busy, 200);

  return { performZoomClustering, isReclustering };
}
