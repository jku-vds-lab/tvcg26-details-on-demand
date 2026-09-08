import { Box, IconButton, ThemeProvider, Tooltip, useMediaQuery } from "@mui/material";
import * as d3 from "d3";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import "./App.css";
import { useDataRef } from "./contexts/DataContext";
import { RendererApiProvider } from "./contexts/RendererApiContext";
import { useRTreeRef } from "./contexts/RTreeContext";
import { useSegmentsRef } from "./contexts/SegmentsContext";
import { useTrajectoryMidpointsRef } from "./contexts/TrajectoryMidpointsContext";

import { createLassoBehavior } from "./behaviors/DebugLassoBehavior";
import { createZoomBehavior } from "./behaviors/ZoomBehavior";
import { buildServerLassoResolver } from "./utils/serverLasso";
import {
  buildPropagateParams,
  clearServerDoiState,
  getAppliedFieldOpacity,
  propagateSelectionOnServer,
  runLocalFieldPropagation,
  serverPropagationEligible,
} from "./doiPropagation/serverPropagation";
import { createTrailingThrottle } from "./utils/trailingThrottle";
import { useCanvasInteractions } from "./hooks/useCanvasInteractions";

import CopyLinkButton from "./components/CopyLinkButton";
import GlobalProgressDock from "./components/GlobalProgressDock";
import ServerLossWarning from "./components/ServerLossWarning";
import { SliderSettings } from "./components/InterestTabSliders";
import SidePanel from "./components/SidePanel/SidePanel";
import ColorLegendDock from "./components/Visualization/ColorLegendDock";
import VisualizationContainer from "./components/Visualization/VisualizationContainer";

import { DataPoint } from "./dataPreprocessing/dataPreprocessing";

import useCanvasResize from "./hooks/useCanvasResize";
import { useClustering } from "./hooks/useClustering";
import { useDeepLink, ZoomApiHandle } from "./hooks/useDeepLink";
import { computeViewbox, viewboxToTransform } from "./utils/viewboxUtils";
import { useDoIPropagation } from "./hooks/useDoIPropagation";
import { useRehydrateHdbscan, useRehydrateMidpointHdbscan } from "./hooks/useFullSelectionHdbscanInstance";
import { useInitialClustering } from "./hooks/useInitialClustering";
import { useInitialDataset, type SimpleDatasetInput } from "./hooks/useInitialDataset";
import { installColumnsFirstRenderer, useInitializeRenderer } from "./hooks/useInitializeRenderer";
import { useLabelingAutoSync } from "./hooks/useLabelingAutoSync";
import { labelingNodeIdSourceFor, useLabelingModeKeyboardToggle } from "./hooks/useLabelingModeKeyboardToggle";
import { useLassoSelection } from "./hooks/useLassoSelection";
// if you don’t have this hook yet, you can remove this import + its call safely
import { usePrepareDatasetRefs } from "./hooks/usePrepareDatasetRefs";

import { CurrentDatasetProvider } from "./contexts/CurrentDatasetContext";
import { SelectionWorkflowProvider } from "./contexts/SelectionWorkflowContext";
import { type DatasetEntry, findDatasetEntryBySlug, INITIAL_DATASET, resolveDatasetFetchPath } from "./datasets/catalog";
import { installGymCheatcode } from "./datasets/gymUnlock";
import { readDeepLinkFromLocation } from "./utils/deepLink";
import {
  resolveAggregateSource,
  resolveCutProvider,
  resolveTileSource,
  type AggregateTileSource,
  type ScatterTileSource,
} from "@scaling";
import { updateTrajectoryMidpointDoIs } from "./dataPreprocessing/dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "./dataPreprocessing/columnSidecar";
import { columnsOf, writeSelectionByIds } from "./dataPreprocessing/pointColumns";
import { updateEdgeColumnDois } from "./dataPreprocessing/splineColumns";
import { setLiveSliderSettings } from "./stores/liveSliderSettingsStore";
import { updateNodeGroup } from "./doiPropagation/propagateDoi";
import type { RendererAPI } from "./gl/api/RendererAPI";
import {
    bumpClusteringEpoch,
    isCurrentClusteringEpoch,
    isServerCutActive,
    prefetchServerCut,
    runHdbscanClusteringWithStatus,
    runTrajectoryMidpointClusteringWithStatus,
    setCurrentTransformProvider,
    setGestureActiveProvider,
    wasMidpointFitSkippedForBudget,
} from "./clustering/hdbscanClustering";
import { useOverlaySize } from "./hooks/useOverlaySize";
import { freehandPinnedIds } from "./slices/freehandSlice";
import { bumpDeferredColumnsRevision } from "./slices/datasetFeatures";
import {
    onDeferredColumnsAttached,
    pendingDeferredColumns,
} from "./dataPreprocessing/lazyColumns";
import { ensureResidentColumnsWithChip } from "./utils/rowResidency";
import store, { clearFeatureSearchQuery, type RootState, type VisualizationSettings } from "./store";
import { createAppTheme } from "./theme";
import type { Dataset } from "./types/datasetTypes";
import { KnnGraph } from "./types/graphTypes";
import { InteractionBehavior } from "./types/InteractionBehavior";

interface AppProps {
  data: DataPoint[];
  knnGraph: KnnGraph;
  /** Simple-format rows handed in by an embedding host (anywidget); preprocessed in-app. */
  simpleDatasetInput?: SimpleDatasetInput;
  /** Embedded (anywidget) mode: fill the host element and hide the dataset selector tab. */
  embedded?: boolean;
}

const App: React.FC<AppProps> = ({ data, knnGraph, simpleDatasetInput, embedded = false }) => {
  // ─── 0. Deep link (parsed once per page load) ──────────────────────────────
  const deepLink = useMemo(() => readDeepLinkFromLocation(), []);
  const deepLinkDatasetEntry = useMemo(
    () => (deepLink?.datasetSlug ? findDatasetEntryBySlug(deepLink.datasetSlug) : undefined),
    [deepLink]
  );
  // When the link carries a selection, the deep-link replay acts as the
  // initial clustering (see useInitialClustering's `skip`).
  const deepLinkHasSelection = Boolean(
    deepLink && (deepLink.query || (deepLink.selectionIds && deepLink.selectionIds.length > 0))
  );

  // Konami-code unlock for the localOnly gym demo datasets on deployed hosts.
  useEffect(() => installGymCheatcode(), []);

  // ─── 1. Redux & UI State ─────────────────────────────────────────────────
  const visualSettings = useSelector((s: RootState) => s.visualizationSettings);
  const clusterSettings = useSelector((s: RootState) => s.clusterSettings);
  const datasetMetadata = useSelector((s: RootState) => s.dataset);
  const appTheme = useMemo(
    () => createAppTheme(visualSettings.uiAccentColor, visualSettings.sidePanelBgColor),
    [visualSettings.uiAccentColor, visualSettings.sidePanelBgColor]
  );

  const [sliderSettings, setSliderSettings] = useState<SliderSettings>({
    proximitySlider: visualSettings.proximitySlider,
    pastSlider: visualSettings.pastSlider,
    futureSlider: visualSettings.futureSlider,
    grayOutDoiThreshold: visualSettings.grayOutDoiThreshold,
    annotationDoiThreshold: visualSettings.annotationDoiThreshold,
    insetDoiThreshold: visualSettings.insetDoiThreshold,
  });

  const lastSyncedPropagationRef = useRef({
    proximitySlider: visualSettings.proximitySlider,
    pastSlider: visualSettings.pastSlider,
    futureSlider: visualSettings.futureSlider,
  });

  // Deferred-column attaches (issue #315 R3c): bump the store revision so
  // memoized surfaces whose inputs became readable (inset overlay labels)
  // re-resolve on the next render.
  useEffect(
    () => onDeferredColumnsAttached(() => store.dispatch(bumpDeferredColumnsRevision())),
    []
  );

  useEffect(() => {
    const propagationChangedInStore =
      visualSettings.proximitySlider !== lastSyncedPropagationRef.current.proximitySlider ||
      visualSettings.pastSlider !== lastSyncedPropagationRef.current.pastSlider ||
      visualSettings.futureSlider !== lastSyncedPropagationRef.current.futureSlider;

    const next: SliderSettings = propagationChangedInStore
      ? {
        proximitySlider: visualSettings.proximitySlider,
        pastSlider: visualSettings.pastSlider,
        futureSlider: visualSettings.futureSlider,
        grayOutDoiThreshold: visualSettings.grayOutDoiThreshold,
        annotationDoiThreshold: visualSettings.annotationDoiThreshold,
        insetDoiThreshold: visualSettings.insetDoiThreshold,
      }
      : {
        proximitySlider: sliderSettings.proximitySlider,
        pastSlider: sliderSettings.pastSlider,
        futureSlider: sliderSettings.futureSlider,
        grayOutDoiThreshold: visualSettings.grayOutDoiThreshold,
        annotationDoiThreshold: visualSettings.annotationDoiThreshold,
        insetDoiThreshold: visualSettings.insetDoiThreshold,
      };

    lastSyncedPropagationRef.current = {
      proximitySlider: visualSettings.proximitySlider,
      pastSlider: visualSettings.pastSlider,
      futureSlider: visualSettings.futureSlider,
    };

    setSliderSettings((prev) => {
      if (
        prev.proximitySlider === next.proximitySlider &&
        prev.pastSlider === next.pastSlider &&
        prev.futureSlider === next.futureSlider &&
        prev.grayOutDoiThreshold === next.grayOutDoiThreshold &&
        prev.annotationDoiThreshold === next.annotationDoiThreshold &&
        prev.insetDoiThreshold === next.insetDoiThreshold
      ) {
        return prev;
      }
      return next;
    });
    // Store-driven changes (deep links, presets) must reach the live store
    // too — thumbs and the color legend render from it (issue #330).
    setLiveSliderSettings(next);
  }, [
    visualSettings.proximitySlider,
    visualSettings.pastSlider,
    visualSettings.futureSlider,
    visualSettings.grayOutDoiThreshold,
    visualSettings.annotationDoiThreshold,
    visualSettings.insetDoiThreshold,
    sliderSettings.proximitySlider,
    sliderSettings.pastSlider,
    sliderSettings.futureSlider,
  ]);

  const [zoomTransform, setZoomTransform] = useState<d3.ZoomTransform>(d3.zoomIdentity);
  const zoomTransformRef = useRef(zoomTransform);
  useEffect(() => { zoomTransformRef.current = zoomTransform; }, [zoomTransform]);

  // Pan-gesture gate (issue #322): a pure translation cannot change the
  // semantic-zoom SCALE, but it does change which clusters overlap/overflow
  // the viewport — and recomputing that cut per settled tick re-runs the
  // whole reconcile → R-tree → edge-color pipeline (100–200 ms of JS per tick
  // on 34k-point datasets). While a gesture event keeps `k` unchanged we
  // defer reclustering to the gesture end; wheel zooms (k changes) keep the
  // live semantic-zoom updates.
  const panGestureRef = useRef(false);
  const panSuppressedClusteringRef = useRef(false);
  // Wheel-burst destination (issue #315 T0): the transform the current
  // animated burst will END on, null outside bursts. Mid-gesture prefetch
  // pushes THIS viewport so the server walks where the glide is going —
  // pushing mid-ease frames instead would supersede the destination walk
  // (freshest-wins) with already-stale ones.
  const wheelDestinationRef = useRef<d3.ZoomTransform | null>(null);

  // Gesture-path throttle: zoom/pan events update React state at most every
  // 150 ms (trailing) + an exact flush on gesture end. Per-event visuals are
  // imperative (renderer transform + annotation-layer CSS matrix + --invk);
  // React consumers (reclustering, viewbox, stroke widths) only need the
  // settled cadence. Anything needing per-event freshness reads
  // zoomTransformRef instead.
  const settledZoomThrottle = useMemo(
    () => createTrailingThrottle<d3.ZoomTransform>((t) => setZoomTransform(t), 150),
    []
  );
  useEffect(() => () => settledZoomThrottle.cancel(), [settledZoomThrottle]);

  const [scales, setScales] = useState<{ xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number>; } | null>(null);

  // ─── 2. Layout State ────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState(0);
  const handleTabChange = useCallback((_: React.SyntheticEvent, v: number) => setActiveTab(v), []);
  const compactSidebar = useMediaQuery("(max-width: 1500px)");
  const narrowSidebar = useMediaQuery("(max-width: 1280px)");
  const tabButtonWidth = narrowSidebar ? 76 : compactSidebar ? 84 : 92;
  const sidePanelContentWidth = narrowSidebar ? 260 : compactSidebar ? 276 : 292;

  // ─── 3. Refs ───────────────────────────────────────────────────────────────
  const interactionParentRef = useRef<HTMLDivElement>(null);
  const webGLCanvasContainerRef = useRef<HTMLDivElement>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);
  const lassoOverlayRef = useRef<HTMLCanvasElement>(null);
  useOverlaySize(webGLCanvasContainerRef, lassoOverlayRef);

  const applyAnnotationTransform = (t: d3.ZoomTransform) => {
    const annotationCanvas = annotationLayerRef.current;
    if (!annotationCanvas) return;
    const m = `matrix(${t.k},0,0,${t.k},${t.x},${t.y})`;
    annotationCanvas.style.transform = m;
    annotationCanvas.style.setProperty("--invk", `${1 / t.k}`);
  };

  // The annotation layer mounts late (gated on the R-tree) and its transform is
  // otherwise only written imperatively from zoom events. If a programmatic
  // transform (deep-link viewbox) lands before the layer exists, the layer
  // would render at identity until the next gesture — seed it on (re)mount.
  const annotationLayerMountRef = useCallback((node: HTMLDivElement | null) => {
    annotationLayerRef.current = node;
    if (!node) return;
    const t = zoomTransformRef.current;
    node.style.transform = `matrix(${t.k},0,0,${t.k},${t.x},${t.y})`;
    node.style.setProperty("--invk", `${1 / t.k}`);
  }, []);
  const rTreeRef = useRTreeRef();

  // ─── 4. Mutable State Refs ──────────────────────────────────────────────────
  const currentSliderSettingsRef = useRef(sliderSettings);
  useEffect(() => { currentSliderSettingsRef.current = sliderSettings; }, [sliderSettings]);

  const currentZoomParamsRef = useRef<{
    width: number;
    height: number;
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  } | null>(null);

  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();
  const rendererRef = useRef<RendererAPI | null>(null);
  /** In-flight selection-commit worker propagation — a newer commit aborts
   * the previous one (freshest wins; issue #331). */
  const propagationAbortRef = useRef<AbortController | null>(null);
  const zoomApiRef = useRef<ZoomApiHandle | null>(null);
  const [zoomReadyTick, setZoomReadyTick] = useState(0);
  const sliderUpdateFrameRef = useRef<number | null>(null);
  const isZoomingRef = useRef(false);
  const zoomReheatRef = useRef<() => void>(() => {});
  const prevVisualSettingsRef = useRef<VisualizationSettings | null>(null);

  useEffect(() => {
    if (webGLCanvasContainerRef.current) {
      webGLCanvasContainerRef.current.style.backgroundColor = visualSettings.canvasBgColor;
    }
  }, [visualSettings.canvasBgColor]);

  // ─── 5. Data + Clustering Hooks ────────────────────────────────────────────
  // Boot columns-direct paint (issue #315 B1): the manifest loader hands the
  // decoded binary sidecar to the live renderer before row materialization,
  // so real points draw seconds earlier. Three cases (issue #315 B3, now that
  // every catalog dataset ships a sidecar): an empty boot base instance
  // (aggregate-first) takes the paint directly; no renderer (client-complete
  // boot) or a PREVIOUS dataset's data renderer (switch) gets a fresh
  // columns-first base with scales from the sidecar extent — painting into
  // the old renderer would render under the old dataset's scales. Flag:
  // `window.__bootColumnsPaint = false` opts out.
  const handleBootPointColumns = useCallback((cols: SidecarPointColumns) => {
    if ((window as unknown as { __bootColumnsPaint?: boolean }).__bootColumnsPaint === false) return;
    const live = rendererRef.current;
    if (live?.setColumnData && live.hasNodeData && !live.hasNodeData()) {
      live.setColumnData(cols);
      return;
    }
    const container = webGLCanvasContainerRef.current;
    if (!container) return;
    installColumnsFirstRenderer(cols, {
      container,
      rendererRef,
      currentZoomParamsRef,
      setScales,
      setZoomTransform,
    });
  }, []);

  const {
    internalData,
    internalKnnGraph,
    internalHdbscan,
    internalMidpointHdbscan,
    internalSegmentColumns,
    handleDatasetSelected,
    applyProjection,
    restoreOriginalProjection,
    canRestoreProjection,
  } = useInitialDataset(data, knnGraph, visualSettings.colorPalette, deepLinkDatasetEntry, simpleDatasetInput, handleBootPointColumns);

  usePrepareDatasetRefs(internalData, internalSegmentColumns, zoomReheatRef);

  const fullSelectionHdbscan = useRehydrateHdbscan(internalHdbscan);
  const fullSelectionMidpointHdbscan = useRehydrateMidpointHdbscan(internalMidpointHdbscan);

  const { performZoomClustering, isReclustering } = useClustering(
    visualSettings,
    clusterSettings,
    webGLCanvasContainerRef,
    scales,
    zoomTransform
  );

  const {
    handlePropagationSliderChange,
    handlePropagationSliderFinalChange,
    notifyDatasetSwap, // ← pulled from hook
  } = useDoIPropagation({
    setSliderSettings,
    currentSliderSettingsRef,
    sliderUpdateFrameRef,
    rendererRef,
    visualSettings,
    performZoomClustering,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
  });

  // ─── 5.1 Sync preview to dataset changes (initial + later swaps) ───────────
  const syncPreviewToDataset = useCallback(() => {
    // Try now…
    notifyDatasetSwap();
    // …and once next frame to avoid races with renderer init/state
    requestAnimationFrame(() => notifyDatasetSwap());
  }, [notifyDatasetSwap]);

  // Runs on initial load and whenever handleDatasetSelected updates the dataset
  useEffect(() => {
    if (!internalData) return;
    syncPreviewToDataset();
  }, [internalData, internalKnnGraph, syncPreviewToDataset]);

  // Ensure swaps triggered from the Dataset tab sync the preview right away.
  // Latest-ref keeps the callback identity stable (handleDatasetSelected is
  // recreated every render) so the memoized SidePanel doesn't re-render per
  // settled zoom tick.
  const handleDatasetSelectedRef = useRef(handleDatasetSelected);
  handleDatasetSelectedRef.current = handleDatasetSelected;
  const handleDatasetSelectedWithPreview = useCallback((dataset: Dataset) => {
    handleDatasetSelectedRef.current(dataset);
    requestAnimationFrame(() => syncPreviewToDataset());
  }, [syncPreviewToDataset]);

  // Same latest-ref stabilization for the projection API (its callbacks are
  // recreated every render inside useInitialDataset; SidePanel is memoized).
  const applyProjectionRef = useRef(applyProjection);
  applyProjectionRef.current = applyProjection;
  const applyProjectionStable = useCallback(
    (coords: Float32Array, knn: KnnGraph) => applyProjectionRef.current(coords, knn),
    []
  );
  const restoreOriginalProjectionRef = useRef(restoreOriginalProjection);
  restoreOriginalProjectionRef.current = restoreOriginalProjection;
  const restoreOriginalProjectionStable = useCallback(
    () => restoreOriginalProjectionRef.current(),
    []
  );

  // ─── 5c. G4 boot-window view carry-over (issue #315) ───────────────────────
  // A gesture made on the EARLY aggregate base layer (renderer initialized
  // before any data, see useInitializeRenderer's boot effect) must survive
  // the data-driven re-init, or refs/state/d3 fall out of sync (observed:
  // frozen "0 of N clusters"). Declared BEFORE useInitializeRenderer so the
  // capture runs first on the internalData commit — `scales` still holds
  // the boot scales and the boot canvas still exists. The view re-applies
  // below (after behaviors attach) through the d3 zoom instance, the same
  // path the deep-link viewbox uses, so every consumer follows.
  const bootViewboxRef = useRef<{ minX: number; maxX: number; minY: number; maxY: number } | null>(null);
  // True while an aggregate-first base (mount boot OR menu switch, slice 2) is
  // the live renderer; useInitializeRenderer sets it on install and clears it
  // when the data-driven init replaces the base. Only a gesture made ON such a
  // base is carried over — a leftover zoom from the previous dataset is not
  // (a serverless switch leaves this false and resets to overview as before).
  const aggregateBaseLiveRef = useRef(false);
  useEffect(() => {
    if (!internalData) return;
    const wasAggregateBase = aggregateBaseLiveRef.current;
    aggregateBaseLiveRef.current = false; // real data now replaces the base
    if (!wasAggregateBase) return;
    const container = webGLCanvasContainerRef.current;
    const t = zoomTransformRef.current;
    if (!container || !scales) return;
    if (t.k === 1 && t.x === 0 && t.y === 0) return; // no gesture on the base
    bootViewboxRef.current = computeViewbox(container, scales, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capture reads whatever is current when data lands
  }, [internalData]);

  // ─── 6. Initialize WebGL Renderer ─────────────────────────────────────────
  const { beginDatasetSwitch } = useInitializeRenderer({
    canvasContainerRef: webGLCanvasContainerRef,
    internalData,
    // G4 early boot (issue #315): same boot-window condition as the F3a
    // overlay above — internal datasets only, no external/widget data.
    bootManifestPath:
      (data && data.length > 0) || simpleDatasetInput
        ? undefined
        : resolveDatasetFetchPath((deepLinkDatasetEntry ?? INITIAL_DATASET).path),
    aggregateBaseLiveRef,
    propKnnGraph: knnGraph,
    internalKnnGraph,
    visualSettings,
    setScales,
    setZoomTransform,
    rendererRef,
    currentZoomParamsRef,
  });

  // G4 slice 2 — kick the aggregate-first base for a menu-selected internal
  // catalog dataset at CLICK time (before its download), so the new base
  // appears ~1 s after the click instead of after the full ingest. External/
  // widget data has no boot backend; serverless datasets resolve null (no-op).
  // Latest-ref keeps the callback identity stable so the memoized SidePanel
  // does not re-render per settled zoom tick.
  const beginDatasetSwitchRef = useRef(beginDatasetSwitch);
  beginDatasetSwitchRef.current = beginDatasetSwitch;
  const handlePredefinedPickStart = useCallback((entry: DatasetEntry) => {
    if ((data && data.length > 0) || simpleDatasetInput) return;
    beginDatasetSwitchRef.current(resolveDatasetFetchPath(entry.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data/simpleDatasetInput are boot-time constants for this build mode
  }, []);

  // ─── 6b. Server tile base imagery (issue #315 phase E) ─────────────────────
  // Resolve the dataset's tile source (gated on the "tiles" capability; the
  // open-core stub always resolves null) and hand it to the renderer. A live
  // selection clears it: tiles render the uniform-DoI base image, so focused
  // views fall back to real geometry until the selection is cleared.
  const hasSelection = useSelector(
    (s: RootState) => s.selection.selectedNodeIds.length > 0
  );
  const tileSourceRef = useRef<ScatterTileSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    tileSourceRef.current = null;
    rendererRef.current?.setTileSource(null);
    // EXPERIMENTAL, opt-in only (`window.__tiles = true` before load): CS's
    // hands-on round found the v1 tile rendering regresses the GL look
    // (sparse-path latency, per-tile spline inconsistency, no endpoint
    // colors) — the default path stays full GL geometry + gesture
    // compositor until tile rendering v2 reaches visual parity.
    if (!(window as unknown as { __tiles?: boolean }).__tiles) return;
    void resolveTileSource(undefined).then((source) => {
      if (cancelled) return;
      tileSourceRef.current = source;
      if (!hasSelection) rendererRef.current?.setTileSource(source);
    });
    return () => {
      cancelled = true;
    };
    // hasSelection is applied by the effect below; re-resolving per selection
    // change would refetch health needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalData]);
  // (applied by the shared base-layer effect below, next to the aggregates)

  // ─── 6c. Weighted-point aggregate LOD (issue #315 plan G, G3) ──────────────
  // Same shape as the tile source above: resolved per dataset from the
  // service health, cleared by a live selection (aggregates are the
  // uniform-DoI at-rest base — focused views draw real geometry). The
  // renderer additionally gates drawing on `window.__lodAggregates`, so
  // resolving eagerly is harmless; the deep-link flag decides use per boot.
  const aggregateSourceRef = useRef<AggregateTileSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    aggregateSourceRef.current = null;
    rendererRef.current?.setAggregateSource(null);
    void resolveAggregateSource(undefined).then((source) => {
      if (cancelled) return;
      aggregateSourceRef.current = source;
      if (!hasSelection) rendererRef.current?.setAggregateSource(source);
    });
    return () => {
      cancelled = true;
    };
    // hasSelection is applied by the effect below; re-resolving per selection
    // change would refetch health needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalData]);
  // ─── 6d. Base-layer switch, DEFERRED to the field apply (issue #315 P7) ────
  // Both base layers are selection-gated: they render the uniform-DoI at-rest
  // image, so a focused view falls back to real geometry. Swapping them is a
  // VISIBLE change of how every point is drawn (the aggregate pass composes
  // `1-(1-a)^w` splats where the node pass draws raw points), and it used to
  // fire on the selection DISPATCH — i.e. the instant the DoI chip appeared,
  // a whole propagate RTT before the new field could exist. That is CS's "the
  // moment the loading bar appears every point gets slightly brighter, as if
  // everything had lower opacity": the image changed against the OLD field,
  // for no reason the user could attribute to their edit.
  //
  // Same remedy as the slider-commit uniform deferral (@fa1d1ce3): while a
  // selection workflow holds the lock the switch is only RECORDED, and the
  // workflow flushes it in the same block that uploads the new opacity field —
  // one atomic visual change per commit. Selection changes that never reach a
  // workflow (feature search) still apply immediately.
  const applyBaseLayerSources = useCallback((selectionActive: boolean) => {
    rendererRef.current?.setTileSource(selectionActive ? null : tileSourceRef.current);
    rendererRef.current?.setAggregateSource(
      selectionActive ? null : aggregateSourceRef.current
    );
  }, []);
  /** >0 while a selection workflow owns the next visual change. */
  const baseLayerHoldRef = useRef(0);
  /** The switch a held effect recorded; null when nothing is outstanding. */
  const pendingBaseLayerRef = useRef<boolean | null>(null);
  const releaseBaseLayerHold = useCallback(() => {
    if (baseLayerHoldRef.current > 0) baseLayerHoldRef.current -= 1;
    if (baseLayerHoldRef.current > 0) return;
    const pending = pendingBaseLayerRef.current;
    if (pending === null) return;
    pendingBaseLayerRef.current = null;
    applyBaseLayerSources(pending);
  }, [applyBaseLayerSources]);
  useEffect(() => {
    if (baseLayerHoldRef.current > 0) {
      pendingBaseLayerRef.current = hasSelection;
      return;
    }
    applyBaseLayerSources(hasSelection);
  }, [hasSelection, applyBaseLayerSources]);

  // ─── 7. Handle Resize ───────────────────────────────────────────────────────
  useCanvasResize({
    canvasContainerRef: webGLCanvasContainerRef,
    data: dataRef.current,
    zoomTransformRef,
    setScales,
    rendererRef,
    currentZoomParamsRef,
  });

  // ─── 8. Apply Visual Settings ──────────────
useEffect(() => {
  const api = rendererRef.current;
  if (!api || !dataRef.current.length) return;

  const prev = prevVisualSettingsRef.current;

  const paletteChanged =
    !prev ||
    prev.colorEncoding !== visualSettings.colorEncoding ||
    prev.colorPalette.length !== visualSettings.colorPalette.length ||
    prev.colorPalette.some((c, i) => c !== visualSettings.colorPalette[i]);

  const styleChanged =
    !prev ||
    prev.nodeRadius !== visualSettings.nodeRadius ||
    prev.nodeOutlineWidth !== visualSettings.nodeOutlineWidth ||
    prev.edgeWidth !== visualSettings.edgeWidth ||
    prev.arrowScale !== visualSettings.arrowScale;

  const opacityParamsChanged =
    !prev ||
    prev.grayOutDoiThreshold !== visualSettings.grayOutDoiThreshold ||
    prev.minimumOpacityClamping !== visualSettings.minimumOpacityClamping ||
    prev.maximumOpacityClamping !== visualSettings.maximumOpacityClamping;

  const {
    nodeRadius: _nr,
    nodeOutlineWidth: _now,
    edgeWidth: _ew,
    arrowScale: _as,
    colorPalette: _cp,
    colorEncoding: _ce,
    grayOutDoiThreshold: _gt,
    minimumOpacityClamping: _min,
    maximumOpacityClamping: _max,
    ...nextRest
  } = visualSettings;

  const {
    nodeRadius: _pnr,
    nodeOutlineWidth: _pnow,
    edgeWidth: _pew,
    arrowScale: _pas,
    colorPalette: _pcp,
    colorEncoding: _pce,
    grayOutDoiThreshold: _pgt,
    minimumOpacityClamping: _pmin,
    maximumOpacityClamping: _pmax,
    ...prevRest
  } = prev ?? visualSettings;

  const otherChanged =
    !!prev &&
    Object.keys(nextRest).some(
      (key) => (nextRest as Record<string, unknown>)[key] !== (prevRest as Record<string, unknown>)[key]
    );

  if (styleChanged) {
    api.setStyle({
      nodeRadius: visualSettings.nodeRadius,
      nodeOutlineWidth: visualSettings.nodeOutlineWidth,
      edgeWidth: visualSettings.edgeWidth,
      arrowScale: visualSettings.arrowScale,
    });
  }

  if (paletteChanged) {
    api.setColorMapping({
      colorPalette: visualSettings.colorPalette,
      colorEncoding: visualSettings.colorEncoding,
    });
    // Deferred color column (issue #315 R3c, §8.8a): the first switch to a
    // not-yet-fetched column triggers its one-time fetch (chip-visible),
    // then re-commits the SAME mapping — the renderer's color rebuild reads
    // the sidecar's byName at build time, so the re-commit colors for real.
    // Guarded at resolve time: a user who switched away keeps their choice.
    const encoding = visualSettings.colorEncoding;
    const nodes = dataRef.current;
    if (nodes.length && pendingDeferredColumns(nodes, [encoding]).length > 0) {
      void ensureResidentColumnsWithChip(nodes, [encoding], "Fetching column")
        .then(() => {
          const current = rendererRef.current;
          const settingsNow = store.getState().visualizationSettings;
          if (current && settingsNow.colorEncoding === encoding) {
            current.setColorMapping({
              colorPalette: settingsNow.colorPalette,
              colorEncoding: encoding,
            });
          }
        })
        .catch(() => undefined);
    }
  }

  if (opacityParamsChanged) {
    api.setOpacityParams({
      threshold: visualSettings.grayOutDoiThreshold,
      minAlpha: visualSettings.minimumOpacityClamping,
      maxAlpha: visualSettings.maximumOpacityClamping,
    });
  }

  if (otherChanged) {
    api.setVisualSettings(visualSettings);
  }

  // IMPORTANT:
  // No api.render() here. All setters schedule a frame internally.
  prevVisualSettingsRef.current = visualSettings;
}, [visualSettings, dataRef]);


  // ─── 9. Reclustering on Zoom/Scale ─────────────────────────────────────────
  // Cut arrivals landing mid-gesture must stay stashed (issue #315) — see
  // scheduleCutRefresh; the settle pass consumes the warm stash.
  useEffect(() => {
    setGestureActiveProvider(() => panGestureRef.current || isZoomingRef.current);
    // T0b: cut arrivals lay out for the wheel-burst destination when one is
    // announced, else the live per-event transform — never the stored one.
    setCurrentTransformProvider(
      () => wheelDestinationRef.current ?? zoomTransformRef.current
    );
    return () => {
      setGestureActiveProvider(null);
      setCurrentTransformProvider(null);
    };
  }, []);

  useEffect(() => {
    // Server-cut mode (issue #315): mid-gesture ticks only PREFETCH the cut
    // for the current viewport (warm stash) and defer all pipeline
    // application to the settle pass — the gesture compositor shows a cached
    // frame anyway, so mid-gesture reconcile/React/annealer bursts were pure
    // stutter (measured: insets-on pan 68 → 144 fps without them). Client-cut
    // datasets keep the #322 behavior (pan defers, zoom stays live).
    const gestureInFlight = panGestureRef.current || isZoomingRef.current;
    if (gestureInFlight && isServerCutActive()) {
      const container = webGLCanvasContainerRef.current;
      if (container && scales) {
        // Destination when a wheel burst announced one (T0); live transform
        // otherwise (pan/trackpad have no destination — current is correct).
        prefetchServerCut(
          container,
          scales,
          wheelDestinationRef.current ?? zoomTransformRef.current
        );
      }
      panSuppressedClusteringRef.current = true;
      return;
    }
    if (panGestureRef.current) {
      // Mid-pan settled ticks (client-cut): keep the current cut; the
      // gesture-end handler recomputes once for the final viewport (#322).
      panSuppressedClusteringRef.current = true;
      return;
    }
    performZoomClustering();
  }, [zoomTransform, scales, performZoomClustering]);

  // ─── 10. Initial Clustering ────────────────────────────────────────────────
  useInitialClustering({
    segmentsRef,
    canvasContainerRef: webGLCanvasContainerRef,
    scales,
    internalData,
    internalHdbscan,
    internalMidpointHdbscan,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
    performZoomClustering,
    skip: deepLinkHasSelection,
  });

  // ─── 11. Build & Store Interaction Behaviors ───────────────────────────────
  const [behaviors, setBehaviors] = useState<InteractionBehavior[]>([]);

  useEffect(() => {
    const webglCanvas = webGLCanvasContainerRef.current?.querySelector("canvas");
    const overlay = lassoOverlayRef.current;
    const renderer = rendererRef.current;

    // Do not gate interaction setup on the annotation layer.
    // That layer mounts after R-tree-backed overlays become available, which can
    // happen later than the first interactive render on initial dataset load.
    if (!webglCanvas || !overlay || !renderer || !scales) return;

    const zoomBehavior = createZoomBehavior(
      webglCanvas,
      () => currentZoomParamsRef.current,
      (t) => {
        // Per-event fast path: ref freshness + imperative layer transform.
        // React state follows at settled cadence via the trailing throttle.
        // Translation-only events (k unchanged) mark the gesture as a pan so
        // the reclustering effect defers to the gesture end (issue #322).
        panGestureRef.current = isZoomingRef.current && t.k === zoomTransformRef.current.k;
        zoomTransformRef.current = t;
        applyAnnotationTransform(t);
        settledZoomThrottle.push(t);
      },
      visualSettings,
      renderer,
      {
        onStart: () => {
          isZoomingRef.current = true;
        },
        onWheelDestination: (t) => {
          wheelDestinationRef.current = t;
          // Per-notch destination push (issue #315 T0): start the server
          // walk for the burst's endpoint NOW, overlapping the 150 ms ease
          // and the dwell instead of following them.
          if (t && isServerCutActive()) {
            const container = webGLCanvasContainerRef.current;
            const s = currentZoomParamsRef.current;
            if (container && s) prefetchServerCut(container, s, t);
          }
        },
        onEnd: () => {
          isZoomingRef.current = false;
          panGestureRef.current = false;
          wheelDestinationRef.current = null;
          settledZoomThrottle.flush();
          if (panSuppressedClusteringRef.current) {
            // Recompute the cut once for the final viewport. The flush above
            // usually triggers the reclustering effect too — its second run
            // hits the unchanged-cut dispatch gate and stays cheap.
            panSuppressedClusteringRef.current = false;
            performZoomClustering();
          }
        },
        onZoomReady: (handle) => {
          zoomApiRef.current = handle;
          setZoomReadyTick((t) => t + 1);
        },
      }
    );

    const lassoBehavior = createLassoBehavior({
      overlay,
      getNodes: () => dataRef.current,
      getScales: () => scales,
      getZoomTransform: () => zoomTransformRef.current,
      getRTree: () => rTreeRef.current,
      onComplete: handleLassoComplete,
      // Server-side hit-test (issue #315 A2): undefined unless the active
      // backend offers `select` — client-complete datasets keep the classic
      // local path untouched.
      resolveSelection: buildServerLassoResolver({
        getNodes: () => dataRef.current,
        getScales: () => scales,
        getZoomTransform: () => zoomTransformRef.current,
        // Fused select+propagate (issue #315 A3 / P-d): one POST resolves
        // the lasso AND propagates server-side; null keeps the A2 stateless
        // select (labeling, pins — the client field lane owns those, #337).
        getPropagateParams: () => {
          const eligible = serverPropagationEligible({
            nodeCount: dataRef.current.length,
            labeledExclusionActive: store.getState().labeling.unlabeledOnlyMode,
            pinnedCount: freehandPinnedIds(store.getState().freehand).size,
          });
          if (!eligible) return null;
          const s = currentSliderSettingsRef.current;
          return buildPropagateParams({
            proximitySlider: s.proximitySlider,
            pastSlider: s.pastSlider,
            futureSlider: s.futureSlider,
            maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
            grayOutDoiThreshold: s.grayOutDoiThreshold,
            annotationDoiThreshold: s.annotationDoiThreshold,
            insetDoiThreshold: s.insetDoiThreshold,
          });
        },
      }),
    });

    setBehaviors([zoomBehavior, lassoBehavior]);
    applyAnnotationTransform(zoomTransformRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- behavior setup runs only on data/scales/settings changes; callbacks are passed as getter closures over stable refs, and re-running per handler identity would rebuild d3 behaviors every render
  }, [internalData, scales, visualSettings]);

  useEffect(() => { applyAnnotationTransform(zoomTransformRef.current); }, [internalData]);

  // The annotation layer's transform is otherwise written ONLY from d3 zoom
  // events, so a transform that never passes through a gesture — the boot
  // fit, a deep-link viewbox, zoom-to-extent, a dataset switch — leaves the
  // overlay projecting at whatever transform it last saw while WebGL renders
  // the new one. That reads as contours and insets rigidly offset from (and
  // differently scaled to) the scatterplot, most visibly at full zoom-out
  // where the fit transform differs most from identity. Syncing on the
  // authoritative React transform closes every non-gesture path at once.
  // During a gesture the per-event path above owns the layer and is a frame
  // fresher than this throttled state, so defer to it.
  useEffect(() => {
    if (isZoomingRef.current) return;
    applyAnnotationTransform(zoomTransform);

    // Debug beacon (issue #315, same convention as __baseDrawDebug): the
    // overlay's HALF of the data→screen mapping. The annotation layer
    // projects with the UNZOOMED scales and takes the zoom as a CSS matrix,
    // while WebGL builds its own data→clip matrix — so the two agree only
    // if (scales ∘ transform) reproduces __baseDrawDebug.matrix. Emitted
    // here rather than in applyAnnotationTransform because that runs per
    // zoom EVENT and must stay allocation-free during a gesture.
    const canvasEl = webGLCanvasContainerRef.current?.querySelector("canvas");
    (window as unknown as { __annotationDrawDebug?: object }).__annotationDrawDebug = {
      transform: { k: zoomTransform.k, x: zoomTransform.x, y: zoomTransform.y },
      xDomain: scales?.xScale.domain(),
      xRange: scales?.xScale.range(),
      yDomain: scales?.yScale.domain(),
      yRange: scales?.yScale.range(),
      container: {
        w: webGLCanvasContainerRef.current?.clientWidth,
        h: webGLCanvasContainerRef.current?.clientHeight,
      },
      canvas: { w: canvasEl?.clientWidth, h: canvasEl?.clientHeight },
    };
  }, [zoomTransform, scales]);

  // ─── 11b. Re-apply the boot-window view (G4, see 5c) ───────────────────────
  // Runs on the commit where the data-driven scales land and behaviors have
  // re-attached (declared after the behaviors effect). Applying through the
  // d3 zoom instance updates renderer, refs, and React state coherently —
  // identical mechanism to the deep-link P5 viewbox jump.
  useEffect(() => {
    const vb = bootViewboxRef.current;
    if (!internalData || !vb || !scales) return;
    const handle = zoomApiRef.current;
    if (!handle) return;
    bootViewboxRef.current = null;
    const t = viewboxToTransform(vb, scales, handle.canvas.clientWidth, handle.canvas.clientHeight);
    if (t) handle.zoom.transform(d3.select(handle.canvas), t);
  }, [internalData, scales]);

  // ─── 12. Attach central dispatcher to container ────────────────────────────
  useCanvasInteractions(interactionParentRef, behaviors);

  // ─── 12.1. Enable keyboard shortcut for labeling mode (Ctrl+L) ─────────────
  // Use internalData directly — dataRef.current is set in a useEffect that runs
  // after render, so reading it inside useMemo always sees the previous value.
  // Column-backed arrays hand over a LAZY id source (issue #315 R1a A17) —
  // the eager map().filter() walked 1M row objects per boot for a count.
  const labelingNodeIds = useMemo(
    () => labelingNodeIdSourceFor(internalData, columnsOf(internalData ?? [])?.id ?? null),
    [internalData]
  );
  useLabelingModeKeyboardToggle(labelingNodeIds);
  useLabelingAutoSync();

  // ─── 13. Render ─────────────────────────────────────────────────────────────
  // Note: no zoomTransform here — useFeatureSearch never reads it, and its
  // presence re-created this object (and re-rendered the whole side panel)
  // on every settled zoom tick.
  const featureSearchDeps = useMemo(() => ({
    rendererRef,
    canvasContainerRef: webGLCanvasContainerRef,
    scales,
    visualSettings,
    currentSliderSettingsRef,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
    performZoomClustering,
  }), [
    scales, visualSettings,
    fullSelectionHdbscan, fullSelectionMidpointHdbscan,
    performZoomClustering
  ]);

  const currentDatasetSnapshot = useMemo(() => ({
    data: dataRef.current,
    datasetType: datasetMetadata.datasetType,
    sourcePath: datasetMetadata.datasetPath || undefined,
    hdbscan: internalHdbscan ?? undefined,
    midpointHdbscan: internalMidpointHdbscan ?? undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataRef.current is a deliberate content-bust: the snapshot must refresh on the re-render that follows background hydration swapping the array
  }), [
    dataRef.current,
    datasetMetadata.datasetType,
    datasetMetadata.datasetPath,
    internalHdbscan,
    internalMidpointHdbscan,
  ]);

  const runSelectionWorkflow = useCallback(async (selectedNodeIds: number[], options?: { clearFeatureSearch?: boolean; propagationOverride?: { proximitySlider: number; pastSlider: number; futureSlider: number } }) => {
    const epoch = bumpClusteringEpoch();
    // Hold the base-layer switch (see §6d): the selection dispatch that
    // brought us here must not repaint the cloud a propagate RTT before the
    // new field exists. Released at the field apply below and on every early
    // return, so a bailed workflow can never strand the hold.
    baseLayerHoldRef.current += 1;
    const nodes = dataRef.current;
    const renderer = rendererRef.current;
    const segs = segmentsRef.current;
    if (!nodes?.length || !renderer) {
      releaseBaseLayerHold();
      return;
    }

    const selectedSet = new Set(selectedNodeIds);
    const hasSelection = selectedNodeIds.length > 0;

    // Read labeling state directly from the store so we always have the latest
    // value without adding it to the dep array. (Moved above the marking loop:
    // the server-eligibility routing below needs both.)
    const labelingState = store.getState().labeling;
    const labeledNodeIds: Set<string> | undefined = labelingState.unlabeledOnlyMode
      ? new Set(labelingState.assignments.keys())
      : undefined;
    const freehandPinned = freehandPinnedIds(store.getState().freehand);

    // Deletion census T3 (plan §7.4): on the server-eligible branch the
    // cols.doi seed pre-write is dead — the server apply overwrites the
    // column before any reader sees it. node.selected stays (seeds, chain
    // clamp, stash validation); the field lane re-derives DoI wholesale on
    // the failure path, so no restore is needed (#337 PR B).
    const willTryServer = hasSelection && serverPropagationEligible({
      nodeCount: nodes.length,
      labeledExclusionActive: !!labeledNodeIds,
      pinnedCount: freehandPinned.size,
    });
    // Direct column writes where available (issue #315 F1): 1M accessor
    // setter calls per selection commit were measurable on their own.
    const selCols = columnsOf(nodes);
    if (selCols) {
      // `selected` is a column (issue #315 R1a, §3.1): the whole selection
      // lands as a typed-array clear plus one write per selected id, and the
      // maintained index list makes the server seed discovery O(selection).
      writeSelectionByIds(nodes, selectedNodeIds);
      if (!willTryServer) {
        const sel = selCols.selected;
        for (let i = 0; i < nodes.length; i++) {
          selCols.doi[i] = hasSelection ? sel[i] : 1;
        }
      }
    } else {
      for (const node of nodes) {
        node.selected = selectedSet.has(node.id);
        node.DoI = hasSelection ? (node.selected ? 1 : 0) : 1;
      }
    }

    const s = options?.propagationOverride ?? currentSliderSettingsRef.current;
    const grayOutDoiThreshold = currentSliderSettingsRef.current.grayOutDoiThreshold;
    const annotationDoiThreshold = currentSliderSettingsRef.current.annotationDoiThreshold;
    const insetDoiThreshold = currentSliderSettingsRef.current.insetDoiThreshold;
    const propagationSettings = {
      proximitySlider: s.proximitySlider,
      pastSlider: s.pastSlider,
      futureSlider: s.futureSlider,
      maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
      grayOutDoiThreshold,
      annotationDoiThreshold,
      insetDoiThreshold,
    };
    // Server-cut datasets (issue #315 A3 / P-d): the commit propagation is
    // ONE fused server RTT — either the lasso already stashed the overlay
    // (select+propagate fused in the resolver) or a seeds:{ids} POST goes
    // out here. Any failure falls through to the client field lane below
    // (#337 PR B — formerly the graph oracle; the field lane needs no kNN
    // graph, so the R3a trajectory-only degradation is gone).
    let serverApplied = false;
    if (willTryServer) {
      serverApplied = await propagateSelectionOnServer(nodes, propagationSettings);
      if (!isCurrentClusteringEpoch(epoch)) {
        releaseBaseLayerHold();
        return;
      }
    }
    // Client field lane (issue #315 field parity / #337): the local half of
    // the dispatch — server field > client field. Deselect routes through
    // too: it clears the resident field (the local mirror of
    // clearServerDoiState) and returns false, so the uniform reset below
    // still paints the frame. Labeled ids never seed, pins clamp to DoI 1 —
    // the lane owns both semantics (the graph oracle's contract).
    let localFieldApplied = false;
    if (!serverApplied) {
      propagationAbortRef.current?.abort();
      const controller = new AbortController();
      propagationAbortRef.current = controller;
      try {
        localFieldApplied = await runLocalFieldPropagation(
          nodes,
          propagationSettings,
          undefined,
          { signal: controller.signal, labeledNodeIds, pinnedNodeIds: freehandPinned }
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          releaseBaseLayerHold();
          return;
        }
        console.warn("[propagation] local field failed", err);
      }
      if (!isCurrentClusteringEpoch(epoch)) {
        releaseBaseLayerHold();
        return;
      }
    }
    // Deselect on a client-complete dataset (#337 PR B): the graph oracle's
    // full-space branch wrote the uniform doiGroup strings here; with the
    // bake inactive after the deselect reset, the strings ARE authoritative
    // again, so they must be rewritten (the seed write above already filled
    // DoI 1). Server-cut skips it — an unwritten ladder classifies "inset"
    // (the slider commit's twin branch has the full rationale).
    if (!serverApplied && !localFieldApplied && !hasSelection && !resolveCutProvider(undefined)) {
      for (const node of nodes) {
        updateNodeGroup(node, {
          grayOutDoiThreshold,
          annotationDoiThreshold,
          insetDoiThreshold,
        }, labeledNodeIds);
      }
    }
    // Deletion census 2026-07-24 (plan §7.4): on the server-cut path
    // edgeDoi's only reader (EdgeSegmentIndex.filtered) is unreachable —
    // the index is never built there — and midpoint DoI is write-only
    // (midpoint thresholds read endpoint DoIs via edgeDoiOf). Local paths
    // keep both writes bit-identically.
    if (!serverApplied) {
      updateEdgeColumnDois(segs, dataRef.current);
      updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
    }

    // Everything visual for this commit lands in ONE block: the deferred
    // base-layer switch, the uniforms, the field, then a single render.
    releaseBaseLayerHold();
    renderer.setOpacityParams({
      threshold: grayOutDoiThreshold,
      minAlpha: visualSettings.minimumOpacityClamping,
      maxAlpha: visualSettings.maximumOpacityClamping,
    });
    // Field-path fast lane (deletion census T4): the server/field apply
    // already materialized exactly this buffer (pins clamped in-buffer,
    // #337). Labeled commits deliberately set NO applied buffer, so they
    // land in the zeroing branch below and paint labeled points transparent.
    const fieldOpacity =
      serverApplied || localFieldApplied ? getAppliedFieldOpacity() : null;
    if (fieldOpacity && fieldOpacity.length === nodes.length) {
      renderer.setOpacityField(fieldOpacity);
    } else {
      const opacityValues = new Float32Array(nodes.length);
      if (!labeledNodeIds && !hasSelection && freehandPinned.size === 0) {
        opacityValues.fill(1); // uniform field — no per-point reads needed
      } else if (!labeledNodeIds && selCols) {
        // Column copy — no per-point DoI accessor calls (issue #315 F1).
        for (let i = 0; i < nodes.length; i++) opacityValues[i] = selCols.doi[i];
      } else {
        for (let i = 0; i < nodes.length; i++) {
          // In unlabeled-only mode, labeled nodes are capped to zero opacity so
          // they render visually transparent regardless of their computed DoI.
          opacityValues[i] = labeledNodeIds?.has(String(nodes[i].id)) ? 0 : (nodes[i].DoI ?? 1);
        }
      }
      renderer.setOpacityField(opacityValues);
    }
    renderer.render();

    try {
      if (options?.clearFeatureSearch) {
        store.dispatch(clearFeatureSearchQuery());
      }
      // Deselect on a server dataset (issue #315 P7 round 8): the propagate
      // routing above requires a selection, so an empty lasso never told the
      // server anything — it kept the lasso DoI state AND the fitted
      // subscription, and the reclustering below re-ranked against that
      // ghost. Clear BEFORE reclustering so the base re-init selects against
      // clean server state (probe: bench/p7-deselect-probe.mjs).
      if (!hasSelection) await clearServerDoiState();
      // Server-cut datasets (issue #315 S2b) ship no trees: fullSelectionHdbscan
      // is undefined, but reclustering must still run — the filtered-subset
      // case worker-fits from coords, the full-bundle case uses the cut provider.
      if (fullSelectionHdbscan || resolveCutProvider(undefined)) {
        await runHdbscanClusteringWithStatus(nodes, fullSelectionHdbscan, undefined, epoch);
        if (fullSelectionMidpointHdbscan || resolveCutProvider(undefined)) {
          await runTrajectoryMidpointClusteringWithStatus(
            trajectoryMidpointsRef.current,
            annotationDoiThreshold,
            fullSelectionMidpointHdbscan,
            undefined,
            epoch
          );
        }
      }
      if (isCurrentClusteringEpoch(epoch)) performZoomClustering();
    } catch (error) {
      console.error("Clustering error:", error);
    }
  }, [
    currentSliderSettingsRef,
    dataRef,
    performZoomClustering,
    releaseBaseLayerHold,
    rendererRef,
    segmentsRef,
    trajectoryMidpointsRef,
    visualSettings.maxEmbeddingDistance,
    visualSettings.minimumOpacityClamping,
    visualSettings.maximumOpacityClamping,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
  ]);

  // Deferred midpoint fit (#261 budget-0 semantics): the selection workflow
  // skips the midpoint FIT while relationInsetBudget is 0, so re-enabling the
  // budget must run it now for the current selection — otherwise the slider
  // silently does nothing until the next lasso.
  const relationInsetBudget = useSelector(
    (s: RootState) => s.clusterSettings.relationInsetBudget
  );
  useEffect(() => {
    if (relationInsetBudget <= 0 || !wasMidpointFitSkippedForBudget()) return;
    void (async () => {
      try {
        await runTrajectoryMidpointClusteringWithStatus(
          trajectoryMidpointsRef.current,
          currentSliderSettingsRef.current.annotationDoiThreshold,
          fullSelectionMidpointHdbscan
        );
        performZoomClustering();
      } catch (error) {
        console.error("Clustering error:", error);
      }
    })();
  }, [
    relationInsetBudget,
    fullSelectionMidpointHdbscan,
    performZoomClustering,
    trajectoryMidpointsRef,
    currentSliderSettingsRef,
  ]);

  const { handleLassoComplete } = useLassoSelection({
    rendererRef,
    scales,
    zoomTransform,
    visualSettings,
    currentSliderSettingsRef,
    performZoomClustering,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
    runSelectionWorkflow,
  });

  // ─── 12.2. Deep-link boot pipeline + copy-link capture ─────────────────────
  const { buildCurrentUrl } = useDeepLink({
    deepLink,
    internalData,
    scales,
    zoomReadyTick,
    zoomApiRef,
    zoomTransformRef,
    rendererRef,
    dataRef,
    webGLCanvasContainerRef,
    currentSliderSettingsRef,
    hasPrecomputedHdbscan: internalHdbscan != null,
    hasPrecomputedMidpointHdbscan: internalMidpointHdbscan != null,
    featureSearchDeps,
    runSelectionWorkflow,
    demoDeps: {
      setActiveTab,
      handlePropagationSliderChange,
      handlePropagationSliderFinalChange,
      lassoOverlayRef,
    },
  });

  // ─── Sidebar collapse (esp. embedded/widget: reclaim horizontal space) ────
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <ThemeProvider theme={appTheme}>
      <RendererApiProvider value={rendererRef}>
        <CurrentDatasetProvider value={currentDatasetSnapshot}>
        <SelectionWorkflowProvider value={runSelectionWorkflow}>
        <Box
          sx={{
            display: "flex",
            height: embedded ? "100%" : "100vh",
            width: embedded ? "100%" : "100vw",
            overflow: "hidden",
            backgroundColor: visualSettings.canvasBgColor,
          }}
          id="app"
        >
          {/* Kept mounted while collapsed so tab/panel state survives the toggle
              (SidePanel is memoized with identity-stable props — see AGENTS.md). */}
          <Box sx={{ display: sidebarCollapsed ? "none" : "contents" }}>
            <SidePanel
              activeTab={activeTab}
              hideDatasetTab={embedded}
              showLabelingTab={true}
              onTabChange={handleTabChange}
              tabButtonWidth={tabButtonWidth}
              sidePanelContentWidth={sidePanelContentWidth}
              handleDatasetSelected={handleDatasetSelectedWithPreview}  // ← wrapped
              onPredefinedPickStart={handlePredefinedPickStart}
              sliderSettings={sliderSettings}
              handlePropagationSliderChange={handlePropagationSliderChange}
              handlePropagationSliderFinalChange={handlePropagationSliderFinalChange}
              featureSearchDeps={featureSearchDeps}
              isReclustering={isReclustering}
              applyProjection={applyProjectionStable}
              restoreOriginalProjection={restoreOriginalProjectionStable}
              canRestoreProjection={canRestoreProjection}
            />
          </Box>

          <div
            ref={interactionParentRef}
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              overflow: "hidden",
              backgroundColor: visualSettings.canvasBgColor,
              border: "0px solid #fff",
              boxSizing: "border-box",
            }}
            onContextMenu={(e) => { e.preventDefault(); }}
          >
            <VisualizationContainer
              canvasContainerRef={webGLCanvasContainerRef}
              scales={scales!}
              zoomTransform={zoomTransform}
              data={dataRef.current}
              handleLassoComplete={handleLassoComplete}
              annotationLayerRef={annotationLayerMountRef}
              isZoomingRef={isZoomingRef}
              panGestureRef={panGestureRef}
              reheatRef={zoomReheatRef}
            />
            <ColorLegendDock />
            <CopyLinkButton buildUrl={buildCurrentUrl} />
            <Tooltip title={sidebarCollapsed ? "Show side panel" : "Hide side panel"} placement="right">
              <IconButton
                size="small"
                aria-label={sidebarCollapsed ? "Show side panel" : "Hide side panel"}
                onClick={() => setSidebarCollapsed((c) => !c)}
                data-interaction-ignore="true"
                sx={{
                  position: "absolute",
                  top: 8,
                  left: 8,
                  zIndex: 30,
                  backgroundColor: "rgba(255,255,255,0.85)",
                  border: "1px solid #ccc",
                  "&:hover": { backgroundColor: "#fff" },
                }}
              >
                {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              </IconButton>
            </Tooltip>
            <canvas
              ref={lassoOverlayRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 10,
              }}
            />
          </div>

          <GlobalProgressDock />
          <ServerLossWarning />
        </Box>
        </SelectionWorkflowProvider>
        </CurrentDatasetProvider>
      </RendererApiProvider>
    </ThemeProvider>
  );
};

export default App;
