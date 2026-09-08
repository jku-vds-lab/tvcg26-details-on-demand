// src/hooks/useInitializeRenderer.ts

import * as d3 from "d3";
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useEffect, useRef } from "react";

import { resolveAggregateSource, warmBootCut, type BackendManifest } from "@scaling";

import { useDataRef } from "../contexts/DataContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { sidecarColumnsFor, type PointColumns as SidecarPointColumns } from "../dataPreprocessing/columnSidecar";
import { isLazyRowArray } from "../dataPreprocessing/lazyRows";
import { columnsOf } from "../dataPreprocessing/pointColumns";
import { EMPTY_SEGMENT_COLUMNS } from "../dataPreprocessing/splineColumns";
import { createRendererAPI } from "../gl/api/createRendererAPI";
import type { RendererAPI } from "../gl/api/RendererAPI";
import type { RendererVisualSettings } from "../gl/api/types";
import { initWebGLRenderer } from "../gl/core/webglRenderer";
import store, {
  updateAnnotationActiveClusters,
  updateEdgeAnnotationActiveClusters,
  updateEdgeInsetActiveClusters,
  updateInsetActiveClusters,
  type VisualizationSettings,
} from "../store";
import type { KnnGraph } from "../types/graphTypes";
import { computeScales } from "../utils/computeScales";
import { createAndAppendCanvas } from "../utils/createAndAppendCanvas";
import { requestSwitchClear } from "../utils/clusteringSwitchGate";
import { ledgerEvent } from "../utils/insetLedger";
import { markDatasetLoadPhase } from "../utils/datasetLoadInstrumentation";

export interface UseInitializeRendererParams {
  canvasContainerRef: RefObject<HTMLDivElement>;
  internalData: DataPoint[] | null;

  /** Issue #315 G4: when set (server datasets booting from a deep link /
   * default entry), the renderer initializes EARLY from the backend's
   * aggregate pyramid meta — pan/zoomable base layer before any point
   * data downloads. Undefined (paper build, widget, external data) keeps
   * the data-driven init as the only path. */
  bootManifestPath?: string;

  /** Issue #315 G4 slice 2: set true while an aggregate-first base layer
   * (mount boot OR menu switch) is the live renderer, cleared the moment the
   * data-driven init replaces it. App reads it to decide whether to carry a
   * pre-data gesture over into the data view (the P5 viewbox mechanism). */
  aggregateBaseLiveRef: MutableRefObject<boolean>;

  // Keep these if dataset swaps can update them and should trigger a full re-init
  propKnnGraph?: KnnGraph;
  internalKnnGraph: KnnGraph;

  // Used only for initial init (ongoing updates go through RendererAPI setters elsewhere)
  visualSettings: VisualizationSettings;

  setScales: Dispatch<
    SetStateAction<{
      xScale: d3.ScaleLinear<number, number>;
      yScale: d3.ScaleLinear<number, number>;
    } | null>
  >;

  setZoomTransform: Dispatch<SetStateAction<d3.ZoomTransform>>;

  rendererRef: MutableRefObject<RendererAPI | null>;

  currentZoomParamsRef: MutableRefObject<{
    width: number;
    height: number;
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  } | null>;
}

function toRendererVisualSettings(s: VisualizationSettings): RendererVisualSettings {
  return {
    nodeRadius: s.nodeRadius,
    nodeOutlineWidth: s.nodeOutlineWidth,
    nodeOutlineWhite: s.nodeOutlineWhite,
    edgeWidth: s.edgeWidth,
    arrowScale: s.arrowScale,
    colorPalette: [...s.colorPalette],
    colorEncoding: s.colorEncoding,
    grayOutDoiThreshold: s.grayOutDoiThreshold,
    annotationDoiThreshold: s.annotationDoiThreshold,
    insetDoiThreshold: s.insetDoiThreshold,
    minimumOpacityClamping: s.minimumOpacityClamping,
    maximumOpacityClamping: s.maximumOpacityClamping,
    canvasBgColor: s.canvasBgColor,
  };
}

/** Parameters for {@link initAggregateFirstRenderer}. */
export interface AggregateFirstInitParams {
  container: HTMLDivElement;
  /** Boot manifest to fetch; its `backend` section resolves the aggregate
   * source (`@scaling` — the open-core stub resolves null, so the paper build
   * never installs anything and this is a silent no-op). */
  manifestPath: string;
  rendererRef: MutableRefObject<RendererAPI | null>;
  currentZoomParamsRef: MutableRefObject<{
    width: number;
    height: number;
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  } | null>;
  setScales: Dispatch<
    SetStateAction<{
      xScale: d3.ScaleLinear<number, number>;
      yScale: d3.ScaleLinear<number, number>;
    } | null>
  >;
  setZoomTransform: Dispatch<SetStateAction<d3.ZoomTransform>>;
  /** Called (after the async resolve) when this init has been superseded and
   * must abort WITHOUT touching the live renderer. The mount path passes the
   * slice-1 guards (`rendererRef.current || data landed`); the switch path
   * passes an epoch comparison, because on a switch the old data/renderer
   * legitimately still exist and only the epoch tells us we were superseded. */
  isSuperseded: () => boolean;
  /** Invoked synchronously right after the aggregate renderer is installed. */
  onInstalled?: () => void;
}

/**
 * Issue #315 G4 — aggregate-first init shared by the mount boot path (slice 1)
 * and the menu-switch path (slice 2). Fetches the boot manifest, resolves the
 * backend's aggregate source, and installs a renderer with EMPTY geometry +
 * scales from the aggregate bbox so a pan/zoomable base layer appears before
 * any point data downloads. Best-effort and silent: any failure (no backend,
 * unreachable service, open-core stub) returns without disposing or wiping,
 * so the caller's existing view is untouched.
 *
 * Returns a cleanup function that cancels the pending init and disposes the
 * renderer it created IF that renderer is still the live one (the data-driven
 * init replaces — and disposes — it itself otherwise).
 */
// Last aggregate-first extent (issue #315 P2): module-level (one live
// renderer at a time) so the data-driven install can assert data/base
// extent agreement without threading a ref through both paths.
let lastAggregateMeta: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

export function initAggregateFirstRenderer(params: AggregateFirstInitParams): () => void {
  const {
    container,
    manifestPath,
    rendererRef,
    currentZoomParamsRef,
    setScales,
    setZoomTransform,
    isSuperseded,
    onInstalled,
  } = params;

  let cancelled = false;
  let created: RendererAPI | null = null;

  void (async () => {
    let source;
    let warmBackend: BackendManifest | null = null;
    try {
      const res = await fetch(manifestPath);
      if (!res.ok) return;
      const manifest = (await res.json()) as { backend?: BackendManifest | null };
      if (!manifest.backend) return;
      warmBackend = manifest.backend;
      source = await resolveAggregateSource(manifest.backend);
    } catch {
      return; // silent no-op: the caller's existing view is untouched
    }
    // Aborted, no aggregate source, or superseded (real data landed for this
    // selection, or a newer selection took over) — never clobber the live view.
    if (cancelled || !source || isSuperseded()) return;

    // Dispose whatever renderer is currently live: on the switch path this is
    // the OLD dataset's renderer; on the mount path isSuperseded() guaranteed
    // it is null, so this is a no-op there.
    rendererRef.current?.dispose();
    rendererRef.current = null;

    const latestVisualSettings = toRendererVisualSettings(
      store.getState().visualizationSettings
    );
    container.style.backgroundColor = latestVisualSettings.canvasBgColor ?? "#ffffff";
    container.innerHTML = "";
    const canvas = createAndAppendCanvas(container);
    const meta = source.meta;
    lastAggregateMeta = meta;
    // computeScales only reads x/y — the bbox corners reproduce the exact
    // fit the full dataset would produce.
    const corners = [
      { x: meta.minX, y: meta.minY },
      { x: meta.maxX, y: meta.maxY },
    ] as DataPoint[];
    const { xScale, yScale } = computeScales(canvas.width, canvas.height, corners);
    setScales({ xScale, yScale });
    currentZoomParamsRef.current = {
      width: canvas.width,
      height: canvas.height,
      xScale,
      yScale,
    };
    // Subscribe-first boot (issue #315 P4): the manifest + bbox + canvas are
    // everything the cut subscription needs — open it NOW so the server
    // walks the boot viewport and pushes pre-rendered inset content while
    // columns.bin is still downloading. initServerCut's own subscribe
    // replaces the stream later (module-registry semantics) either way.
    if (warmBackend) {
      try {
        const cs = store.getState().clusterSettings;
        // The warm viewport must be the view the user actually SEES — the
        // padded square fit the scales produce — not the raw bbox, or the
        // warm walk/key targets a narrower viewport than the service's
        // first request and the pre-rendered content misses the mount set.
        const viewbox = {
          minX: xScale.invert(0),
          maxX: xScale.invert(canvas.width),
          minY: Math.min(yScale.invert(0), yScale.invert(canvas.height)),
          maxY: Math.max(yScale.invert(0), yScale.invert(canvas.height)),
        };
        warmBootCut(warmBackend, viewbox, canvas.width, canvas.height, {
          splitThresholdFraction: cs.splitThresholdFraction,
          gapDisclosurePx: cs.gapDisclosurePx,
        });
      } catch {
        /* warming is best-effort */
      }
    }
    markDatasetLoadPhase("renderer:init");
    const webglRenderer = initWebGLRenderer(
      canvas,
      canvas.width,
      canvas.height,
      xScale,
      yScale,
      [],
      EMPTY_SEGMENT_COLUMNS,
      latestVisualSettings
    );
    const api = createRendererAPI(webglRenderer, {
      initialEdges: EMPTY_SEGMENT_COLUMNS,
      initialVisualSettings: latestVisualSettings,
    });
    created = api;
    rendererRef.current = api;
    api.setAggregateSource(source);
    setZoomTransform(d3.zoomIdentity);
    onInstalled?.();
  })();

  return () => {
    cancelled = true;
    // Dispose only when the aggregate renderer is still the live one — the
    // data init (or a later switch) replaces (and disposes) it itself.
    if (created && rendererRef.current === created) {
      created.dispose();
      rendererRef.current = null;
    }
  };
}

/** Parameters for {@link installColumnsFirstRenderer}. */
export interface ColumnsFirstInstallParams {
  container: HTMLDivElement;
  rendererRef: MutableRefObject<RendererAPI | null>;
  currentZoomParamsRef: MutableRefObject<{
    width: number;
    height: number;
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  } | null>;
  setScales: Dispatch<
    SetStateAction<{
      xScale: d3.ScaleLinear<number, number>;
      yScale: d3.ScaleLinear<number, number>;
    } | null>
  >;
  setZoomTransform: Dispatch<SetStateAction<d3.ZoomTransform>>;
}

/**
 * Issue #315 B3 — columns-first init for CLIENT-COMPLETE sidecar datasets.
 * The aggregate-first path above needs a backend; datasets whose first pixels
 * come from the binary column sidecar (chess, fashion, cctv, …) had no live
 * renderer when the loader's boot paint fired, so the paint went nowhere and
 * first DATA draw waited for the full refs → mount tail. This installs the
 * same empty-geometry boot renderer the aggregate path uses — scales from the
 * sidecar's own x/y extent (bit-identical to what the data-driven init will
 * recompute from the rows) — then hands it the columns paint. The data-driven
 * init replaces (and disposes) it wholesale at boot:commit, exactly like the
 * aggregate-first instance; until then gestures work but lasso/hover stay
 * inert (the documented B1 boot window).
 *
 * Synchronous and best-effort: returns false (touching nothing) when the
 * sidecar lacks numeric x/y views or the extent is degenerate.
 */
export function installColumnsFirstRenderer(
  cols: SidecarPointColumns,
  params: ColumnsFirstInstallParams
): boolean {
  const { container, rendererRef, currentZoomParamsRef, setScales, setZoomTransform } = params;
  const x = cols.byName["x"];
  const y = cols.byName["y"];
  if (!(x instanceof Float64Array) || !(y instanceof Float64Array) || cols.count === 0) {
    return false;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < cols.count; i++) {
    const xi = x[i], yi = y[i];
    if (xi < minX) minX = xi;
    if (xi > maxX) maxX = xi;
    if (yi < minY) minY = yi;
    if (yi > maxY) maxY = yi;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return false;
  }

  // Replace whatever is live: null on a first boot, the PREVIOUS dataset's
  // data renderer on a switch (keeping it would paint the new columns into
  // the old view's scales). The aggregate-first boot instance never reaches
  // here — the caller feeds it setColumnData directly.
  rendererRef.current?.dispose();
  rendererRef.current = null;

  const latestVisualSettings = toRendererVisualSettings(store.getState().visualizationSettings);
  container.style.backgroundColor = latestVisualSettings.canvasBgColor ?? "#ffffff";
  container.innerHTML = "";
  const canvas = createAndAppendCanvas(container);
  // computeScales only reads x/y — the extent corners reproduce the exact
  // fit the data-driven init will produce from the full rows.
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: maxY },
  ] as DataPoint[];
  const { xScale, yScale } = computeScales(canvas.width, canvas.height, corners);
  setScales({ xScale, yScale });
  currentZoomParamsRef.current = {
    width: canvas.width,
    height: canvas.height,
    xScale,
    yScale,
  };
  markDatasetLoadPhase("renderer:init:columns-first");
  const webglRenderer = initWebGLRenderer(
    canvas,
    canvas.width,
    canvas.height,
    xScale,
    yScale,
    [],
    EMPTY_SEGMENT_COLUMNS,
    latestVisualSettings
  );
  const api = createRendererAPI(webglRenderer, {
    initialEdges: EMPTY_SEGMENT_COLUMNS,
    initialVisualSettings: latestVisualSettings,
  });
  rendererRef.current = api;
  api.setColumnData?.(cols);
  setZoomTransform(d3.zoomIdentity);
  return true;
}

/** Imperative controls returned by {@link useInitializeRenderer}. */
export interface InitializeRendererControls {
  /** Issue #315 G4 slice 2: begin an aggregate-first base for a menu-selected
   * internal catalog dataset. Bumps the selection epoch, aborts any previous
   * switch's pending init, and installs the new dataset's aggregate base as
   * soon as its (small) fetch lands — instead of after the full ingest. The
   * data-driven init replaces it wholesale when the download completes.
   * Silent no-op for serverless datasets (the aggregate source resolves null). */
  beginDatasetSwitch: (manifestPath: string) => void;
}

export function useInitializeRenderer({
  canvasContainerRef,
  internalData,
  bootManifestPath,
  aggregateBaseLiveRef,
  propKnnGraph,
  internalKnnGraph,
  visualSettings,
  setScales,
  setZoomTransform,
  rendererRef,
  currentZoomParamsRef,
}: UseInitializeRendererParams): InitializeRendererControls {
  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();

  // Issue #315 G4 slice 2 — selection epoch. Bumped at mount and at every
  // dataset switch; an aggregate-first init aborts if a newer selection took
  // over (epoch moved) or if the data for its OWN selection has already
  // landed. This is the ONLY correct supersede test on the switch path — the
  // slice-1 guards (`rendererRef.current`, `dataRef.length`) don't generalize
  // there because the old renderer/data legitimately still exist.
  const selectionEpochRef = useRef(0);
  const dataLandedEpochRef = useRef(-1);
  // Cleanup of the most recent switch's pending aggregate init, so a rapid
  // A→B→C double-switch disposes each superseded init.
  const switchCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container || !internalData || internalData.length === 0) return;

    // Full teardown + recreate only on dataset/init triggers (NOT on visualSettings changes)
    rendererRef.current?.dispose();
    rendererRef.current = null;

    container.style.backgroundColor = visualSettings.canvasBgColor ?? "#ffffff";
    container.innerHTML = "";

    const canvas = createAndAppendCanvas(container);

    // Preserve existing behavior: compute scales using the canvas dimensions that
    // createAndAppendCanvas sets up (same as before).
    const { xScale, yScale } = computeScales(canvas.width, canvas.height, dataRef.current);
    setScales({ xScale, yScale });

    // Extent assert (issue #315 P2, dev-only): the aggregate base and the
    // real data share computeScales, so a visible base/data mismatch can
    // only mean the EXTENTS disagree — i.e. a data-completeness bug (slim
    // loader dropping rows), never a projection bug. Surface it here so it
    // can't be misdiagnosed again.
    if (process.env.NODE_ENV !== "production" && lastAggregateMeta) {
      const m = lastAggregateMeta;
      const pts = dataRef.current;
      // Columnar extents (issue #315 R1a A14 / R1b): dev IS the profiling
      // config, so this assert must not re-introduce an O(N) row walk — and on
      // the row-lazy lane, which is exactly the aggregate/server lane this
      // assert guards, the rows do not exist.
      const extentCols = columnsOf(pts);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const n = extentCols ? extentCols.count : pts.length;
      for (let i = 0; i < n; i++) {
        const x = extentCols ? extentCols.x[i] : pts[i].x;
        const y = extentCols ? extentCols.y[i] : pts[i].y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const spanX = m.maxX - m.minX || 1;
      const spanY = m.maxY - m.minY || 1;
      if (
        Math.abs(minX - m.minX) > 0.05 * spanX ||
        Math.abs(maxX - m.maxX) > 0.05 * spanX ||
        Math.abs(minY - m.minY) > 0.05 * spanY ||
        Math.abs(maxY - m.maxY) > 0.05 * spanY
      ) {
        console.warn("[extent-assert] data extent deviates >5% from the aggregate meta bbox", {
          data: { minX, minY, maxX, maxY },
          meta: { minX: m.minX, minY: m.minY, maxX: m.maxX, maxY: m.maxY },
        });
      }
    }

    currentZoomParamsRef.current = {
      width: canvas.width,
      height: canvas.height,
      xScale,
      yScale,
    };

    const latestVisualSettings = toRendererVisualSettings(
      store.getState().visualizationSettings
    );
    markDatasetLoadPhase("renderer:init");
    const renderSegments = segmentsRef.current ?? EMPTY_SEGMENT_COLUMNS;
    const renderNodes = dataRef.current;

    // Create WebGL renderer + wrap with API
    const webglRenderer = initWebGLRenderer(
      canvas,
      canvas.width,
      canvas.height,
      xScale,
      yScale,
      [],
      EMPTY_SEGMENT_COLUMNS,
      latestVisualSettings
    );

    const api = createRendererAPI(webglRenderer, {
      initialEdges: renderSegments,
      initialVisualSettings: latestVisualSettings,
    });

    rendererRef.current = api;

    // Ensure color/style is committed on the fresh renderer instance before
    // the first visible streamed chunk appears.
    api.setColorMapping({
      colorPalette: latestVisualSettings.colorPalette,
      colorEncoding: latestVisualSettings.colorEncoding,
    });
    api.setStyle({
      nodeRadius: latestVisualSettings.nodeRadius,
      nodeOutlineWidth: latestVisualSettings.nodeOutlineWidth,
      edgeWidth: latestVisualSettings.edgeWidth,
      arrowScale: latestVisualSettings.arrowScale,
    });
    api.setOpacityParams({
      threshold: latestVisualSettings.grayOutDoiThreshold,
      minAlpha: latestVisualSettings.minimumOpacityClamping,
      maxAlpha: latestVisualSettings.maximumOpacityClamping,
    });

    // Single upload — no tile-by-tile reveal. The reveal predates client-side
    // derivation (issue #315): data used to trickle in over the network, so
    // streaming the draw doubled as progress feedback. With geometry fully
    // resident before the first frame it was pure theater, and its priming
    // pass caused a full-frame flash before the checkerboard (CS 2026-07-17).
    api.setVisualSettings(latestVisualSettings);
    api.setData(renderNodes, renderSegments);
    // Row-lazy lane (issue #315 R1b): the canonical array has holes, so hand
    // the renderer the sidecar columns alongside the rows — columns mode then
    // survives setData and every per-point read (positions, color discovery,
    // node colors) stays a typed-array indexing. The renderer drops them again
    // by itself once a contract member materializes the rows.
    if (isLazyRowArray(renderNodes)) {
      const sidecar = sidecarColumnsFor(renderNodes);
      if (sidecar) api.setColumnData?.(sidecar);
    }
    markDatasetLoadPhase("renderer:data");

    // Reset zoom only when re-initializing (dataset swap), not for style/palette tweaks
    setZoomTransform(d3.zoomIdentity);

    // Issue #315 G4 slice 2 — the data for the current selection has landed and
    // now owns the renderer. Record its epoch (so an in-flight aggregate-first
    // init for the same selection aborts instead of downgrading back to the
    // aggregate base), close the aggregate-base window, and cancel any pending
    // switch init.
    dataLandedEpochRef.current = selectionEpochRef.current;
    aggregateBaseLiveRef.current = false;
    switchCleanupRef.current?.();
    switchCleanupRef.current = null;

    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- full teardown+recreate must run only on dataset/init triggers, never on visualSettings changes (live changes go through RendererAPI setters); the omitted refs are stable
  }, [canvasContainerRef, internalData, propKnnGraph, internalKnnGraph, setScales, setZoomTransform]);

  // Issue #315 G4 — early boot: a pan/zoomable aggregate base layer BEFORE
  // any point data downloads. Mount-only, best-effort, server datasets
  // only: it fetches the boot manifest (small; the loader's own fetch hits
  // the HTTP cache), resolves the backend's aggregate source (@scaling —
  // the open-core stub resolves null, so the paper build never enters
  // this path), and initializes the renderer with EMPTY geometry + scales
  // from the aggregate bbox. The aggregate layer then serves the base
  // imagery and the existing behaviors effect attaches zoom/pan to the
  // early canvas. The data-driven init above replaces all of this
  // wholesale (dispose + container wipe + fresh scales) when downloads
  // land — the bbox-derived scales match the data-derived ones because
  // both fit the same extent. Slice 2 extracted the body into
  // initAggregateFirstRenderer; the mount path keeps its slice-1 guards
  // (real data / renderer already present) via isSuperseded.
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container || !bootManifestPath || internalData) return;
    return initAggregateFirstRenderer({
      container,
      manifestPath: bootManifestPath,
      rendererRef,
      currentZoomParamsRef,
      setScales,
      setZoomTransform,
      isSuperseded: () => !!rendererRef.current || dataRef.current.length > 0,
      onInstalled: () => {
        aggregateBaseLiveRef.current = true;
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only boot window; every later transition is owned by the data-driven init above / beginDatasetSwitch
  }, []);

  // Issue #315 G4 slice 2 — menu-switch aggregate-first init. Kicked from
  // App at CLICK time (before the download) with the newly-selected internal
  // dataset's manifest path, so its aggregate base appears ~1 s after the
  // click instead of after the full ingest. Uses the epoch as the sole
  // supersede test (the old renderer/data legitimately still exist here).
  const beginDatasetSwitch = (manifestPath: string) => {
    const container = canvasContainerRef.current;
    if (!container) return;
    // Abort any previous switch's still-pending init (rapid A→B→C switches).
    switchCleanupRef.current?.();
    const myEpoch = selectionEpochRef.current + 1;
    selectionEpochRef.current = myEpoch;
    switchCleanupRef.current = initAggregateFirstRenderer({
      container,
      manifestPath,
      rendererRef,
      currentZoomParamsRef,
      setScales,
      setZoomTransform,
      isSuperseded: () =>
        selectionEpochRef.current !== myEpoch || dataLandedEpochRef.current >= myEpoch,
      onInstalled: () => {
        aggregateBaseLiveRef.current = true;
        // The OLD dataset's cluster overlays (insets, annotations, contours)
        // are meaningless over the new base — their data coords land at
        // unrelated screen positions under the new scales (CS field report,
        // 2026-07-20 round 3). Retire the old clustering pipelines FIRST
        // (round 4: they kept answering settled ticks and re-dispatched
        // their actives right back), then clear every actives surface. The
        // new dataset's init rebuilds everything after ingest.
        ledgerEvent("switch:overlayClear");
        requestSwitchClear();
        store.dispatch(updateAnnotationActiveClusters([]));
        store.dispatch(updateInsetActiveClusters([]));
        store.dispatch(updateEdgeAnnotationActiveClusters([]));
        store.dispatch(updateEdgeInsetActiveClusters([]));
      },
    });
  };

  return { beginDatasetSwitch };
}
