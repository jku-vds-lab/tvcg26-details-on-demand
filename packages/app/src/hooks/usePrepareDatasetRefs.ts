// packages/app/src/hooks/usePrepareDatasetRefs.ts
import { resolveCutProvider } from "@scaling";
import rbush from "rbush";
import { useEffect, type MutableRefObject } from "react";
import { useDispatch } from "react-redux";
import { useDataRef } from "../contexts/DataContext";
import { useRTreeReady, useRTreeRef } from "../contexts/RTreeContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";
import { useSegmentsRTreeRef } from "../contexts/SegmentsRTreeContext";
import { useTrajectoryMidpointRTreeRef, useTrajectoryMidpointRTreeVersion } from "../contexts/TrajectoryMidpointRTreeContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import {
    DataPoint,
    RTreeItem,
    TrajectoryMidpoint,
} from "../dataPreprocessing/dataPreprocessing";
import {
    collectFeatureMetadataChunked,
    collectFeatureMetadataSync,
    FEATURE_PRELIMINARY_BATCH_ROWS,
    FEATURE_PRELIMINARY_SCAN_ROWS,
    FEATURE_SCAN_BATCH_POINTS,
    MAX_POINTS_TO_SCAN,
    yieldToIdleOrFrame,
} from "../dataPreprocessing/featureScan";
import {
    fetchServerFeatureStats,
    mergeServerFeatureStats,
    mergeStaticFeatureStats,
    resolveFeatureStatsBaseUrl,
    staticFeatureStatsFor,
} from "../dataPreprocessing/featureStatsClient";
import { buildPointGridIndexChunked } from "../dataPreprocessing/pointGridIndex";
import { EdgeSegmentIndex } from "../dataPreprocessing/segmentIndex";
import {
    attachSegmentPointState,
    computeCompactColumnsForPoints,
    edgeCenterAt,
    updateEdgeColumnDois,
    type SegmentColumns,
} from "../dataPreprocessing/splineColumns";
import { hasValidatedIds, sidecarColumnsFor } from "../dataPreprocessing/columnSidecar";
import {
    deferredColumnEntry,
    deferredColumnNames,
} from "../dataPreprocessing/lazyColumns";
import { registerTrajectoryMidpointsBuilder } from "../dataPreprocessing/lazyTrajectoryMidpoints";
import { resetGroupClusterUids } from "../clustering/groupClusterUid";
import { hasStaticBootFrame } from "../semanticZoom/staticBootFrame";
import { attachPointColumns, columnsOf } from "../dataPreprocessing/pointColumns";
import { clearFeatureMetadata, clearMissingColorEncoding, setAnnotationLabelFeature, setAnnotationTagDelimiter, setFeatureMetadataProvisional, setTfIdfLabels } from "../store";
import { markDatasetLoadPhase } from "../utils/datasetLoadInstrumentation";
import {
  areRowsResident,
  ensureResidentRows,
  isLazyRowArray,
  whenRowsResident,
} from "../dataPreprocessing/lazyRows";
import { ensureResidentRowsWithChip } from "../utils/rowResidency";
import { bootParentIdFor, completeTask, failTask, startTask, updateTask } from "../utils/progressApi";

const MIDPOINT_BUILD_BATCH_EDGES = 2500;

const yieldToMainThread = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

function ensurePointsInitializedInPlace(points: DataPoint[]): DataPoint[] {
  // Born-column-backed rows have nothing to initialize (issue #315 R1a, A6):
  // `selected` and `DoI` are accessor-backed columns that already read
  // false/1, and `nextEdgeCenter` lives in the edge-center column since A3 —
  // so the whole per-point pass is a no-op that used to cost ~3M writes (and
  // ~1M center objects) at synth1m. The own-property shape downstream
  // enumerations expect is unchanged: both fields are enumerable accessors on
  // the shared row prototype.
  const born = columnsOf(points) !== null;

  // Prep-time id validation (issue #315 B2): rows stamped by the manifest
  // (`dataColumns.idsValidated`) carry unique finite integer ids by
  // contract, so the two O(N) scan loops below run only on the fallback
  // lane (JSON chunks, CSV, uploads).
  if (hasValidatedIds(points)) {
    if (!born) {
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        p.selected = false;
        if (p.DoI === undefined || p.DoI === null) p.DoI = 1;
        p.nextEdgeCenter = p.nextEdgeCenter ?? { x: 0, y: 0 };
      }
    }
    attachPointColumns(points, sidecarColumnsFor(points));
    return points;
  }

  const seenIds = new Set<number>();
  let nextNodeId = 0;

  // Compute max ID first if any IDs exist, so generated IDs don't collide
  for (let i = 0; i < points.length; i++) {
    const rawId = (points[i] as { id?: unknown }).id;
    if (typeof rawId === "number" && Number.isFinite(rawId) && Number.isInteger(rawId)) {
      nextNodeId = Math.max(nextNodeId, rawId + 1);
    }
  }

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const rawId = (p as { id?: unknown }).id;

    // If ID is missing, generate one (for legacy datasets without IDs)
    if (rawId === undefined || rawId === null) {
      p.id = nextNodeId++;
    } else if (typeof rawId !== "number" || !Number.isFinite(rawId) || !Number.isInteger(rawId)) {
      // If ID is explicitly provided but invalid, throw error
      throw new Error(
        `Invalid point id at index ${i}: expected a finite integer, got ${String(rawId)}`
      );
    } else {
      // ID is valid, use it
      if (seenIds.has(rawId)) {
        throw new Error(`Duplicate point id detected: ${rawId}`);
      }
      seenIds.add(rawId);
      p.id = rawId;
    }

    if (!born) {
      p.selected = false;
      if (p.DoI === undefined || p.DoI === null) p.DoI = 1;
      p.nextEdgeCenter = p.nextEdgeCenter ?? { x: 0, y: 0 };
    }
  }
  // Columnar point model (issue #315 D2): typed-array columns + the DoI
  // accessor single-write-surface, attached in the same load-time pass.
  // Sidecar-direct (issue #315 B1): points materialized from a binary sidecar
  // adopt its typed views as the columns instead of re-reading every object.
  attachPointColumns(points, sidecarColumnsFor(points));
  return points;
}

/**
 * One midpoint per edge, built from the columnar geometry. Midpoints stay
 * JS objects (~one per point pair) carrying live endpoint refs so the DoI
 * recompute path (updateTrajectoryMidpointDoIs) is unchanged.
 */
async function buildTrajectoryMidpointsFromColumnsChunked(
  points: DataPoint[],
  cols: SegmentColumns,
  signal?: AbortSignal
): Promise<TrajectoryMidpoint[]> {
  // Midpoints hold ROW references (startPoint/endPoint identity feeds the
  // reconcile Sets), so this build is a genuine full-array row consumer — on
  // a lazy array the slot reads below would silently `continue` past every
  // hole (issue #315 R3d). Row contract §3.2: take the one residency entry.
  // No-op on resident/classic arrays; the boot path never reaches here with
  // the default relationInsetBudget of 0.
  await ensureResidentRows(points, { signal });
  const midpoints: TrajectoryMidpoint[] = [];
  let id = 0;

  for (let start = 0; start < cols.edgeCount; start += MIDPOINT_BUILD_BATCH_EDGES) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(cols.edgeCount, start + MIDPOINT_BUILD_BATCH_EDGES);
    for (let e = start; e < end; e++) {
      const startPoint = points[cols.edgeStart[e]];
      const endPoint = points[cols.edgeEnd[e]];
      if (!startPoint || !endPoint) continue;
      // Edge-center column first (issue #315 R1a, A3), then the row's own
      // value (legacy/shipped lanes), then the chord fallback.
      const center = edgeCenterAt(cols, e, points, startPoint);

      midpoints.push({
        id: id++,
        midPoint: { x: center.x, y: center.y },
        startPoint,
        endPoint,
        action: startPoint.action,
        DoI: 0.5 * ((startPoint.DoI ?? 0) + (endPoint.DoI ?? 0)),
      });
    }
    await yieldToMainThread();
  }

  return midpoints;
}

/**
 * A search-only midpoint R-tree facade that builds on FIRST query (issue
 * #315 boot). `.search` is the sole method the one consumer
 * (ClusterVisualizations' midpointItemsInView) calls; range-live datasets
 * never call it, so 1M-scale boots skip the ~1M-item bulk load entirely.
 */
function lazyMidpointRTree(
  midpoints: TrajectoryMidpoint[]
): rbush<RTreeItem<TrajectoryMidpoint>> {
  let built: rbush<RTreeItem<TrajectoryMidpoint>> | null = null;
  const build = () => {
    if (built) return built;
    built = new rbush<RTreeItem<TrajectoryMidpoint>>();
    const items: Array<RTreeItem<TrajectoryMidpoint>> = new Array(midpoints.length);
    for (let i = 0; i < midpoints.length; i++) {
      const m = midpoints[i];
      items[i] = {
        minX: m.midPoint.x,
        minY: m.midPoint.y,
        maxX: m.midPoint.x,
        maxY: m.midPoint.y,
        data: m,
      };
    }
    built.load(items);
    return built;
  };
  const facade = {
    search: (box: { minX: number; minY: number; maxX: number; maxY: number }) =>
      build().search(box),
  };
  return facade as unknown as rbush<RTreeItem<TrajectoryMidpoint>>;
}

/**
 * @param segmentColumns The dataset's resident columnar geometry (built by
 *   the loaders). Null when the dataset shipped none — legacy CSV rows and
 *   in-app reprojection — in which case the columns are derived here from
 *   point x/y + line order (the successor of the old main-thread getSpline
 *   fallback, same cost profile).
 */
export function usePrepareDatasetRefs(
  internalData: DataPoint[] | null,
  segmentColumns: SegmentColumns | null = null,
  /** Annealer reheat hook (issue #315 R2b): fired when the real spatial
   * indexes install after a static-bootFrame mount degate, so the layout
   * the annealer settled against the frontier approximation gets corrected
   * instead of frozen. */
  reheatRef?: MutableRefObject<() => void>
): void {
  const dispatch = useDispatch();
  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const rTreeRef = useRTreeRef();
  const { setReady: setRTreeReady } = useRTreeReady();
  const segmentsRTreeRef = useSegmentsRTreeRef();
  const trajectoryMidpointRTreeRef = useTrajectoryMidpointRTreeRef();
  const { bumpVersion: bumpMidpointRTreeVersion } = useTrajectoryMidpointRTreeVersion();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();

  useEffect(() => {
    if (!internalData || internalData.length === 0) return;

    const prepTaskId = `dataset-prepare-refs:${Date.now()}`;
    const abort = new AbortController();

    // Server-cut datasets build NO client spatial interaction indexes
    // (issue #315 A2): the lasso hit-test is a server query (POST
    // /v1/select, linear-scan fallback), viewport/membership queries are
    // range-live, and the annealer's density term reads the cut frontier.
    // Edge DoI is also skipped on server-cut (issue #315 B2): its single
    // reader is EdgeSegmentIndex.filtered, which the A2 deletion already
    // removed on that path. The midpoints build is lazy-on-first-consumer
    // (see registerTrajectoryMidpointsBuilder below) on EVERY path — with
    // the default relationInsetBudget of 0 no consumer ever needs it.
    const serverCut = Boolean(resolveCutProvider(undefined));

    // Refs mount degate on static-bootFrame datasets (issue #315 R2b): the
    // first inset frame comes from the prep-time artifact, not from a
    // spatial query, and every client-lane consumer is already
    // null-tolerant (A2 legacy) — the annealer's density term falls to the
    // frontier index (fed by exactly the static frame's actives), lasso
    // falls to the linear scan (boot-window only, accepted), nodesInView
    // is guarded. So readiness can flip immediately, like the server-cut
    // branch below, while the indexes build in the background and install
    // as today.
    const staticFrameBoot = !serverCut && hasStaticBootFrame(internalData);

    // Fast path first: populate render-critical refs immediately so viewer can
    // start streaming without waiting for heavy spatial indices.
    markDatasetLoadPhase("refs:fast-path");
    const pts = ensurePointsInitializedInPlace(internalData);
    dataRef.current = pts;

    // Midpoints belong to the previous dataset until a consumer builds new
    // ones — clear synchronously so load-time clustering can't worker-fit
    // stale midpoints (multi-second bar on dataset switch). Same for the
    // cluster-uid group index (issue #315 R1a step 5).
    resetGroupClusterUids();
    trajectoryMidpointsRef.current = [];
    trajectoryMidpointRTreeRef.current = new rbush<RTreeItem<TrajectoryMidpoint>>();
    bumpMidpointRTreeVersion();

    // Synchronous micro-scan (~200 rows, no awaits): populates feature keys and
    // rough types immediately so the color-encoding dropdown is usable before
    // any async work begins. The result's key set also scopes the server
    // feature-stats intersection below (slim client vs. fat server columns).
    markDatasetLoadPhase("refs:feature-metadata:provisional");
    const microScan = collectFeatureMetadataSync(pts);
    // Deferred columns (issue #315 R3c): manifest-declared names live as
    // prototype accessors, invisible to the own-key micro-scan — merge them
    // from the declaration so discovery (color-encoding dropdown, preset
    // validation, and the SERVER-stats intersection scoping below) treats
    // them as this dataset's columns. Types come from the manifest; the
    // static-artifact / server merges refine the stats moments later.
    for (const name of deferredColumnNames(pts)) {
      if (microScan.statsByKey[name] !== undefined) continue;
      const cats = deferredColumnEntry(pts, name)?.categories;
      microScan.availableKeys.push(name);
      microScan.statsByKey[name] = {
        key: name,
        variableType: cats ? "categorical" : "unknown",
        uniqueCount: cats?.length ?? 0,
        totalCount: pts.length,
        numericRatio: cats ? 0 : 1,
        confidence: "provisional",
      };
    }
    dispatch(setFeatureMetadataProvisional(microScan));
    // Preset validation (issue #315 color-by UX): a visual preset may name a
    // column this dataset simply lacks ("algo" on synth1m) — clear it so the
    // panel doesn't show a selected feature that colors nothing. Micro-scan
    // keys are final for this purpose: later metadata dispatches (server
    // stats merge, chunked scans) only refine stats, never shrink the set.
    dispatch(clearMissingColorEncoding(microScan.availableKeys));

    let cols = segmentColumns;
    if (!cols && pts.length > 1) {
      // Fallback derivation (legacy CSV / reprojection): compact columns —
      // edge enumeration only, geometry stays virtual (issue #315 phase B2).
      cols = computeCompactColumnsForPoints(pts);
      // Point state (nextEdgeCenter) — sync until its first await since no
      // export copy is requested. Column-backed rows keep their centers in the
      // edge column (issue #315 R1a, A3); everything else keeps the row pass.
      void attachSegmentPointState(pts, cols, { centersInto: "column" });
    }
    segmentsRef.current = cols;

    // Lazy midpoints (issue #315 B2): the ~one-object-per-edge build moved
    // off the boot path entirely — it was the dominant post-settle CPU tail
    // at 1M, and with the default relationInsetBudget of 0 nothing consumes
    // it. The midpoint clustering fit (the choke point every consumer path
    // funnels through) triggers this builder on first need; it installs the
    // refs + lazy R-tree and bumps the version, exactly like the eager
    // completion used to.
    const capturedCols = cols;
    registerTrajectoryMidpointsBuilder(async () => {
      const mids = capturedCols
        ? await buildTrajectoryMidpointsFromColumnsChunked(pts, capturedCols, abort.signal)
        : [];
      if (abort.signal.aborted) return [];
      trajectoryMidpointsRef.current = mids;
      trajectoryMidpointRTreeRef.current = lazyMidpointRTree(mids);
      bumpMidpointRTreeVersion();
      markDatasetLoadPhase("refs:midpoints:lazy-built");
      return mids;
    });

    // ONE loading line (issue #315 Arc 1 Task 3b): every boot compute task
    // groups under the per-load parent, so the dock shows a single card.
    const bootParentId = bootParentIdFor(internalData as object);
    startTask({
      id: prepTaskId,
      label: "Preparing interactions",
      kind: "compute",
      phase: "Indexing points…",
      value: 0,
      progressMode: "predictive",
      minShowMs: 200,
      parentId: bootParentId,
    });

    let finalized = false;

    // ── Feature analysis: runs in parallel with indexing ────────────────────
    // Feature metadata doesn't depend on spatial indices, so there's no reason
    // to sequence it after them. Starting here means the snackbar appears and
    // disappears during initial load, not after the user thinks everything is done.
    void (async () => {
      const featureTaskId = `${prepTaskId}:features`;
      // Task 3b (#315): the bar starts only when the LOCAL scan actually
      // runs. Work that moved server-side (GET /v1/feature-stats resolves in
      // ~1 s) must not surface a bar at all — not even a flash.
      let featureBarStarted = false;
      const startFeatureBar = () => {
        if (featureBarStarted) return;
        featureBarStarted = true;
        startTask({
          id: featureTaskId,
          label: "Analyzing features",
          kind: "compute",
          phase: "Scanning dataset fields…",
          value: 0,
          minShowMs: 200,
          progressMode: "predictive",
          parentId: bootParentId,
        });
      };
      try {
        // Static artifact fast path (issue #315 B2): a manifest-declared
        // feature-stats file was registered by the loader — no scan, no bar.
        // UNION merge (issue #315 B3): the artifact describes exactly the
        // loaded records, so its keys are kept wholesale (the intersecting
        // server merge would drop columns that are null in the micro-scan
        // sample, e.g. chess board squares); local-only runtime keys (DoI)
        // are appended from the micro-scan.
        const staticStats = staticFeatureStatsFor(pts);
        if (staticStats) {
          dispatch(setFeatureMetadataProvisional(mergeStaticFeatureStats(staticStats, microScan)));
          return;
        }

        // Server fast path (issue #315 slim datasets): when a backend is active
        // and its /health advertises featureStats, fetch the per-column stats
        // instead of scanning up to 20k rows. Falls through to the local scan
        // below on no backend / health-not-ready / any error (the public build's
        // @scaling stub resolves no backend, so this is inert and byte-identical
        // there). Abort surfaces as a thrown AbortError, handled by the catch.
        const statsBaseUrl = resolveFeatureStatsBaseUrl();
        if (statsBaseUrl) {
          const result = await fetchServerFeatureStats(statsBaseUrl, abort.signal);
          if (abort.signal.aborted) return;
          if (result.kind === "stats") {
            // Merge with the LOCAL micro-scan: server stats win for shared
            // keys, server-only FAT columns (board fields, pixels) are
            // dropped, and client-runtime columns the server never sees
            // (DoI) survive with their micro-scan stats.
            const merged = mergeServerFeatureStats(result.payload, microScan);
            dispatch(setFeatureMetadataProvisional(merged));
            return; // Server stats are authoritative — skip both scan phases (no bar).
          }
        }

        // Local scan fallback ⇒ rows on demand (issue #315 R1b, row contract
        // §3.3): both scan phases read own-enumerable keys off real row
        // objects, so this is the one boot path that has to un-lazy the array.
        // Reached only when neither the static artifact nor the server stats
        // answered — on the classic lane areRowsResident is already true and
        // nothing happens.
        await ensureResidentRowsWithChip(pts, "Preparing rows", abort.signal);
        if (abort.signal.aborted) return;

        // Phase 1: 0–2k rows, fast batches + setTimeout yields, visible snackbar.
        startFeatureBar();
        markDatasetLoadPhase("refs:feature-metadata:preliminary");
        const phase1 = await collectFeatureMetadataChunked(pts, {
          fromRow: 0,
          toRow: FEATURE_PRELIMINARY_SCAN_ROWS,
          batchSize: FEATURE_PRELIMINARY_BATCH_ROWS,
          confidence: "preliminary",
          yieldFn: yieldToMainThread,
          signal: abort.signal,
          onProgress: (pct) => updateTask({ id: featureTaskId, phase: "Scanning dataset fields…", value: Math.min(99, pct) }),
        });
        if (abort.signal.aborted) return;

        // Destructure to keep resume (Maps/Sets) out of the Redux action payload.
        const { availableKeys: keys1, statsByKey: stats1, resume } = phase1;
        dispatch(setFeatureMetadataProvisional({ availableKeys: keys1, statsByKey: stats1 }));
        updateTask({ id: featureTaskId, phase: "Feature analysis ready", value: 100 });
        completeTask(featureTaskId);

        // Phase 2: 2k–20k rows, idle-priority batches, no snackbar.
        // setFeatureMetadataProvisional preserves any type overrides the user set
        // during Phase 1.
        if (pts.length > FEATURE_PRELIMINARY_SCAN_ROWS) {
          markDatasetLoadPhase("refs:feature-metadata:full");
          const phase2 = await collectFeatureMetadataChunked(pts, {
            fromRow: FEATURE_PRELIMINARY_SCAN_ROWS,
            toRow: MAX_POINTS_TO_SCAN,
            batchSize: FEATURE_SCAN_BATCH_POINTS,
            confidence: "high",
            yieldFn: yieldToIdleOrFrame,
            signal: abort.signal,
            resume,
          });
          if (abort.signal.aborted) return;
          const { availableKeys: keys2, statsByKey: stats2 } = phase2;
          dispatch(setFeatureMetadataProvisional({ availableKeys: keys2, statsByKey: stats2 }));
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error("Failed to analyze features", error);
          if (featureBarStarted) failTask(featureTaskId, "Feature analysis failed");
        }
      }
    })();

    // ── Spatial indexing: the three remaining phases run in parallel ────────
    // Point R-tree, segment R-tree, and edge DoI are mutually independent —
    // they only need pts/segs, both already built synchronously.
    // Safety note: updateEdgeColumnDois writes the edgeDoi column; the edge
    // R-tree reads only bounding-box coordinates (x0/y0/x1/y1) — no overlap.
    // The midpoints build left this block entirely (issue #315 B2) — it is
    // lazy-on-first-consumer via registerTrajectoryMidpointsBuilder above.
    void (async () => {
      try {
        // Client lazy lane (issue #315 R3d): the grid build walks row x/y and
        // EdgeSegmentIndex samples virtual spline geometry through row
        // indices — both undefined on a holey array. Wait for the residency
        // the deferred clustering block schedules after first inset, WITHOUT
        // triggering it (the whole point is keeping materialization off the
        // boot window). Never on server-cut: rows stay lazy forever there,
        // and the branches below are skipped on that lane anyway.
        if (!serverCut && isLazyRowArray(pts) && !areRowsResident(pts)) {
          await whenRowsResident(pts);
          if (abort.signal.aborted) return;
        }
        markDatasetLoadPhase("refs:index:parallel");

        // Weighted per-branch progress drives the single task bar.
        const branchPct = { points: 0, segs: 0, doi: 0 };
        const W = { points: 0.4, segs: 0.4, doi: 0.2 };
        const reportBranchDone = (branch: keyof typeof branchPct) => {
          branchPct[branch] = 100;
          const combined =
            branchPct.points * W.points +
            branchPct.segs   * W.segs   +
            branchPct.doi    * W.doi;
          updateTask({ id: prepTaskId, phase: "Indexing data structures…", value: Math.min(99, combined) });
        };

        const [ptTree, segTree] = await Promise.all([
          // Branch 1: point spatial index. A uniform grid, not an rbush: the
          // rbush OMT bulk load is an un-chunkable synchronous pass that cost
          // seconds at 1M (issue #315). Consumers call only .search/.all.
          // Skipped for server-cut datasets (issue #315 A2, see above).
          (serverCut
            ? Promise.resolve(null)
            : buildPointGridIndexChunked(pts, abort.signal))
            .then((t) => { reportBranchDone("points"); return t; }),

          // Branch 2: edge spatial index (39k-item rbush over edges; the
          // per-segment refinement happens at query time from the columns).
          Promise.resolve()
            .then(() => (cols && !serverCut ? new EdgeSegmentIndex(cols, pts) : null))
            .then((t) => { reportBranchDone("segs"); return t; }),

          // Branch 3: edge DoI column (one Float32 per edge). Skipped on
          // server-cut (issue #315 B2): its only reader is the
          // EdgeSegmentIndex branch 2 skips on that path.
          Promise.resolve()
            .then(() => { if (!serverCut) updateEdgeColumnDois(cols, pts); })
            .then(() => reportBranchDone("doi")),
        ]);
        if (abort.signal.aborted) return;

        rTreeRef.current = ptTree;
        setRTreeReady(true);
        segmentsRTreeRef.current = segTree;
        if (staticFrameBoot) {
          // Guard 2 of the R2b degate: the annealer settled against the
          // frontier approximation while the trees were null — reheat so
          // the real indexes correct that layout instead of freezing it.
          reheatRef?.current();
        }
        updateTask({ id: prepTaskId, phase: "Interaction indices ready", value: 100 });

        finalized = true;
        markDatasetLoadPhase("refs:complete");
        completeTask(prepTaskId);
      } catch (error) {
        if (!abort.signal.aborted) {
          console.error("Failed to prepare dataset refs", error);
          failTask(prepTaskId, "Failed to prepare viewer indices");
        }
      }
    })();

    if (serverCut) {
      // Mount de-gate (issue #315 A2): no interaction indexes are coming —
      // clear any stale previous-dataset trees and flip readiness NOW so
      // the annotation layer mounts as soon as the first cut lands, while
      // the surviving branches (edge DoI, midpoints) finish in background.
      rTreeRef.current = null;
      segmentsRTreeRef.current = null;
      markDatasetLoadPhase("refs:server-cut:degated");
      setRTreeReady(true);
    } else if (staticFrameBoot) {
      // R2b degate, guard 1 (MANDATORY): null the PREVIOUS dataset's trees
      // before flipping, or the viewport memo builds a DoI-filtered view
      // over the old dataset's grid. The real indexes install above when
      // the background build lands (guard 2 reheats there).
      rTreeRef.current = null;
      segmentsRTreeRef.current = null;
      markDatasetLoadPhase("refs:static-frame:degated");
      setRTreeReady(true);
    } else {
      setRTreeReady(false);
    }
    return () => {
      abort.abort();
      registerTrajectoryMidpointsBuilder(null);
      if (!finalized) failTask(prepTaskId, "Cancelled");
    };
  }, [internalData, segmentColumns, dispatch, setRTreeReady, bumpMidpointRTreeVersion, dataRef, rTreeRef, segmentsRTreeRef, segmentsRef, trajectoryMidpointRTreeRef, trajectoryMidpointsRef, reheatRef]);

  useEffect(() => {
    if (internalData && internalData.length > 0) return;
    dataRef.current = [];
    segmentsRef.current = null;
    registerTrajectoryMidpointsBuilder(null);
    trajectoryMidpointsRef.current = [];
    trajectoryMidpointRTreeRef.current = new rbush<RTreeItem<TrajectoryMidpoint>>();
    bumpMidpointRTreeVersion();
    dispatch(clearFeatureMetadata());
    dispatch(setAnnotationLabelFeature(null));
    dispatch(setAnnotationTagDelimiter(","));
    dispatch(setTfIdfLabels({}));
  }, [internalData, dispatch, dataRef, segmentsRef, trajectoryMidpointsRef, trajectoryMidpointRTreeRef, bumpMidpointRTreeVersion]);
}
