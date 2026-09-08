import { useEffect, useRef, useState } from "react";
import { yieldBeforeCommit } from "../utils/yieldBeforeCommit";
import { ledgerEvent } from "../utils/insetLedger";
import { useDispatch } from "react-redux";
import { getDatasetClusterPreset, getDatasetVisualPreset } from "../config/datasetVisualPresets";
import {
  DatasetEntry,
  INITIAL_DATASET,
  resolveDatasetFetchPath,
  resolveDatasetType,
} from "../datasets/catalog";
import { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { loadDatasetAuto } from "../dataPreprocessing/DatasetLoader";
import { loadSimpleDataset } from "../dataPreprocessing/loadSimpleDataset";
import {
    inferSimpleColumnMapping,
    type SimpleColumnMapping,
} from "../dataPreprocessing/simpleDataset";
import { resolveKnownLocalBackend, setActiveBackend } from "@scaling";
import { clearServerDoiState } from "../doiPropagation/serverPropagation";
import { setSelectedClusters } from "../slices/labelingSlice";
import {
    clearFeatureSearchQuery,
    RootState,
    setDatasetMetadata,
    setSelectedNodes,
    default as store,
    updateClusterSettings,
    updateSettings,
    VisualizationSettings,
} from "../store";
import { setGymRenderConfig } from "../components/Visualization/Details/Gym/renderServiceClient";
import type { PointColumns as SidecarPointColumns } from "../dataPreprocessing/columnSidecar";
import type { SegmentColumns } from "../dataPreprocessing/splineColumns";
import { Dataset } from "../types/datasetTypes";
import { KnnGraph } from "../types/graphTypes";
import { applyRendererDefaults } from "../utils/clusterDataUtils";
import { columnsOf, refreshPositionColumns } from "../dataPreprocessing/pointColumns";
import { resetColorScale } from "../utils/colorScale";
import { computeMaxEmbeddingDistance } from "../utils/embedding";
import {
  computeMedianTrajectoryLength,
  setMedianTrajectoryLength,
} from "../utils/trajectoryStats";
import { computeMedianNN } from "../utils/utils";
import { makeMetricsWorker } from "../workers/makeMetricsWorker";
import { buildMetricsPayload, payloadToPoints } from "../workers/metricsPayload";

/** Simple-format rows handed in by an embedding host (anywidget). */
export interface SimpleDatasetInput {
  rows: Record<string, unknown>[];
  /** Partial mapping; missing roles are inferred from the row keys. */
  mapping?: Partial<SimpleColumnMapping>;
  datasetType?: string;
  /** rows × cols of the pixel grid for the `"image"` type (widget `image_shape`). */
  imageShape?: [number, number];
}

export interface UseInitialDatasetResult {
  internalData: DataPoint[] | null;
  internalKnnGraph: KnnGraph;
  internalHdbscan: Dataset["hdbscan"] | null;
  internalMidpointHdbscan: Dataset["midpointHdbscan"] | null;
  /** Resident columnar geometry built by the loaders (issue #315 phase B1);
   * null when the dataset shipped none (usePrepareDatasetRefs then derives). */
  internalSegmentColumns: SegmentColumns | null;
  handleDatasetSelected: (dataset: Dataset) => void;
  /** Convenient path+type selector for clicks coming from the Predefined Datasets tab. */
  handlePredefinedSelected: (entry: { path: string; datasetType: string }) => Promise<void>;
  /**
   * Overwrites every point's x/y with an in-app projection result (interleaved
   * [x0, y0, x1, y1, ...]) and swaps in the kNN graph computed on it. The
   * precomputed HDBSCAN hierarchies are dropped so clustering re-fits in the
   * worker — the same path drag-and-dropped datasets take. The original
   * projection is stashed on first use for restoreOriginalProjection().
   */
  applyProjection: (coords: Float32Array, knnGraph: KnnGraph) => void;
  /** Restores the dataset-shipped x/y, kNN graph, and HDBSCAN hierarchies. */
  restoreOriginalProjection: () => void;
  canRestoreProjection: boolean;
}

export function useInitialDataset(
  data?: DataPoint[],
  propKnnGraph?: KnnGraph,
  colorPalette?: string[],
  /** When set (e.g. by a deep link), the bootstrap loads this entry instead of INITIAL_DATASET. */
  initialDatasetOverride?: DatasetEntry,
  /** When set (anywidget), the bootstrap preprocesses these rows in-app instead of fetching a predefined dataset. */
  simpleDatasetInput?: SimpleDatasetInput,
  /** Boot columns-direct paint hook (issue #315 B1): forwarded to the manifest
   * loader, fired with the decoded sidecar columns before row materialization
   * so the live renderer can draw real points immediately. */
  onPointColumns?: (cols: SidecarPointColumns) => void
): UseInitialDatasetResult {
  const [internalData, setInternalData] = useState<DataPoint[] | null>(null);
  const [internalKnnGraph, setInternalKnnGraph] = useState<KnnGraph>([]);
  const [internalHdbscan, setInternalHdbscan] = useState<Dataset["hdbscan"] | null>(null);
  const [internalMidpointHdbscan, setInternalMidpointHdbscan] = useState<Dataset["midpointHdbscan"] | null>(null);
  const [internalSegmentColumns, setInternalSegmentColumns] = useState<SegmentColumns | null>(null);
  const dispatch = useDispatch();

  // Avoid StrictMode double execution (dev)
  const didAutoLoadRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const activeLoadAbortRef = useRef<AbortController | null>(null);

  // In-app projection support: original x/y + graph/hierarchy references,
  // stashed once before the first applyProjection so restore is exact.
  const [canRestoreProjection, setCanRestoreProjection] = useState(false);
  const originalProjectionRef = useRef<{
    coords: Float32Array;
    knnGraph: KnnGraph;
    hdbscan: Dataset["hdbscan"] | null;
    midpointHdbscan: Dataset["midpointHdbscan"] | null;
    segmentColumns: SegmentColumns | null;
  } | null>(null);
  // Guards the widget-mode bootstrap effect from re-applying the same `data`
  // prop (and clobbering an applied projection) when internalData identity
  // changes for other reasons.
  const lastAppliedPropDataRef = useRef<DataPoint[] | null>(null);

  const clearProjectionStash = () => {
    originalProjectionRef.current = null;
    setCanRestoreProjection(false);
  };

  const cancelPendingLoad = () => {
    activeLoadAbortRef.current?.abort();
    activeLoadAbortRef.current = null;
  };

  const beginLoad = () => {
    cancelPendingLoad();
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const abortController = new AbortController();
    activeLoadAbortRef.current = abortController;
    return { generation, signal: abortController.signal };
  };

  const computeDefaultsAsync = (points: DataPoint[], epsScale: number, generation: number) => {
    // Reach-linear chain sliders (utils/trajectoryStats): one synchronous
    // O(n) pass over the line column — every load path funnels through here,
    // the same place the other derived defaults are produced.
    setMedianTrajectoryLength(computeMedianTrajectoryLength(points));
    return computeDefaultsInWorker(points)
      .catch(() => computeDefaultsIdle(points))
      .then(({ maxEmbeddingDistance, medianNN }) => {
        if (generation !== loadGenerationRef.current) return;
        dispatch(updateSettings({ maxEmbeddingDistance, defaultEps: medianNN * epsScale }));
      });
  };

  const normalizeLoadedData = (points: DataPoint[]): DataPoint[] => {
    // Born-column-backed rows come out of the loader already normalized
    // (issue #315 R1a, A4): the DoI column is uniform 1 and the selection
    // column is zeroed, so the pass is a typed-array no-op instead of 2M
    // accessor writes at synth1m.
    const cols = columnsOf(points);
    if (cols) {
      cols.doi.fill(1);
      cols.selected.fill(0);
      cols.selectedIndices = undefined;
      return points;
    }
    for (let i = 0; i < points.length; i++) {
      points[i].selected = false;
      points[i].DoI = 1;
    }
    return points;
  };

  const applyDatasetAfterStyleCommit = (
    dataset: Dataset,
    datasetType: string,
    epsScale: number,
    datasetPath?: string,
    generation = loadGenerationRef.current,
    imageShape: [number, number] | null = null
  ): void => {
    if (generation !== loadGenerationRef.current) return;

    // A new dataset defines a new "original" projection.
    clearProjectionStash();

    // A new dataset also starts color discovery + the category → palette-slot
    // mapping from scratch (2026-08-05 bug: a catalog switch where palette AND
    // encoding survive — rubik → chess, both "algo"/Set2 — kept the previous
    // dataset's discovered keys, so the legend showed ghost zero-count rows
    // and the new categories colored from later palette slots). The upload and
    // data-prop paths already reset; this is the shared switch path.
    if (colorPalette) resetColorScale(colorPalette);

    // Remove the previous dataset immediately so old visuals are no longer shown.
    setInternalData(null);
    setInternalKnnGraph([]);
    setInternalHdbscan(null);
    setInternalMidpointHdbscan(null);
    setInternalSegmentColumns(null);

    dispatch(setDatasetMetadata({ datasetType, datasetPath: datasetPath ?? dataset.sourcePath ?? "", imageShape }));
    // (Re)configure the on-demand render client on every dataset switch so a
    // previous gymnasium dataset's envId/endpoint never leaks into the next.
    setGymRenderConfig(dataset.render);
    // Same for the on-demand inset/tile backend (issue #315): passing null on a
    // dataset without `backend:` clears any previous one. No-op in public builds
    // (the `@scaling` stub).
    setActiveBackend(dataset.backend ?? null);
    // Catalog unification (issue #315, 2026-07-31): a manifest without a
    // backend silently adopts the matching known LOCAL inset service when its
    // /health answers — the runtime replacement for the retired "(backend
    // demo)" catalog rows. Async and generation-guarded: a slow probe from a
    // superseded load must never attach to the next dataset. Stub resolves
    // null, so public builds never fire a probe.
    if (!dataset.backend) {
      void resolveKnownLocalBackend(datasetPath ?? dataset.sourcePath ?? "").then((manifest) => {
        if (!manifest || generation !== loadGenerationRef.current) return;
        setActiveBackend(manifest);
      });
    }
    // The server retains DoI state per dataset ACROSS page loads; a fresh
    // session must start from a clean server or P7 select frames keep
    // scoring against a previous session's ghost selection (clusters vanish
    // / insets land off-screen). Fire-and-forget: the A3 re-select push the
    // clear triggers refreshes actives on its own.
    void clearServerDoiState();
    const expectedPreset = getDatasetVisualPreset({ datasetType, datasetPath: datasetPath ?? dataset.sourcePath });
    const before = (store.getState() as RootState).visualizationSettings;
    const expectedMerged: VisualizationSettings = {
      ...before,
      ...expectedPreset,
      colorPalette: expectedPreset.colorPalette ? [...expectedPreset.colorPalette] : [...before.colorPalette],
    };
    dispatch(updateSettings(expectedPreset));
    dispatch(updateClusterSettings(getDatasetClusterPreset({ datasetType })));
    applyRendererDefaults(datasetType);

    const hasExpectedVisuals = (s: VisualizationSettings) => {
      if (expectedPreset.colorEncoding !== undefined && s.colorEncoding !== expectedMerged.colorEncoding) return false;
      if (expectedPreset.canvasBgColor !== undefined && s.canvasBgColor !== expectedMerged.canvasBgColor) return false;
      if (expectedPreset.colorMapRotationOffset !== undefined && s.colorMapRotationOffset !== expectedMerged.colorMapRotationOffset) return false;
      if (expectedPreset.nodeRadius !== undefined && s.nodeRadius !== expectedMerged.nodeRadius) return false;
      if (expectedPreset.edgeWidth !== undefined && s.edgeWidth !== expectedMerged.edgeWidth) return false;
      if (expectedPreset.arrowScale !== undefined && s.arrowScale !== expectedMerged.arrowScale) return false;
      if (expectedPreset.maximumOpacityClamping !== undefined && s.maximumOpacityClamping !== expectedMerged.maximumOpacityClamping) return false;
      if (expectedPreset.colorPalette !== undefined) {
        if (s.colorPalette.length !== expectedMerged.colorPalette.length) return false;
        if (!s.colorPalette.every((c, i) => c === expectedMerged.colorPalette[i])) return false;
      }
      return true;
    };

    const waitForVisualPresetApplied = (timeoutMs = 1000): Promise<void> =>
      new Promise<void>((resolve) => {
        const isDone = () => {
          if (generation !== loadGenerationRef.current) return true;
          const current = (store.getState() as RootState).visualizationSettings;
          return hasExpectedVisuals(current);
        };
        if (isDone()) {
          resolve();
          return;
        }
        // Subscribe instead of polling rAF: fires as soon as the preset
        // dispatch lands, and costs nothing while waiting.
        let unsubscribe: () => void = () => {};
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(settle, timeoutMs);
        unsubscribe = store.subscribe(() => {
          if (isDone()) settle();
        });
      });

    void waitForVisualPresetApplied().then(() => {
      if (generation !== loadGenerationRef.current) return;
      yieldBeforeCommit(() => {
        if (generation !== loadGenerationRef.current) return;
        ledgerEvent("boot:commit", `n=${dataset.data.length}`);
        const normalizedData = normalizeLoadedData(dataset.data);
        setInternalData(normalizedData);
        setInternalKnnGraph(dataset.knnGraph);
        setInternalHdbscan(dataset.hdbscan ?? null);
        setInternalMidpointHdbscan(dataset.midpointHdbscan ?? null);
        setInternalSegmentColumns(dataset.segmentColumns ?? null);
        computeDefaultsAsync(normalizedData, epsScale, generation);
      });
    });
  };

  useEffect(() => {
    // Embedding host handed in simple-format rows (anywidget): preprocess
    // them in-app instead of fetching a predefined dataset.
    if (simpleDatasetInput && simpleDatasetInput.rows.length > 0 && (!data || data.length === 0) && !internalData) {
      if (didAutoLoadRef.current) return;
      didAutoLoadRef.current = true;

      const { generation, signal } = beginLoad();
      const datasetType = (simpleDatasetInput.datasetType ?? "default").toLowerCase();
      const imageShape = simpleDatasetInput.imageShape ?? null;

      const inferred = inferSimpleColumnMapping(Object.keys(simpleDatasetInput.rows[0]));
      const provided = simpleDatasetInput.mapping ?? {};
      const mapping: Partial<SimpleColumnMapping> = { ...inferred };
      (Object.keys(provided) as Array<keyof SimpleColumnMapping>).forEach((key) => {
        if (provided[key]) mapping[key] = provided[key];
      });
      if (!mapping.x || !mapping.y) {
        console.error(
          "useInitialDataset: simple dataset input needs x/y columns (provide columnMapping)",
          mapping
        );
        return;
      }

      dispatch(setDatasetMetadata({ datasetType, datasetPath: "", imageShape }));
      dispatch(updateSettings(getDatasetVisualPreset({ datasetType })));
      dispatch(updateClusterSettings(getDatasetClusterPreset({ datasetType })));
      applyRendererDefaults(datasetType);

      loadSimpleDataset(simpleDatasetInput.rows, mapping as SimpleColumnMapping, {
        datasetType,
        signal,
      })
        .then((dataset) => {
          if (generation !== loadGenerationRef.current) return;
          applyDatasetAfterStyleCommit(dataset, datasetType, 1000, undefined, generation, imageShape);
        })
        .catch((err) => {
          if (signal.aborted) return;
          console.error("useInitialDataset: loadSimpleDataset failed", err);
        });
      return;
    }

    // If no external data was passed in, bootstrap from the predefined startup dataset.
    if ((!data || data.length === 0) && !internalData) {
      if (didAutoLoadRef.current) return;
      didAutoLoadRef.current = true;

      const { generation, signal } = beginLoad();

      const startupEntry = initialDatasetOverride ?? INITIAL_DATASET;

      // Pre-seed UI with the predefined type so type-specific defaults/components are ready.
      const hintedType = startupEntry.datasetType.toLowerCase();
      dispatch(setDatasetMetadata({ datasetType: hintedType, datasetPath: startupEntry.path }));
      dispatch(updateSettings(getDatasetVisualPreset({ datasetType: hintedType, datasetPath: startupEntry.path })));
      dispatch(updateClusterSettings(getDatasetClusterPreset({ datasetType: hintedType })));
      applyRendererDefaults(hintedType);

      loadDatasetAuto(resolveDatasetFetchPath(startupEntry.path), { signal, onPointColumns })
        .then((dataset: Dataset) => {
          if (generation !== loadGenerationRef.current) return;
          // Final type: prefer the predefined hint unless the file has a stronger explicit type.
          const datasetType = resolveDatasetType(startupEntry.datasetType, dataset.datasetType);
          applyDatasetAfterStyleCommit(dataset, datasetType, 1000, startupEntry.path, generation);
        })
        .catch((err) => {
          if (signal.aborted) return;
          console.error("useInitialDataset: loadDatasetAuto failed", err);
        });
    } else if (data && data.length > 0) {
      // Same `data` prop already applied — don't clobber internalData (which
      // may since have been replaced by an in-app projection).
      if (lastAppliedPropDataRef.current === data) return;
      lastAppliedPropDataRef.current = data;
      const { generation } = beginLoad();
      clearProjectionStash();
      if (colorPalette) resetColorScale(colorPalette);
      setInternalData(data);
      setInternalKnnGraph(propKnnGraph || []);
      setInternalHdbscan(null);
      setInternalMidpointHdbscan(null);
      setInternalSegmentColumns(null);
      computeDefaultsAsync(data, 1000, generation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot effect keyed on its data inputs; the load helpers are re-created per render and adding them would re-trigger dataset loads
  }, [data, propKnnGraph, internalData, dispatch, colorPalette, initialDatasetOverride, simpleDatasetInput]);

  // Shared apply path for in-app projections and their restore: overwrite x/y
  // in place, clear all x/y-derived per-point state (hydrated splines would
  // otherwise be reused by usePrepareDatasetRefs), and hand everything to the
  // downstream pipeline in one React batch — a new internalData reference
  // re-fires renderer + dataset-ref rebuilds exactly like a dataset swap.
  const applyProjectedCoords = (
    coords: Float32Array,
    knn: KnnGraph,
    hdbscan: Dataset["hdbscan"] | null,
    midpointHdbscan: Dataset["midpointHdbscan"] | null,
    /** Columns are baked to a layout: an in-app projection drops them (null →
     * usePrepareDatasetRefs re-derives from the new x/y) and a restore brings
     * the originals back. */
    segmentColumns: SegmentColumns | null
  ) => {
    const points = internalData;
    if (!points || coords.length !== 2 * points.length) return;
    const { generation } = beginLoad();

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      p.x = coords[2 * i];
      p.y = coords[2 * i + 1];
      p.nextEdgeCenter = { x: 0, y: 0 };
      p.selected = false;
      p.DoI = 1;
      p.doiGroup = undefined;
      p.annotationClusterId = undefined;
      p.insetClusterId = undefined;
    }
    // The single runtime x/y rewrite site — re-mirror the position columns
    // (issue #315 D2).
    refreshPositionColumns(points);

    // Selection geometry is invalidated by the new layout (mirrors
    // handleDatasetSelected).
    dispatch(clearFeatureSearchQuery());
    dispatch(setSelectedNodes([]));
    dispatch(setSelectedClusters([]));

    setInternalData([...points]);
    setInternalKnnGraph(knn);
    setInternalHdbscan(hdbscan);
    setInternalMidpointHdbscan(midpointHdbscan);
    setInternalSegmentColumns(segmentColumns);

    computeDefaultsAsync(points, 3, generation);
  };

  const applyProjection = (coords: Float32Array, knnGraphForCoords: KnnGraph) => {
    const points = internalData;
    if (!points || coords.length !== 2 * points.length) return;

    if (!originalProjectionRef.current) {
      const original = new Float32Array(2 * points.length);
      for (let i = 0; i < points.length; i++) {
        original[2 * i] = points[i].x;
        original[2 * i + 1] = points[i].y;
      }
      originalProjectionRef.current = {
        coords: original,
        knnGraph: internalKnnGraph,
        hdbscan: internalHdbscan,
        midpointHdbscan: internalMidpointHdbscan,
        segmentColumns: internalSegmentColumns,
      };
      setCanRestoreProjection(true);
    }

    // Null hierarchies → clustering re-fits in the worker (drag-drop path).
    applyProjectedCoords(coords, knnGraphForCoords, null, null, null);
  };

  const restoreOriginalProjection = () => {
    const stash = originalProjectionRef.current;
    if (!stash) return;
    // Restoring the original precomputed hierarchies rehydrates instead of
    // re-fitting — fast and exact.
    applyProjectedCoords(
      stash.coords,
      stash.knnGraph,
      stash.hdbscan,
      stash.midpointHdbscan,
      stash.segmentColumns
    );
  };

  const handleDatasetSelected = (dataset: Dataset) => {
    // When callers already resolved a dataset object (e.g., custom uploads),
    // keep whatever the dataset claims, defaulting to "default".
    const datasetType = (dataset.datasetType?.toLowerCase?.() ?? "default");
    const { generation } = beginLoad();
    if (colorPalette) resetColorScale(colorPalette);
    dispatch(clearFeatureSearchQuery());
    dispatch(setSelectedNodes([]));
    dispatch(setSelectedClusters([]));
    applyDatasetAfterStyleCommit(dataset, datasetType, 3, dataset.sourcePath, generation);
  };

  const handlePredefinedSelected = async (entry: { path: string; datasetType: string }) => {
    // This path mirrors the initial bootstrap: prefer the predefined type for this path.
    dispatch(clearFeatureSearchQuery());

    const { generation, signal } = beginLoad();

    try {
      const dataset = await loadDatasetAuto(resolveDatasetFetchPath(entry.path), { signal, onPointColumns });
      if (generation !== loadGenerationRef.current) return;
      const finalType = resolveDatasetType(entry.datasetType, dataset.datasetType);
      dispatch(setSelectedNodes([]));
      dispatch(setSelectedClusters([]));
      applyDatasetAfterStyleCommit(dataset, finalType, 3, entry.path, generation);
    } catch (err) {
      if (signal.aborted) return;
      console.error("handlePredefinedSelected: load failed", err);
    }
  };

  return {
    internalData,
    internalKnnGraph,
    internalHdbscan,
    internalMidpointHdbscan,
    internalSegmentColumns,
    handleDatasetSelected,
    handlePredefinedSelected,
    applyProjection,
    restoreOriginalProjection,
    canRestoreProjection,
  };
}

// --- helpers ---

type Defaults = { maxEmbeddingDistance: number; medianNN: number };

function computeDefaultsIdle(points: DataPoint[]): Promise<Defaults> {
  return new Promise((resolve) => {
    const run = () => {
      // Same columnar point view the worker gets (issue #315 R1b): both
      // metrics read x/y only, and on the row-lazy lane the rows do not exist.
      const view = payloadToPoints(buildMetricsPayload(points).payload) as DataPoint[];
      const maxEmbeddingDistance = computeMaxEmbeddingDistance(view);
      const medianNN = computeMedianNN(view);
      resolve({ maxEmbeddingDistance, medianNN });
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run);
    else setTimeout(run, 0);
  });
}

function computeDefaultsInWorker(points: DataPoint[]): Promise<Defaults> {
  return new Promise((resolve, reject) => {
    try {
      const worker = makeMetricsWorker();
      worker.onmessage = (e: MessageEvent) => {
        worker.terminate();
        resolve(e.data as Defaults);
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(e);
      };
      // Columnar payload (issue #315 R1a A5): column-backed arrays ship
      // transferable x/y copies instead of 1M cloned {x,y} objects.
      const { payload, transfer } = buildMetricsPayload(points);
      worker.postMessage(payload, transfer);
    } catch (err) {
      reject(err);
    }
  });
}
