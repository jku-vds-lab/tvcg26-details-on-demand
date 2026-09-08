// src/hooks/useLassoSelection.ts

import { resolveCutProvider } from "@scaling";
import * as d3 from "d3";
import type { MutableRefObject } from "react";
import { useCallback } from "react";
import { useDataRef } from "../contexts/DataContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import { updateTrajectoryMidpointDoIs } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf, writeSelectionByIds } from "../dataPreprocessing/pointColumns";
import { updateEdgeColumnDois } from "../dataPreprocessing/splineColumns";
import { applyFreehandDoiBoost } from "../doiPropagation/freehandDoi";
import { runLocalFieldPropagation } from "../doiPropagation/serverPropagation";
import type { RendererAPI } from "../gl/api/RendererAPI";
import { addFreehandInset, replaceFreehandInsets } from "../slices/freehandSlice";
import { setSelectedClusters } from "../slices/labelingSlice";
import type { VisualizationSettings } from "../store";
import store, {
    clearFeatureSearchQuery,
    setSelectedNodes,
} from "../store";
import { createClusterId } from "../types/labeling";
import type { PrecomputedHdbscanResult } from "./useFullSelectionHdbscanInstance";

interface UseLassoSelectionParams {
  rendererRef: MutableRefObject<RendererAPI | null>;
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null;
  zoomTransform: d3.ZoomTransform;
  visualSettings: VisualizationSettings;
  currentSliderSettingsRef: MutableRefObject<import("../components/InterestTabSliders").SliderSettings>;
  performZoomClustering: () => void;
  fullSelectionHdbscan: PrecomputedHdbscanResult | undefined;
  fullSelectionMidpointHdbscan: PrecomputedHdbscanResult | undefined;
  runSelectionWorkflow: (selectedNodeIds: number[], options?: { clearFeatureSearch?: boolean; propagationOverride?: { proximitySlider: number; pastSlider: number; futureSlider: number } }) => Promise<void> | void;
}

// The normal path only reads runSelectionWorkflow; the freehand branch also
// reads the renderer, slider settings, knn graphs, and visual settings. The
// remaining params stay on the interface so the App call site keeps
// documenting what the lasso workflow depends on.
export function useLassoSelection({
  runSelectionWorkflow,
  rendererRef,
  currentSliderSettingsRef,
  visualSettings,
}: UseLassoSelectionParams) {
  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();
  const handleLassoComplete = useCallback(
    async (selectedIds: number[], ctrlKey: boolean, altKey = false) => {
      // Freehand: the lasso becomes exactly one inset (Ctrl adds another
      // separate one). Entered either via the mode toggle (latching) or by
      // holding Alt during the lasso (momentary, that one lasso only).
      // No HDBSCAN, no zoom-cut/budget participation, and no DoI
      // propagation — members get DoI 1 directly; the rest of the DoI
      // distribution is never touched (see applyFreehandDoiBoost).
      if (store.getState().freehand.isFreehandMode || altKey) {
        store.dispatch(
          ctrlKey ? addFreehandInset(selectedIds) : replaceFreehandInsets(selectedIds)
        );

        const nodes = dataRef.current;
        const hasNormalSelection =
          store.getState().selection.selectedNodeIds.length > 0;
        const memberUnion = new Set<number>();
        for (const inset of store.getState().freehand.insets) {
          for (const id of inset.memberIds) memberUnion.add(id);
        }

        const sliders = currentSliderSettingsRef.current;
        const labelingState = store.getState().labeling;
        const labeledNodeIds: Set<string> | undefined =
          labelingState.unlabeledOnlyMode
            ? new Set(labelingState.assignments.keys())
            : undefined;

        if (hasNormalSelection) {
          // Recompute the normal propagated field first so boosts from
          // replaced/removed freehand insets don't linger, then boost the
          // current members on top (still no propagation FROM them). Field
          // lane since #337 PR B — members ride in as pins (the same
          // post-chain DoI-1 clamp the boost below re-asserts).
          await runLocalFieldPropagation(
            nodes,
            {
              proximitySlider: sliders.proximitySlider,
              pastSlider: sliders.pastSlider,
              futureSlider: sliders.futureSlider,
              maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
              grayOutDoiThreshold: sliders.grayOutDoiThreshold,
              annotationDoiThreshold: sliders.annotationDoiThreshold,
              insetDoiThreshold: sliders.insetDoiThreshold,
            },
            undefined,
            { labeledNodeIds, pinnedNodeIds: memberUnion }
          );
        }
        applyFreehandDoiBoost(nodes, memberUnion);
        updateEdgeColumnDois(segmentsRef.current, nodes);
        updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);

        const renderer = rendererRef.current;
        if (renderer) {
          renderer.setOpacityParams({
            threshold: sliders.grayOutDoiThreshold,
            minAlpha: visualSettings.minimumOpacityClamping,
            maxAlpha: visualSettings.maximumOpacityClamping,
          });
          const opacityValues = new Float32Array(nodes.length);
          const opCols = columnsOf(nodes);
          if (!labeledNodeIds && opCols) {
            // Column copy — no per-point DoI accessor calls (issue #315 F1).
            for (let i = 0; i < nodes.length; i++) opacityValues[i] = opCols.doi[i];
          } else {
            for (let i = 0; i < nodes.length; i++) {
              opacityValues[i] = labeledNodeIds?.has(String(nodes[i].id))
                ? 0
                : (nodes[i].DoI ?? 1);
            }
          }
          renderer.setOpacityField(opacityValues);
          renderer.render();
        }

        d3.selectAll(".lasso_path").remove();
        return;
      }

      const currentSelection = store.getState().selection.selectedNodeIds;

      // An empty lasso with nothing selected is a pure no-op (issue #315
      // F1): the previous behavior ran the whole selection workflow —
      // dispatches, O(n) DoI sweeps, recluster — to arrive at the state we
      // are already in (~0.8 s of main-thread churn at 1M).
      if (selectedIds.length === 0 && currentSelection.length === 0 && !ctrlKey) {
        d3.selectAll(".lasso_path").remove();
        return;
      }

      let newSelection: number[];

      if (ctrlKey) {
        const setSel = new Set(currentSelection);
        selectedIds.forEach((id) =>
          setSel.has(id) ? setSel.delete(id) : setSel.add(id)
        );
        newSelection = Array.from(setSel);
      } else {
        newSelection = selectedIds;
      }

      // update Redux + node flags
      store.dispatch(setSelectedNodes(newSelection));
      store.dispatch(clearFeatureSearchQuery());

      // If labeling mode is active, mirror point selections into labeling state.
      const labelingState = store.getState().labeling;
      if (labelingState?.isEnabled) {
        const currentLabelingSelection = Array.from(labelingState.selectedIds).map((id) =>
          String(id)
        );
        const incoming = newSelection.map((id) => String(id));

        let nextLabelingSelection: string[];
        if (ctrlKey) {
          const merged = new Set(currentLabelingSelection);
          incoming.forEach((id) => {
            if (merged.has(id)) {
              merged.delete(id);
            } else {
              merged.add(id);
            }
          });
          nextLabelingSelection = Array.from(merged);
        } else {
          nextLabelingSelection = incoming;
        }

        store.dispatch(
          setSelectedClusters(nextLabelingSelection.map((id) => createClusterId(id)))
        );
      }

      // Set lookup + direct column writes (issue #315 plan F1): the previous
      // `newSelection.includes(node.id)` inside this loop was O(n·|sel|) —
      // 2.8 s of the measured 16 s lasso freeze at 1M — and each `node.DoI =`
      // paid the D2 accessor setter. Semantics unchanged.
      //
      // The DoI half is skipped on the provider path (issue #315 P7 S5): it is
      // a pure duplicate of the marking loop in App's runSelectionWorkflow
      // (same predicate, same values, microseconds later), which ALREADY skips
      // it when the server will answer — so writing 1M seed values here just to
      // have the server field replace them was the second 1M sweep inside the
      // window CS sees as "nothing happens yet". `selected` stays: it is the
      // seed vocabulary for both the server request and the chain clamp.
      {
        const selectionSet = new Set(newSelection);
        const hasSelection = newSelection.length > 0;
        const nodes = dataRef.current;
        const cols = columnsOf(nodes);
        const seedWrite = resolveCutProvider(undefined)?.selectPropagate == null;
        if (cols) {
          // Selection column + index list (issue #315 R1a, §3.1).
          writeSelectionByIds(nodes, newSelection);
          if (seedWrite) {
            const sel = cols.selected;
            for (let i = 0; i < nodes.length; i++) {
              cols.doi[i] = hasSelection ? sel[i] : 1;
            }
          }
        } else {
          for (const node of nodes) {
            node.selected = selectionSet.has(node.id);
            if (seedWrite) node.DoI = hasSelection ? (node.selected ? 1 : 0) : 1;
          }
        }
      }

      try {
        await runSelectionWorkflow(newSelection, { clearFeatureSearch: true });
      } catch (error) {
        console.error("Clustering error:", error);
      }
      d3.selectAll(".lasso_path").remove();
    },
    [
      dataRef,
      runSelectionWorkflow,
      rendererRef,
      currentSliderSettingsRef,
      visualSettings.maxEmbeddingDistance,
      visualSettings.minimumOpacityClamping,
      visualSettings.maximumOpacityClamping,
      segmentsRef,
      trajectoryMidpointsRef,
    ]
  );

  return { handleLassoComplete };
}
