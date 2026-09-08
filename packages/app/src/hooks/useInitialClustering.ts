// src/hooks/useInitialClustering.ts

import * as d3 from "d3";
import type { MutableRefObject, RefObject } from "react";
import { useEffect, useRef } from "react";
import { useDataRef } from "../contexts/DataContext";
import { useTrajectoryMidpointRTreeVersion } from "../contexts/TrajectoryMidpointRTreeContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import { updateTrajectoryMidpointDoIs } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident, ensureResidentRows, isLazyRowArray } from "../dataPreprocessing/lazyRows";
import { updateEdgeColumnDois, type SegmentColumns } from "../dataPreprocessing/splineColumns";
import { bumpClusteringEpoch, isCurrentClusteringEpoch, runHdbscanClusteringWithStatus, runTrajectoryMidpointClusteringWithStatus, wasMidpointFitRunFor } from "../clustering/hdbscanClustering";
import { resolveCutProvider } from "@scaling";
import store from "../store";
import { bootParentIdFor } from "../utils/progressApi";
import type { PrecomputedHdbscanResult } from "./useFullSelectionHdbscanInstance";

/** Idle scheduling for the R3d deferred block: after the static-frame first
 * inset applies, residency + the classic marking pass run when the main
 * thread quiets (bounded so a busy tab cannot starve it forever). */
const scheduleIdle = (fn: () => void): void => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => fn(), { timeout: 1000 });
    return;
  }
  setTimeout(fn, 0);
};

interface UseInitialClusteringParams {
  segmentsRef: MutableRefObject<SegmentColumns | null>;
  canvasContainerRef: RefObject<HTMLDivElement>;
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null;
  /**
   * The current dataset array (null while a swap is in flight). Guards the
   * effect from clustering stale dataRef contents mid-swap.
   */
  internalData: unknown[] | null;
  /**
   * The raw (not yet rehydrated) precomputed hierarchy JSON. When present but
   * fullSelectionHdbscan hasn't been rehydrated yet, this pass waits for the
   * rehydrated tree instead of kicking off a redundant worker fit.
   */
  internalHdbscan: unknown;
  /** Same wait-for-rehydration gate for the midpoint hierarchy. */
  internalMidpointHdbscan: unknown;
  fullSelectionHdbscan: PrecomputedHdbscanResult | undefined;
  fullSelectionMidpointHdbscan: PrecomputedHdbscanResult | undefined;
  performZoomClustering: () => void;
  /**
   * When true (deep link carrying a selection), this pass is skipped entirely:
   * the deep-link replay runs the same clustering functions with the correct
   * DoI seeds and acts as the initial clustering. Running both races — this
   * effect re-fires on late HDBSCAN arrivals, re-selects every node, and its
   * epoch bump aborts the replay's clustering.
   */
  skip?: boolean;
}

export function useInitialClustering({
  segmentsRef,
  canvasContainerRef,
  scales,
  internalData,
  internalHdbscan,
  internalMidpointHdbscan,
  fullSelectionHdbscan,
  fullSelectionMidpointHdbscan,
  performZoomClustering,
  skip = false,
}: UseInitialClusteringParams): void {
  const dataRef = useDataRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();
  // Midpoints are (re)built asynchronously after a dataset lands; the version
  // bump when they arrive re-fires this effect so the midpoint pass runs over
  // the real midpoints, not the empty placeholder cleared at swap time.
  const { version: midpointsVersion } = useTrajectoryMidpointRTreeVersion();
  // Inputs of the last *completed* node/midpoint pass. Re-fires only re-run
  // the pass whose inputs actually changed — e.g. midpoints arriving late must
  // not re-fit the (possibly expensive, worker-computed) node clustering.
  const lastNodeRunRef = useRef<{ data: unknown; hdbscan: unknown; scales: unknown } | null>(null);
  const lastMidpointRunRef = useRef<{ data: unknown; midpoints: unknown; hdbscan: unknown } | null>(null);

  useEffect(() => {
    if (skip) return;
    // only proceed if we have data, scales, and a container. A missing
    // fullSelectionHdbscan is NOT a bail-out: datasets without a precomputed
    // hierarchy (drag & drop, in-app re-projection) fall through to
    // runHdbscanClustering's worker-fit path.
    if (
      !internalData ||
      internalData.length === 0 ||
      !dataRef.current.length ||
      !scales ||
      !canvasContainerRef.current
    ) {
      return;
    }
    // Precomputed hierarchy exists but hasn't been rehydrated yet — the
    // effect re-fires when it lands; fitting now would be redundant work.
    if (internalHdbscan && !fullSelectionHdbscan) return;

    const midpoints = trajectoryMidpointsRef.current;
    const lastNode = lastNodeRunRef.current;
    // `scales` is a READINESS guard (the effect re-fires when they become
    // available), NOT a change trigger: clustering is data-space, and a
    // scales identity change alone (canvas resize; the dataset-SWITCH base
    // install calling setScales) must not re-cluster the CURRENT data — at
    // switch time that resurrected the old dataset's actives right after
    // the switch cleared them (issue #315 round 4), and it also reset every
    // node's DoI/selection on a mere resize.
    const nodesChanged =
      !lastNode ||
      lastNode.data !== internalData ||
      lastNode.hdbscan !== fullSelectionHdbscan;
    // The midpoint pass waits for its precomputed tree like the node pass above.
    const midpointTreePending = Boolean(internalMidpointHdbscan) && !fullSelectionMidpointHdbscan;
    const lastMidpoint = lastMidpointRunRef.current;
    const midpointsChanged =
      !midpointTreePending &&
      // The lazy midpoint build (issue #315 B2) bumps the R-tree version
      // DURING the fit it feeds, re-firing this effect with the freshly
      // built array — a fit over exactly this input is already live, so
      // re-running it would duplicate a possibly worker-seconds fit.
      !wasMidpointFitRunFor(midpoints, fullSelectionMidpointHdbscan) &&
      (!lastMidpoint ||
        lastMidpoint.data !== internalData ||
        lastMidpoint.midpoints !== midpoints ||
        lastMidpoint.hdbscan !== fullSelectionMidpointHdbscan);
    if (!nodesChanged && !midpointsChanged) return;

    const runInitialClustering = () => {
      // Client lazy lane (issue #315 R3d): the rows are holes until after the
      // static-frame first inset, and `forEach` SILENTLY skips holes — the
      // marking pass would mark nothing. It moves into the deferred block
      // below (this whole pass re-runs once residency lands); until then the
      // clustering reads the uniform-1 cols.doi exactly like the server lane.
      const deferMarking =
        !resolveCutProvider(undefined) &&
        isLazyRowArray(dataRef.current) &&
        !areRowsResident(dataRef.current);
      // Client-complete datasets: mark every node selected with full DoI.
      // Server-cut datasets skip the whole O(n) pass (issue #315 A3 P-a) and
      // boot in an implicit uniform revision-0 DoI state instead: cols.doi is
      // already uniform-1 from attachPointColumns, edgeDoi and midpoint DoI
      // have no readers on that path (the A2 index deletion removed the only
      // edgeDoi consumer), and the single doiGroup consumer treats the
      // unwritten ladder as uniformly visible (runHdbscanClustering).
      if (!resolveCutProvider(undefined) && !deferMarking) {
        dataRef.current.forEach((node) => {
          node.selected = true;
          node.DoI = 1;
          node.doiGroup = "inset";
        });

        // update edge DOIs based on nodes
        updateEdgeColumnDois(segmentsRef.current, dataRef.current);
        updateTrajectoryMidpointDoIs(midpoints);
      }

      // perform the two HDBSCAN clusterings
      void (async () => {
        const epoch = bumpClusteringEpoch();
        const parentTaskId = bootParentIdFor(internalData as object);

        if (nodesChanged) {
          // perform a single unified HDBSCAN clustering over all visible nodes
          await runHdbscanClusteringWithStatus(
            dataRef.current,
            fullSelectionHdbscan,
            parentTaskId,
            epoch
          );
          if (!isCurrentClusteringEpoch(epoch)) return;
          lastNodeRunRef.current = { data: internalData, hdbscan: fullSelectionHdbscan, scales };
        }

        if (midpointsChanged) {
          await runTrajectoryMidpointClusteringWithStatus(
            midpoints,
            store.getState().visualizationSettings.annotationDoiThreshold,
            fullSelectionMidpointHdbscan,
            parentTaskId,
            epoch
          );
          if (!isCurrentClusteringEpoch(epoch)) return;
          lastMidpointRunRef.current = {
            data: internalData,
            midpoints,
            hdbscan: fullSelectionMidpointHdbscan,
          };
        }

        performZoomClustering();

        // R3d deferred block: the first inset just applied from the static
        // frame — materialize the rows off the critical path, then re-run
        // this whole pass (marking + clustering + zoom). The re-run is a
        // visual no-op by the golden (plan §8.4 R2c); the epoch/array guards
        // drop it when a user interaction or dataset switch got there first
        // (whoever superseded owns the row state then — the local
        // propagation oracle materializes for itself).
        if (deferMarking) {
          const pts = dataRef.current;
          scheduleIdle(() => {
            void (async () => {
              await ensureResidentRows(pts);
              if (dataRef.current !== pts) return;
              if (!isCurrentClusteringEpoch(epoch)) return;
              runInitialClustering();
            })();
          });
        }
      })();
    };

    // Server-cut datasets (issue #315 A3 P-a): the deferPastFirstInput that
    // used to wrap this pass existed for its O(n) DoI marking — deleted
    // above, so the defer dies with it. What remains on the server path is
    // the warm-cut cheap tail (leaf order pre-cached, server walk warm,
    // content pre-seeded — P4), which runs immediately. Datasets without a
    // cut provider (paper build, uploads) run exactly as before.
    runInitialClustering();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canvasContainerRef,
    dataRef,
    scales,
    internalData,
    internalHdbscan,
    internalMidpointHdbscan,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
    trajectoryMidpointsRef,
    midpointsVersion,
    skip,
  ]);
}
