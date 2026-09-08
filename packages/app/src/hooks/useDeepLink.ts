// src/hooks/useDeepLink.ts
//
// Boot-time application of a URL deep link (see utils/deepLink.ts for the
// scheme) plus the "copy link to current state" capture glue.
//
// The apply pipeline is a one-shot async sequence gated on the dataset having
// settled (internalData non-null implies presets are already in the store —
// applyDatasetAfterStyleCommit only publishes data after its preset gate):
//   P2 settings diffs → two rAFs so App's slider-sync effect refreshes
//      currentSliderSettingsRef before selection replay reads it
//   P3 wait for renderer/zoom/canvas readiness (rAF poll, 10 s timeout)
//   P4 selection replay: query via handleFeatureSearch, ids via
//      runSelectionWorkflow
//   P5 viewbox via zoom.transform on the d3 zoom instance, so renderer,
//      annotation layer, refs, and React state all follow the normal path;
//      with `fly=<ms|1>` in the link this becomes an animated d3 transition
//      instead of an instant jump, launched only after background loading
//      (progress tasks + HDBSCAN rehydration) has settled.
//
// `demo=1` runs the same pipeline staged as a demo choreography (see
// deepLinkDemo.ts): P2's diffs are deferred to an animated parameter glide
// after the replay, the query is typed / ghost lassos are drawn before P4,
// and P5 always flies. A comma list (`demo=fly,sel,params`) reorders the
// three phases; the codec normalizes it so `sel` always precedes `params`
// (utils/deepLink.ts parseDemoOrder). User input cancels the staging
// (remaining phases apply instantly, in the same order). Deliberately not
// gated on prefers-reduced-motion — see the demoActive comment in the effect.

import * as d3 from "d3";
import type { MutableRefObject, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import type { SliderSettings } from "../components/InterestTabSliders";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf, selectedIndicesOf } from "../dataPreprocessing/pointColumns";
import { findDatasetEntryBySlug } from "../datasets/catalog";
import type { RendererAPI } from "../gl/api/RendererAPI";
import { hasMidpointClusteringViewport, refreshClusterActivation } from "../clustering/hdbscanClustering";
import type { RootState } from "../store";
import store, {
  setFeatureSearchQuery,
  updateClusterSettings,
  updateSettings,
} from "../store";
import {
  buildDeepLinkUrl,
  captureDeepLinkState,
  DEFAULT_DEMO_ORDER,
  DEFAULT_FLY_MS,
  DeepLinkState,
  DemoPhase,
} from "../utils/deepLink";
import type { ScreenPoint } from "../utils/demoLasso";
import { computeViewbox, viewboxToTransform } from "../utils/viewboxUtils";
import {
  clearGhostLassos,
  createDemoCancellation,
  createSpotlight,
  DEMO_TIMINGS,
  demoSleep,
  drawGhostLassos,
  glideParameters,
  pickParameterTab,
  splitVisDiffs,
  spotlightRectOf,
  typeQueryIntoSearchInput,
} from "./deepLinkDemo";
import type { FeatureSearchDeps } from "./useFeatureSearch";
import { useFeatureSearch } from "./useFeatureSearch";

export interface ZoomApiHandle {
  zoom: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
  canvas: HTMLCanvasElement;
}

type Scales = {
  xScale: d3.ScaleLinear<number, number>;
  yScale: d3.ScaleLinear<number, number>;
};

interface UseDeepLinkParams {
  /** Parsed once from location.hash at mount; null disables the hook. */
  deepLink: DeepLinkState | null;
  internalData: DataPoint[] | null;
  scales: Scales | null;
  /** Bumped by App whenever onZoomReady delivers a fresh zoom instance. */
  zoomReadyTick: number;
  zoomApiRef: MutableRefObject<ZoomApiHandle | null>;
  zoomTransformRef: MutableRefObject<d3.ZoomTransform>;
  rendererRef: MutableRefObject<RendererAPI | null>;
  dataRef: MutableRefObject<DataPoint[]>;
  webGLCanvasContainerRef: RefObject<HTMLDivElement>;
  /**
   * Live propagation/threshold slider values. The proximity/past/future
   * sliders are deliberately NOT synced to Redux on drag (perf) — capture
   * must read them from here, not from visualizationSettings.
   */
  currentSliderSettingsRef: MutableRefObject<SliderSettings>;
  /**
   * Whether the loaded dataset ships precomputed (midpoint) HDBSCAN trees.
   * When it does, the pipeline waits for the rehydrated instances instead of
   * proceeding on a timeout: replaying a selection before they exist gets
   * clobbered by the initial-clustering pass that fires on their arrival.
   */
  hasPrecomputedHdbscan: boolean;
  hasPrecomputedMidpointHdbscan: boolean;
  featureSearchDeps: FeatureSearchDeps;
  runSelectionWorkflow: (
    selectedNodeIds: number[],
    options?: { clearFeatureSearch?: boolean }
  ) => Promise<void>;
  /** Staging handles for the `demo=1` choreography (see deepLinkDemo.ts). */
  demoDeps: {
    setActiveTab: (tab: number) => void;
    handlePropagationSliderChange: (s: SliderSettings) => void;
    handlePropagationSliderFinalChange: (s: SliderSettings) => Promise<void> | void;
    lassoOverlayRef: RefObject<HTMLCanvasElement>;
  };
}

const APPLY_TIMEOUT_MS = 10000;
// Safety valve only — the data waits below are condition-driven (rAF polls on
// actual readiness); this ceiling exists so a wedged pipeline can't hang the
// apply forever, not as an expected duration.
const DATA_READY_CEILING_MS = 120000;
// A fly-to launches only after the progress-task map has stayed empty this
// long: background work is chained (download → parse → prep → clustering),
// so a single empty sample can land in the gap between two tasks.
const FLY_IDLE_QUIET_MS = 500;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (cond()) return resolve(true);
      if (performance.now() - start > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function useDeepLink(params: UseDeepLinkParams): {
  /** Builds a shareable URL for the current state; null for non-catalog datasets. */
  buildCurrentUrl: () => string | null;
} {
  const {
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
    hasPrecomputedHdbscan,
    hasPrecomputedMidpointHdbscan,
    featureSearchDeps,
    runSelectionWorkflow,
    demoDeps,
  } = params;

  const dispatch = useDispatch();
  const { handleFeatureSearch, schemaReady } = useFeatureSearch(featureSearchDeps);

  // Latest-ref the replay entry points: the pipeline runs across several
  // frames and must not act through stale closures.
  const handleFeatureSearchRef = useRef(handleFeatureSearch);
  handleFeatureSearchRef.current = handleFeatureSearch;
  const runSelectionWorkflowRef = useRef(runSelectionWorkflow);
  runSelectionWorkflowRef.current = runSelectionWorkflow;
  const scalesRef = useRef(scales);
  scalesRef.current = scales;
  const schemaReadyRef = useRef(schemaReady);
  schemaReadyRef.current = schemaReady;
  // "Ready" = the dataset has no precomputed tree to wait for, or the
  // rehydrated instance has arrived. Condition-driven, not time-driven.
  const hdbscanReadyRef = useRef(false);
  hdbscanReadyRef.current =
    !hasPrecomputedHdbscan || featureSearchDeps.fullSelectionHdbscan != null;
  const midpointHdbscanReadyRef = useRef(false);
  midpointHdbscanReadyRef.current =
    !hasPrecomputedMidpointHdbscan || featureSearchDeps.fullSelectionMidpointHdbscan != null;
  const performZoomClusteringRef = useRef(featureSearchDeps.performZoomClustering);
  performZoomClusteringRef.current = featureSearchDeps.performZoomClustering;
  const demoDepsRef = useRef(demoDeps);
  demoDepsRef.current = demoDeps;

  // The query schema only (re)builds when a render re-reads the filled dataRef,
  // so the pipeline must be able to force a render before waiting on it.
  const [, setRenderNudge] = useState(0);

  // One-shot guard (also covers StrictMode double-invocation).
  const didApplyRef = useRef(false);

  useEffect(() => {
    if (!deepLink || didApplyRef.current) return;
    // Preconditions: dataset settled (presets already in store), scales ready,
    // zoom instance delivered. Ref-based readiness is polled inside.
    if (!internalData || !scales || !zoomApiRef.current) return;
    didApplyRef.current = true;

    // Demo choreography (`demo=1`): the same pipeline, but staged — settings
    // diffs are deferred to an animated parameter glide AFTER the selection
    // replay (human order), the query is typed / ghost lassos are drawn
    // before the replay, and the viewbox always flies. Any user input
    // cancels the staging; the remaining steps then apply instantly, so the
    // end state always equals the instant link's.
    // Deliberately NOT gated on prefers-reduced-motion: a demo link is an
    // explicitly authored demonstration (motion is its purpose), `fly=` never
    // honored the preference either, and any user input cancels the show.
    // The gate also made demos silently instant on machines with OS
    // animations disabled (incl. headless Chrome), which reads as broken.
    const demoActive = Boolean(deepLink.demo);
    const demoCancel = demoActive ? createDemoCancellation() : null;
    // `spot=1`: scrim with a cut-out following the currently-animated element.
    const spotlight = demoActive && deepLink.spotlight ? createSpotlight() : null;
    const demoCancelled = () => demoCancel?.cancelled() ?? true;

    // "Settled" = precomputed HDBSCAN instances rehydrated and every
    // registered progress task (download/parse/dataset prep/clustering/
    // renderer init) drained, sustained for a quiet window — background work
    // is chained, so a single empty sample can land in a gap between tasks.
    const waitForBackgroundSettle = async (): Promise<boolean> => {
      let quietSince: number | null = null;
      return waitFor(() => {
        const busy =
          !hdbscanReadyRef.current ||
          !midpointHdbscanReadyRef.current ||
          Object.keys((store.getState() as RootState).progress.tasks).length > 0;
        if (busy) {
          quietSince = null;
          return false;
        }
        if (quietSince === null) quietSince = performance.now();
        return performance.now() - quietSince >= FLY_IDLE_QUIET_MS;
      }, DATA_READY_CEILING_MS);
    };
    let settleDone = false;

    const apply = async () => {
      console.info(
        `useDeepLink: applying (settings s=${Object.keys(deepLink.visSettings).length} c=${Object.keys(deepLink.clusterSettings).length}, ` +
          `query=${deepLink.query ? `"${deepLink.query}"` : "no"}, sel=${deepLink.selectionIds?.length ?? 0} ids, ` +
          `vb=${deepLink.viewbox ? "yes" : "no"}, demo=${demoActive}, precomputed hdbscan=${hasPrecomputedHdbscan}/${hasPrecomputedMidpointHdbscan})`
      );
      // The demo's animated phases, in show order. Phases NOT in the list
      // still execute — silently, exactly like the instant link: params/sel
      // before the show (in instant-pipeline order), fly after it.
      const demoOrder: readonly DemoPhase[] = deepLink.demoOrder ?? DEFAULT_DEMO_ORDER;
      const demoAnimated = new Set<DemoPhase>(demoActive ? demoOrder : []);

      // P2 — settings diffs on top of the already-applied presets. A demo
      // defers them to the animated parameter glide after the replay —
      // unless the demo list omits `params`: then they apply instantly here,
      // exactly like the instant path.
      const hasVisDiffs = Object.keys(deepLink.visSettings).length > 0;
      const hasClusterDiffs = Object.keys(deepLink.clusterSettings).length > 0;
      if (!demoActive || !demoAnimated.has("params")) {
        if (hasVisDiffs) dispatch(updateSettings(deepLink.visSettings));
        if (hasClusterDiffs) dispatch(updateClusterSettings(deepLink.clusterSettings));
        if (hasVisDiffs || hasClusterDiffs) {
          // Two frames: one for React to commit the settings render, one for the
          // slider-sync effect to publish into currentSliderSettingsRef.
          await nextFrame();
          await nextFrame();
        }
      }

      // P3 — renderer/zoom/canvas readiness.
      const ready = await waitFor(() => {
        const canvas = zoomApiRef.current?.canvas;
        return Boolean(
          rendererRef.current &&
            zoomApiRef.current &&
            dataRef.current.length > 0 &&
            canvas &&
            canvas.clientWidth > 0 &&
            canvas.clientHeight > 0
        );
      }, APPLY_TIMEOUT_MS);
      if (!ready) {
        console.warn("useDeepLink: renderer/zoom not ready in time, aborting deep-link apply");
        return;
      }

      // DEMO sel staging — wait for background loading to settle so the
      // viewer watches a finished overview, orient with a beat, then perform
      // the selection visibly (typed query / ghost lassos). The REAL replay
      // is still the unmodified runSelectionReplay; this only adds the show
      // around it. The settle gate is attached to this phase (and to the
      // fly), not to a sequence position — whichever runs first pays it.
      const runDemoSelStaging = async () => {
        if (!settleDone) settleDone = await waitForBackgroundSettle();
        if (!settleDone) {
          console.warn("useDeepLink: demo — background work never settled, continuing");
        }
        if (!demoCancelled()) {
          demoDepsRef.current.setActiveTab(0);
          await demoSleep(DEMO_TIMINGS.beatAfterSettleMs, demoCancelled);
        }
        if (deepLink.query && !demoCancelled()) {
          if (spotlight) {
            const rect = spotlightRectOf(document.getElementById("feature-search-input"));
            if (rect) spotlight.moveTo(rect);
          }
          await typeQueryIntoSearchInput(deepLink.query, dispatch, demoCancelled);
        } else if (deepLink.selectionIds && deepLink.selectionIds.length > 0 && !demoCancelled()) {
          const overlay = demoDepsRef.current.lassoOverlayRef.current;
          const currentScales = scalesRef.current;
          if (overlay && currentScales) {
            const idSet = new Set(deepLink.selectionIds);
            const zt = zoomTransformRef.current;
            const targets: ScreenPoint[] = [];
            // Columnar id/position scan (issue #315 R1b): the demo ghost lasso
            // must not dereference a row-lazy array's holes.
            const ghostCols = columnsOf(dataRef.current);
            if (ghostCols) {
              for (let i = 0; i < ghostCols.count; i++) {
                if (!idSet.has(ghostCols.id[i])) continue;
                targets.push({
                  x: zt.applyX(currentScales.xScale(ghostCols.x[i])),
                  y: zt.applyY(currentScales.yScale(ghostCols.y[i])),
                });
              }
            } else {
              for (const node of dataRef.current) {
                if (!idSet.has(node.id)) continue;
                targets.push({
                  x: zt.applyX(currentScales.xScale(node.x)),
                  y: zt.applyY(currentScales.yScale(node.y)),
                });
              }
            }
            await drawGhostLassos(
              overlay,
              targets,
              demoCancelled,
              spotlight ? (rect) => spotlight.moveTo(rect) : undefined
            );
          }
        }
      };

      // P4 — selection replay (shared by the instant and demo paths).
      const runSelectionReplay = async () => {
        if (deepLink.query || (deepLink.selectionIds && deepLink.selectionIds.length > 0)) {
          // The rehydrated HDBSCAN instances arrive asynchronously after the
          // dataset. Replaying before they exist is worse than waiting: the
          // replay skips reclustering AND the initial-clustering pass that
          // fires on their arrival resets every node to DoI=1, wiping the
          // selection. Datasets without precomputed trees pass immediately.
          const hdbscanReady = await waitFor(
            () => hdbscanReadyRef.current && midpointHdbscanReadyRef.current,
            DATA_READY_CEILING_MS
          );
          if (!hdbscanReady) {
            console.warn("useDeepLink: HDBSCAN rehydration never completed, applying selection anyway");
          } else {
            console.info("useDeepLink: P4 hdbscan instances ready, replaying selection");
          }
        }
        if (deepLink.query) {
          // handleFeatureSearch does not write the query text itself.
          dispatch(setFeatureSearchQuery(deepLink.query));
          // Force a render so useFeatureSearch re-reads the now-filled dataRef
          // and builds its query schema, then wait for it (deferred effect).
          setRenderNudge((n) => n + 1);
          const schemaOk = await waitFor(() => schemaReadyRef.current, APPLY_TIMEOUT_MS);
          let matches = 0;
          if (!schemaOk) {
            console.warn("useDeepLink: query schema not ready in time, skipping query replay");
          } else {
            matches = await handleFeatureSearchRef.current(deepLink.query);
            if (matches === 0) {
              console.warn(`useDeepLink: query "${deepLink.query}" matched no points`);
            }
          }
          if (matches === 0) {
            // The replay replaces the (skipped) initial clustering — fall back
            // to the no-selection baseline so the app is not left unclustered.
            await runSelectionWorkflowRef.current([]);
          }
        } else if (deepLink.selectionIds && deepLink.selectionIds.length > 0) {
          await runSelectionWorkflowRef.current(deepLink.selectionIds);
          // Selection column (issue #315 R1a, §3.1): the count comes from the
          // maintained index list instead of a full-array row reduce.
          const matched =
            selectedIndicesOf(dataRef.current)?.length ??
            dataRef.current.reduce((n, p) => n + (p.selected ? 1 : 0), 0);
          console.info(
            `useDeepLink: P4 id replay done — ${matched} node(s) selected of ${deepLink.selectionIds.length} requested`
          );
          if (matched === 0) {
            console.warn("useDeepLink: sel= ids matched no nodes, falling back to no-selection baseline");
            await runSelectionWorkflowRef.current([]);
          }
        }
      };

      // DEMO parameter glide — the settings diffs P2 deferred, applied like a
      // human drag: the relevant tab is shown, discrete settings flip first,
      // then every numeric parameter glides to its target simultaneously.
      // glideParameters always lands the exact targets (even when cancelled),
      // so the end state matches the instant path.
      const runDemoParamsGlide = async () => {
        if (hasVisDiffs || hasClusterDiffs) {
          if (!demoCancelled()) await demoSleep(DEMO_TIMINGS.beatBeforeParamsMs, demoCancelled);
          const { sliderDiffs, discreteDiffs } = splitVisDiffs(deepLink.visSettings);
          if (!demoCancelled()) {
            // Stage the tab whose controls are about to move (workflow-tab
            // budgets stay on tab 0 — see pickParameterTab).
            demoDepsRef.current.setActiveTab(pickParameterTab(sliderDiffs, deepLink.clusterSettings));
            await demoSleep(DEMO_TIMINGS.beatAfterTabSwitchMs, demoCancelled);
            const panelRect = spotlightRectOf(document.getElementById("side-panel-content"));
            if (spotlight && panelRect) spotlight.moveTo(panelRect);
          }
          if (Object.keys(discreteDiffs).length > 0) {
            dispatch(updateSettings(discreteDiffs));
            if (!demoCancelled()) await demoSleep(DEMO_TIMINGS.beatAfterTabSwitchMs, demoCancelled);
          }
          await glideParameters(
            {
              dispatch,
              currentSliderSettings: () => currentSliderSettingsRef.current,
              handlePropagationSliderChange: demoDepsRef.current.handlePropagationSliderChange,
              handlePropagationSliderFinalChange:
                demoDepsRef.current.handlePropagationSliderFinalChange,
              clusterSettingsSnapshot: () => (store.getState() as RootState).clusterSettings,
            },
            sliderDiffs,
            deepLink.clusterSettings,
            demoCancelled
          );
          console.info("useDeepLink: demo parameter glide done");
        }
      };

      // P5 — viewbox, applied through the d3 zoom instance so gestures stay
      // continuous and all zoom consumers follow. In the default demo order
      // this runs last; a custom order may fly earlier. `silent` (fly omitted
      // from the demo list) makes it an instant jump with no staging, exactly
      // like the instant link's P5.
      const runViewboxPhase = async (silent = false) => {
        if (demoActive && !silent) {
          // Open the cut-out to the canvas so the flight itself is what draws
          // the eye; the scrim stays up for whatever phase follows and fades
          // once the whole show ends (after the phase loop below).
          const canvasRect = spotlightRectOf(zoomApiRef.current?.canvas ?? null);
          if (spotlight && canvasRect) spotlight.moveTo(canvasRect);
          if (!demoCancelled()) await demoSleep(DEMO_TIMINGS.beatBeforeFlyMs, demoCancelled);
        }
        if (deepLink.viewbox) {
          const handle = zoomApiRef.current;
          const currentScales = scalesRef.current;
          if (handle && currentScales) {
            const t = viewboxToTransform(
              deepLink.viewbox,
              currentScales,
              handle.canvas.clientWidth,
              handle.canvas.clientHeight
            );
            if (t) {
              const selection = d3.select(handle.canvas);
              // A demo always flies (default duration unless the link says
              // otherwise) — except when the viewer cancelled it or the demo
              // list omits `fly` (silent), then the jump is instant.
              const flyMs = silent
                ? undefined
                : demoActive && !demoCancelled()
                  ? deepLink.flyMs ?? DEFAULT_FLY_MS
                  : demoActive
                    ? undefined
                    : deepLink.flyMs;
              if (flyMs) {
                // Fly only once the app is visually settled — otherwise the
                // flight animates into a view whose contents are still popping
                // in (the demo staging above already waited). Instant links
                // skip this: their jump lands before the slow work anyway and
                // waiting would only delay first paint.
                if (!settleDone) {
                  settleDone = await waitForBackgroundSettle();
                  if (!settleDone) {
                    console.warn("useDeepLink: P5 background work never settled, flying anyway");
                  }
                }
                // Animated fly-to along d3's interpolateZoom path. Every tick
                // runs the normal "zoom" handler (renderer transform, annotation
                // layer, zoomTransformRef, throttled React state), and the
                // transition's start/end events let isZoomingRef gate
                // reclustering during flight — no bespoke plumbing needed.
                // Await settlement so P6 refreshes at the destination; an
                // interrupted flight (user gesture took over) is not an error.
                // Quartic in-out rather than the default cubic: interpolateZoom
                // aims for constant *perceived* velocity, which flattens mild
                // easing curves — cubic reads as a linear-speed flight.
                await selection
                  .transition()
                  .duration(flyMs)
                  .ease(d3.easePolyInOut.exponent(4))
                  .call(handle.zoom.transform, t)
                  .end()
                  .catch(() => undefined);
                console.info(`useDeepLink: P5 viewbox fly-to done (${flyMs} ms)`);
              } else {
                handle.zoom.transform(selection, t);
                console.info("useDeepLink: P5 viewbox applied");
              }
            } else {
              console.warn("useDeepLink: degenerate viewbox in link, skipping");
            }
          }
        }
      };

      // Phase dispatch. The instant path keeps its fixed sequence; a demo
      // animates exactly the listed phases in the link's (normalized) order —
      // the codec guarantees sel precedes params among them — while unlisted
      // phases run silently around the show, mirroring the instant pipeline:
      // params landed in P2 above, sel replays before the show, fly jumps
      // after it. P6 below stays tail-anchored either way.
      if (!demoActive) {
        await runSelectionReplay();
        await runViewboxPhase();
      } else {
        if (!demoAnimated.has("sel")) {
          await runSelectionReplay();
        }
        for (const phase of demoOrder) {
          if (phase === "sel") {
            await runDemoSelStaging();
            await runSelectionReplay();
            clearGhostLassos(demoDepsRef.current.lassoOverlayRef.current);
          } else if (phase === "params") {
            await runDemoParamsGlide();
          } else {
            await runViewboxPhase();
          }
        }
        if (!demoAnimated.has("fly")) {
          await runViewboxPhase(true);
        }
        // The show is over once the listed phases ran — fade the scrim now,
        // whatever the last phase was. P6 below is invisible housekeeping
        // whose cluster-refresh waits can burn tens of seconds (e.g. waiting
        // out a midpoint cut that never comes on datasets without
        // trajectories); it must never hold the spotlight open.
        spotlight?.dispose();
      }

      // P6 — settings-driven cluster refresh. Deep-linked cluster settings
      // (e.g. relationInsetBudget) can land before the clustering pipelines
      // are initialized; the unchanged-cut dispatch gate then never re-emits
      // the edge/node cuts under the new settings. Per the pipeline's own
      // invariant, settings-driven changes must force a refresh — but a
      // refresh fired before the MIDPOINT pipeline has run its first zoom cut
      // silently skips the edge pipeline (no stored viewport), so wait for
      // that first (soft: datasets without trajectories never get one).
      if (Object.keys(deepLink.clusterSettings).length > 0) {
        // Wait for the midpoint clustering itself (condition-driven; instant
        // for datasets without one), then for its first zoom cut — seeding it
        // ourselves if nothing else ran one (the initial pass's terminal cut
        // can be epoch-aborted by our replay).
        await waitFor(() => midpointHdbscanReadyRef.current, DATA_READY_CEILING_MS);
        let cutReady = await waitFor(() => hasMidpointClusteringViewport(), APPLY_TIMEOUT_MS);
        if (!cutReady) {
          performZoomClusteringRef.current();
          cutReady = await waitFor(() => hasMidpointClusteringViewport(), APPLY_TIMEOUT_MS);
          if (!cutReady) {
            console.info("useDeepLink: midpoint pipeline never produced a cut (dataset without trajectories?)");
          }
        }
        await nextFrame();
        await nextFrame();
        refreshClusterActivation();
        console.info("useDeepLink: P6 forced cluster refresh done");
      }
      console.info("useDeepLink: apply pipeline complete");
    };

    void apply()
      .catch((err) => {
        console.error("useDeepLink: failed to apply deep link", err);
      })
      .finally(() => {
        demoCancel?.dispose();
        spotlight?.dispose();
      });
  }, [deepLink, internalData, scales, zoomReadyTick, dispatch, zoomApiRef, rendererRef, dataRef, hasPrecomputedHdbscan, hasPrecomputedMidpointHdbscan, currentSliderSettingsRef, zoomTransformRef]);

  // Warn once about an unknown dataset slug (the app falls back to the
  // default startup dataset in that case).
  const warnedSlugRef = useRef(false);
  useEffect(() => {
    if (!deepLink?.datasetSlug || warnedSlugRef.current) return;
    warnedSlugRef.current = true;
    if (!findDatasetEntryBySlug(deepLink.datasetSlug)) {
      console.warn(`useDeepLink: unknown dataset slug "${deepLink.datasetSlug}"`);
    }
  }, [deepLink]);

  const buildCurrentUrl = useCallback((): string | null => {
    const s = store.getState() as RootState;
    const container = webGLCanvasContainerRef.current;
    const currentScales = scalesRef.current;

    let viewbox;
    if (container && currentScales) {
      try {
        viewbox = computeViewbox(container, currentScales, zoomTransformRef.current);
      } catch {
        viewbox = undefined;
      }
    }

    const state = captureDeepLinkState({
      // Overlay the live slider values: propagation sliders are not synced to
      // Redux on drag, so the store still holds their pre-drag values.
      visualizationSettings: { ...s.visualizationSettings, ...currentSliderSettingsRef.current },
      clusterSettings: s.clusterSettings,
      datasetType: s.dataset.datasetType,
      datasetPath: s.dataset.datasetPath,
      featureSearchQuery: s.ui.featureSearchQuery,
      selectedNodeIds: s.selection.selectedNodeIds,
      totalNodeCount: dataRef.current.length,
      viewbox,
    });
    return state ? buildDeepLinkUrl(state) : null;
  }, [webGLCanvasContainerRef, zoomTransformRef, dataRef, currentSliderSettingsRef]);

  return { buildCurrentUrl };
}
