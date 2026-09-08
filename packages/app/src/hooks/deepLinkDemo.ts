// src/hooks/deepLinkDemo.ts
//
// Staging helpers for the deep-link demo choreography (`demo=1`, see
// plan-demo-links.md): a demo link replays the workflow like a human —
// the query is typed / ghost lassos are drawn, then the diffed parameters
// glide from baseline to target, then the fly-to zooms in. The instant
// pipeline in useDeepLink.ts stays authoritative: these helpers only add
// the visible staging around it and MUST degrade to no-ops when cancelled
// (any user input), so the end state is always exactly the instant link's.

import * as d3 from "d3";
import type { Dispatch } from "redux";
import type { SliderSettings } from "../components/InterestTabSliders";
import type { ClusterSettings, VisualizationSettings } from "../store";
import { setFeatureSearchQuery, updateClusterSettings, updateSettings } from "../store";
import type { ScreenPoint } from "../utils/demoLasso";
import { computeGhostLassoPath, resamplePath, splitIntoRegions } from "../utils/demoLasso";

/** All durations in one place; hand-tuned, deliberately not URL-configurable. */
export const DEMO_TIMINGS = {
  beatAfterSettleMs: 800,
  typingMsPerChar: 40,
  beatAfterTypingMs: 300,
  lassoDrawMs: 1200,
  lassoHoldMs: 250,
  beatBeforeParamsMs: 500,
  beatAfterTabSwitchMs: 300,
  paramGlideMs: 1800,
  clusterGlideSteps: 8,
  beatBeforeFlyMs: 500,
  /** Region-split eps for ghost lassos, in screen px. */
  lassoRegionEpsPx: 56,
  lassoHullPadPx: 14,
  lassoResampleStepPx: 6,
} as const;

/** The vis-settings keys driven through the propagation-slider machinery. */
export const DEMO_SLIDER_KEYS = [
  "proximitySlider",
  "pastSlider",
  "futureSlider",
  "grayOutDoiThreshold",
  "annotationDoiThreshold",
  "insetDoiThreshold",
] as const satisfies readonly (keyof SliderSettings & keyof VisualizationSettings)[];

/**
 * Cluster-settings keys whose sliders live on the Workflow tab (tab 0):
 * `ClusterBudgetControl` (+ its unfold) and the edge-inset budget in
 * `WorkflowTabPanel.tsx`. Everything else only exists on the Advanced tab.
 */
export const WORKFLOW_TAB_CLUSTER_KEYS = [
  "maxActiveClusters",
  "splitThresholdFraction",
  "chainRescueBudget",
  "relationInsetBudget",
] as const satisfies readonly (keyof ClusterSettings)[];

/**
 * Which side-panel tab to stage for the parameter glide: Workflow (0) when
 * the moving controls are visible there — propagation/DoI sliders, or cluster
 * diffs that are all workflow-exposed budgets; Advanced (3) for other cluster
 * settings; Visual encodings (2) when only discrete vis settings flip.
 */
export function pickParameterTab(
  sliderDiffs: Partial<SliderSettings>,
  clusterDiffs: Partial<ClusterSettings>
): number {
  if (Object.keys(sliderDiffs).length > 0) return 0;
  const clusterKeys = Object.keys(clusterDiffs) as (keyof ClusterSettings)[];
  if (clusterKeys.length > 0) {
    return clusterKeys.every((k) => (WORKFLOW_TAB_CLUSTER_KEYS as readonly string[]).includes(k))
      ? 0
      : 3;
  }
  return 2;
}

/**
 * Splits deep-link vis diffs into the slider-driven numeric part (animated
 * through the preview/commit drag machinery) and everything else (discrete —
 * flipped instantly at glide start).
 */
export function splitVisDiffs(visSettings: Partial<VisualizationSettings>): {
  sliderDiffs: Partial<SliderSettings>;
  discreteDiffs: Partial<VisualizationSettings>;
} {
  const sliderDiffs: Partial<SliderSettings> = {};
  const discreteDiffs: Partial<VisualizationSettings> = { ...visSettings };
  for (const key of DEMO_SLIDER_KEYS) {
    const value = visSettings[key];
    if (typeof value === "number") {
      sliderDiffs[key] = value;
      delete discreteDiffs[key];
    }
  }
  return { sliderDiffs, discreteDiffs };
}

/**
 * User-input cancellation: any pointer/wheel/key input aborts the demo so the
 * viewer takes over a fully-applied state. Callers check `cancelled()` between
 * steps and per animation frame; `dispose()` removes the listeners.
 */
export function createDemoCancellation(): { cancelled: () => boolean; dispose: () => void } {
  let cancelled = false;
  const onInput = () => {
    cancelled = true;
  };
  const opts = { capture: true, passive: true } as const;
  window.addEventListener("pointerdown", onInput, opts);
  window.addEventListener("wheel", onInput, opts);
  window.addEventListener("keydown", onInput, opts);
  return {
    cancelled: () => cancelled,
    dispose: () => {
      window.removeEventListener("pointerdown", onInput, opts);
      window.removeEventListener("wheel", onInput, opts);
      window.removeEventListener("keydown", onInput, opts);
    },
  };
}

export interface SpotlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpotlightHandle {
  /** Fades the scrim in (first call) and glides the cut-out to `rect` (viewport px). */
  moveTo(rect: SpotlightRect): void;
  /** Fades the scrim out and removes it. Safe to call repeatedly. */
  dispose(): void;
}

const SPOTLIGHT_PAD_PX = 12;
const SPOTLIGHT_FADE_MS = 300;

/**
 * `spot=1`: a fixed translucent gray scrim over the whole page with a
 * rounded-rect cut-out that follows whatever the demo is currently animating
 * (search input while typing, lasso region while drawing, side panel during
 * the parameter glide). Implemented as an SVG mask; the hole's geometry
 * attributes are CSS-transitioned so it glides between targets. Pointer
 * events pass through — the scrim never blocks the cancel-on-input rule.
 */
export function createSpotlight(): SpotlightHandle {
  const NS = "http://www.w3.org/2000/svg";
  const maskId = `deep-link-spotlight-${Date.now().toString(36)}`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;" +
    `z-index:1350;opacity:0;transition:opacity ${SPOTLIGHT_FADE_MS}ms ease;`;

  const mask = document.createElementNS(NS, "mask");
  mask.setAttribute("id", maskId);
  const keep = document.createElementNS(NS, "rect");
  keep.setAttribute("width", "100%");
  keep.setAttribute("height", "100%");
  keep.setAttribute("fill", "#fff");
  const hole = document.createElementNS(NS, "rect");
  hole.setAttribute("fill", "#000");
  hole.setAttribute("rx", "10");
  // SVG2 geometry properties are CSS-animatable — the cut-out glides.
  hole.style.transition = "x 400ms ease, y 400ms ease, width 400ms ease, height 400ms ease";
  mask.append(keep, hole);

  const scrim = document.createElementNS(NS, "rect");
  scrim.setAttribute("width", "100%");
  scrim.setAttribute("height", "100%");
  scrim.setAttribute("fill", "rgba(80,80,80,0.5)");
  scrim.setAttribute("mask", `url(#${maskId})`);

  svg.append(mask, scrim);
  document.body.appendChild(svg);

  let disposed = false;
  return {
    moveTo(rect: SpotlightRect) {
      if (disposed) return;
      hole.style.setProperty("x", `${rect.x - SPOTLIGHT_PAD_PX}px`);
      hole.style.setProperty("y", `${rect.y - SPOTLIGHT_PAD_PX}px`);
      hole.style.setProperty("width", `${rect.width + 2 * SPOTLIGHT_PAD_PX}px`);
      hole.style.setProperty("height", `${rect.height + 2 * SPOTLIGHT_PAD_PX}px`);
      svg.style.opacity = "1";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      svg.style.opacity = "0";
      window.setTimeout(() => svg.remove(), SPOTLIGHT_FADE_MS + 50);
    },
  };
}

/** Viewport rect of a DOM element for the spotlight, or null when absent. */
export function spotlightRectOf(el: Element | null): SpotlightRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export function demoSleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (cancelled() || performance.now() - start >= ms) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/** Types the query into the (Redux-controlled) feature-search input. */
export async function typeQueryIntoSearchInput(
  query: string,
  dispatch: Dispatch,
  cancelled: () => boolean
): Promise<void> {
  for (let i = 1; i <= query.length; i++) {
    if (cancelled()) break;
    dispatch(setFeatureSearchQuery(query.slice(0, i)));
    await demoSleep(DEMO_TIMINGS.typingMsPerChar, cancelled);
  }
  // Guarantee the full query regardless of interruption — the replay that
  // follows must see the complete text.
  dispatch(setFeatureSearchQuery(query));
  if (!cancelled()) await demoSleep(DEMO_TIMINGS.beatAfterTypingMs, cancelled);
}

/**
 * Draws animated ghost lassos on the overlay canvas: one per spatial region
 * of the target points (multi-region = ctrl-composed selection), left to
 * right, using the real lasso's styling. Coordinates are screen px (the
 * overlay context is pre-scaled to CSS pixels by useOverlaySize).
 */
export async function drawGhostLassos(
  overlay: HTMLCanvasElement,
  targetScreenPoints: ScreenPoint[],
  cancelled: () => boolean,
  /** Called with each region's viewport-space bbox before it draws (spotlight). */
  onRegionRect?: (rect: SpotlightRect) => void
): Promise<void> {
  const ctx = overlay.getContext("2d");
  if (!ctx || targetScreenPoints.length === 0) return;

  const regions = splitIntoRegions(targetScreenPoints, DEMO_TIMINGS.lassoRegionEpsPx);
  const paths = regions.map((region) =>
    resamplePath(
      computeGhostLassoPath(region, DEMO_TIMINGS.lassoHullPadPx),
      DEMO_TIMINGS.lassoResampleStepPx
    )
  );

  const clear = () => ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
  const drawPath = (path: ScreenPoint[], upTo: number) => {
    if (upTo < 2) return;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < upTo; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.closePath();
    // Same look as createLassoBehavior so it reads as a real lasso.
    ctx.fillStyle = "rgba(128,128,128,0.2)";
    ctx.fill();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000";
    ctx.stroke();
  };

  for (let r = 0; r < paths.length; r++) {
    const path = paths[r];
    if (path.length < 2) continue;
    if (onRegionRect) {
      // Canvas-space bbox → viewport space (the canvas is positioned in-page).
      const canvasRect = overlay.getBoundingClientRect();
      const xs = path.map((p) => p.x);
      const ys = path.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      onRegionRect({
        x: canvasRect.left + minX,
        y: canvasRect.top + minY,
        width: Math.max(...xs) - minX,
        height: Math.max(...ys) - minY,
      });
    }
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const frame = () => {
        if (cancelled()) return resolve();
        const t = Math.min(1, (performance.now() - start) / DEMO_TIMINGS.lassoDrawMs);
        clear();
        for (let done = 0; done < r; done++) drawPath(paths[done], paths[done].length);
        drawPath(path, Math.max(2, Math.round(path.length * t)));
        if (t >= 1) return resolve();
        requestAnimationFrame(frame);
      };
      frame();
    });
    if (cancelled()) break;
    await demoSleep(DEMO_TIMINGS.lassoHoldMs, cancelled);
  }
  // Leave the completed lassos visible; the caller clears the overlay after
  // the selection has been applied.
}

export function clearGhostLassos(overlay: HTMLCanvasElement | null): void {
  const ctx = overlay?.getContext("2d");
  if (!overlay || !ctx) return;
  ctx.clearRect(0, 0, overlay.clientWidth, overlay.clientHeight);
}

export interface ParameterGlideContext {
  dispatch: Dispatch;
  /** Live slider values at glide start (the post-preset baseline). */
  currentSliderSettings: () => SliderSettings;
  handlePropagationSliderChange: (s: SliderSettings) => void;
  handlePropagationSliderFinalChange: (s: SliderSettings) => Promise<void> | void;
  clusterSettingsSnapshot: () => ClusterSettings;
}

/**
 * Glides every diffed parameter from its current value to its target
 * simultaneously with quartic in-out easing. Slider-driven vis params ride
 * the preview machinery per frame and commit once with exact targets (the
 * human-drag path); numeric cluster settings step a few throttled dispatches
 * and end exact. The final dispatches make Redux match the instant path (P2)
 * bit for bit.
 */
export async function glideParameters(
  ctx: ParameterGlideContext,
  sliderDiffs: Partial<SliderSettings>,
  clusterDiffs: Partial<ClusterSettings>,
  cancelled: () => boolean
): Promise<void> {
  const sliderKeys = Object.keys(sliderDiffs) as (keyof SliderSettings)[];
  const clusterKeys = Object.keys(clusterDiffs) as (keyof ClusterSettings)[];
  const hasSliders = sliderKeys.length > 0;
  const hasCluster = clusterKeys.length > 0;
  if (!hasSliders && !hasCluster) return;

  const ease = d3.easePolyInOut.exponent(4);
  const sliderStart = { ...ctx.currentSliderSettings() };
  const clusterStart = { ...ctx.clusterSettingsSnapshot() };
  const stepEvery = DEMO_TIMINGS.paramGlideMs / DEMO_TIMINGS.clusterGlideSteps;

  const clusterAt = (t: number): Partial<ClusterSettings> => {
    const out: Record<string, number> = {};
    for (const key of clusterKeys) {
      const from = clusterStart[key] as number;
      const to = clusterDiffs[key] as number;
      const v = from + (to - from) * t;
      // Most cluster settings are integer budgets/counts — land on integers
      // mid-glide; the final dispatch uses the exact target either way.
      out[key] = Number.isInteger(from) && Number.isInteger(to) ? Math.round(v) : v;
    }
    return out as Partial<ClusterSettings>;
  };

  if (!cancelled()) {
    const start = performance.now();
    let nextClusterStep = stepEvery;
    await new Promise<void>((resolve) => {
      const frame = () => {
        if (cancelled()) return resolve();
        const elapsed = performance.now() - start;
        const t = ease(Math.min(1, elapsed / DEMO_TIMINGS.paramGlideMs));
        if (hasSliders) {
          const s = { ...ctx.currentSliderSettings() };
          for (const key of sliderKeys) {
            s[key] = sliderStart[key] + ((sliderDiffs[key] as number) - sliderStart[key]) * t;
          }
          ctx.handlePropagationSliderChange(s);
        }
        if (hasCluster && elapsed >= nextClusterStep) {
          nextClusterStep += stepEvery;
          ctx.dispatch(updateClusterSettings(clusterAt(t)));
        }
        if (elapsed >= DEMO_TIMINGS.paramGlideMs) return resolve();
        requestAnimationFrame(frame);
      };
      frame();
    });
  }

  // Exact landing — identical end state to the instant path, cancelled or not.
  if (hasSliders) {
    const finalSliders = { ...ctx.currentSliderSettings(), ...sliderDiffs } as SliderSettings;
    await ctx.handlePropagationSliderFinalChange(finalSliders);
    ctx.dispatch(updateSettings(sliderDiffs as Partial<VisualizationSettings>));
  }
  if (hasCluster) {
    ctx.dispatch(updateClusterSettings(clusterDiffs));
  }
}
