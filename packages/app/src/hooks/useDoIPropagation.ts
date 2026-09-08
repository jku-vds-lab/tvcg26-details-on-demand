import { useCallback, useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { SliderSettings } from "../components/InterestTabSliders";
import { useDataRef } from "../contexts/DataContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import { resolveCutProvider } from "@scaling";
import { updateTrajectoryMidpointDoIs } from "../dataPreprocessing/dataPreprocessing";
import { updateEdgeColumnDois } from "../dataPreprocessing/splineColumns";
import { columnsOf, doiOpacityField, hasAnySelected } from "../dataPreprocessing/pointColumns";
import { setLiveSliderSettings } from "../stores/liveSliderSettingsStore";
import { notifyDoiStateInvalidation } from "../doiPropagation/doiStateInvalidation";
import { getPropagationPrecomputation, updateNodeGroup } from "../doiPropagation/propagateDoi";
import {
  applyResidentFieldLocally,
  canReuseResidentField,
  fieldPreviewExclusionsActive,
  fieldPreviewRequiresSync,
  getAppliedFieldOpacity,
  getFalloffShape,
  getFieldPreviewRaster,
  getResidentField,
  getSeedClampIndices,
  hasResidentFieldPreview,
  previewFalloffOpacity,
  propagateSliderCommitOnServer,
  runLocalFieldPropagation,
  serverPropagationEligible,
  snapshotCoords,
} from "../doiPropagation/serverPropagation";
import {
  buildChainJumpTables,
  type ChainJumpTables,
} from "../doiPropagation/chainJumpTables";
import { gpuMotionLaneEnabled } from "../doiPropagation/gpuMotionFlag";
import {
  createGpuMotionAdaptiveRes,
  resolveMotionGridRes,
} from "../doiPropagation/gpuMotionAdaptiveRes";
import { CONV_RESPREAD_FLOOR } from "../doiPropagation/convergedField";
import {
  FIELD_GRID_RESOLUTION,
  rasterize,
} from "../doiPropagation/fieldDistanceCore";
import {
  computeFrozenChain,
  type FieldPreviewShape,
  type FrozenChainLayers,
} from "../doiPropagation/fieldPreviewCore";
import {
  truthLaneArmed,
  truthLaneComplete,
  truthLaneInitial,
  truthLaneRequest,
  truthLaneReset,
  type TruthLaneState,
} from "../doiPropagation/inDragTruth";
import {
  computeFalloffPreviewParams,
  falloffInverse,
  falloffScale,
} from "../doiPropagation/falloff";
import { canUseShaderFalloffPreview } from "../gl/api/falloffPreviewSupport";
import { ledgerEvent } from "../utils/insetLedger";
// Type-only: the runtime module statically imports the worker factory
// (import.meta), so it is LAZILY imported below — never parsed by ts-jest.
import type {
  FieldPreviewClient,
  FieldPreviewResultMeta,
} from "../doiPropagation/fieldPreviewClient";

// One field-preview remap per this interval during drags: ~11 updates/s at
// 1M keeps the main thread ~70% free so the slider thumb stays at 60 fps
// (a per-frame remap starved it — CS: "inertia"). Chess-scale remaps are
// ~1 ms, so small datasets effectively update per-frame anyway.
const FIELD_PREVIEW_MIN_INTERVAL_MS = 90;

/** CONVERGED settle-commit (CS 14.08, ported from the comparison instrument):
 * how long the thumb must rest (pointer still down) before the full commit
 * pipeline (recluster included) runs in place — so a hold converges to the
 * exact commit appearance and the release at an unchanged value has nothing
 * left to do. Verified on the instrument: 0.00% hold-vs-release canvas diff. */
const CONV_SETTLE_MS = 350;

/** Identity of a slider-settings snapshot for the settle-commit release-skip
 * (a release whose values match the last settle auto-commit is absorbed). */
function convSettleKeyOf(s: SliderSettings): string {
  return (
    `${s.proximitySlider}|${s.pastSlider}|${s.futureSlider}|` +
    `${s.grayOutDoiThreshold}|${s.annotationDoiThreshold}|${s.insetDoiThreshold}`
  );
}

/** GPU motion lane's default MOTION raster resolution (plan-gpu-motion-lane.md
 * §4): the ENGINE's own grid — the preview is then f32-ulp-identical to the
 * commit (CS 18.08: exact res runs at full frame rate on his GPU, and the
 * coarse default's preview-vs-commit gap was the one thing he flagged).
 * Weaker iGPUs (where an exact tick costs ~54 ms) drop to 512/256
 * automatically via the adaptive controller (gpuMotionAdaptiveRes.ts);
 * `window.__gpuMotionGridRes` overrides — see tryGpuMotionTick. */
const GPU_MOTION_GRID_RES = FIELD_GRID_RESOLUTION;

/** TRUTH BLEND duration (plan §5b, CS 2026-08-18: the GPU preview vs the
 * commit differed noticeably — compute the real solution behind the GPU
 * preview and FADE to it). The worker's exact converged field fades in over
 * this window whenever it lands while the thumb still holds the values it
 * was computed at — so by release the screen already IS the exact field. */
const GPU_TRUTH_BLEND_MS = 150;

/** RELEASE CROSS-FADE duration (issue #315, CS 2026-07-26): the committed field
 * fades in over this window instead of replacing the drag preview in one frame.
 * Presentation only — the fade ENDS at `setFalloffPreview(null)`, i.e. the exact
 * committed field. */
const RELEASE_BLEND_MS = 150;
import type { RendererAPI } from "../gl/api/RendererAPI";
import {
    bumpClusteringEpoch,
    isCurrentClusteringEpoch,
    runHdbscanClusteringWithStatus,
    runTrajectoryMidpointClusteringWithStatus,
} from "../clustering/hdbscanClustering";
import type { RootState, VisualizationSettings } from "../store";
import store, { updateSettings } from "../store";
import { freehandPinnedIds } from "../slices/freehandSlice";
import { selectUnlabeledOnlyMode } from "../slices/labelingSelectors";
import type { PrecomputedHdbscanResult } from "./useFullSelectionHdbscanInstance";

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export interface UseDoIPropagationParams {
  setSliderSettings: React.Dispatch<React.SetStateAction<SliderSettings>>;
  currentSliderSettingsRef: React.MutableRefObject<SliderSettings>;
  sliderUpdateFrameRef: React.MutableRefObject<number | null>;
  rendererRef: React.MutableRefObject<RendererAPI | null>;
  visualSettings: VisualizationSettings;
  performZoomClustering: () => void;
  fullSelectionHdbscan: PrecomputedHdbscanResult | undefined;
  fullSelectionMidpointHdbscan: PrecomputedHdbscanResult | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Orchestrates two distinct propagation paths:
 *
 *  PREVIEW (onChange)
 *  ──────────────────
 *  With a resident distance field every P/B/F drag tick runs the CONVERGED
 *  alternation on the throttled synchronous lane (CS 14.08: the thumb shows
 *  the REAL result — previewFalloffOpacity and the commit share one
 *  executor), with a ~350 ms settle-commit while the pointer rests and the
 *  matching release absorbed. The shader frozen-chain / field-preview worker
 *  branches are parked (unreachable via fieldPreviewRequiresSync) until the
 *  GPU motion lane. Without a resident field there is no committed spread to
 *  preview, and the commit at release produces it (#337). DoI-threshold
 *  changes update renderer uniforms only (free, no re-propagation).
 *
 *  COMMIT (onChangeCommitted)
 *  ──────────────────────────
 *  Server field > client field (issue #315 / #337), updates node groups,
 *  edge DOIs, and triggers clustering.  Any in-flight preview is cancelled
 *  before the commit runs.
 */
export function useDoIPropagation({
  setSliderSettings,
  currentSliderSettingsRef,
  sliderUpdateFrameRef,
  rendererRef,
  visualSettings,
  performZoomClustering,
  fullSelectionHdbscan,
  fullSelectionMidpointHdbscan,
}: UseDoIPropagationParams) {
  const dispatch = useDispatch();
  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();

  const unlabeledOnlyMode = useSelector((s: RootState) => selectUnlabeledOnlyMode(s));

  // Always-current refs for the hdbscan instances — updated every render so
  // the async commit callback never captures a stale undefined value.
  const fullSelectionHdbscanRef = useRef(fullSelectionHdbscan);
  fullSelectionHdbscanRef.current = fullSelectionHdbscan;
  const fullSelectionMidpointHdbscanRef = useRef(fullSelectionMidpointHdbscan);
  fullSelectionMidpointHdbscanRef.current = fullSelectionMidpointHdbscan;

  // Per-dataset epoch — incremented by notifyDatasetSwap.
  const datasetEpochRef = useRef(0);

  const previewUiRafRef = useRef<number | null>(null);
  const previewUiPendingRef = useRef<SliderSettings | null>(null);
  // Field drag preview (issue #315 v2): min-interval throttled with a
  // guaranteed trailing run — at 1M one remap+upload costs ~30 ms, and
  // running it every frame starved the slider thumb (CS: "inertia").
  const fieldPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Converged settle-commit timer (pointer down, thumb resting). */
  const convSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Settings key of the last settle auto-commit; a release with the same key
   * is absorbed (single-shot — cleared by every drag tick and on consume). */
  const convAutoCommitKeyRef = useRef<string | null>(null);
  const fieldPreviewLastRef = useRef(0);
  // rAF handle coalescing the shader falloff preview to one render/frame.
  const shaderPreviewRafRef = useRef<number | null>(null);
  // Field drag-preview WORKER (issue #315): moves the ~20 ms of f(D)+seed
  // clamp+chain math off the main thread so the thumb sees upload-only.
  // undefined = not yet loaded, null = unavailable (permanent sync fallback),
  // instance = ready. The lazy import fires once on the first field drag.
  const fieldPreviewClientRef = useRef<FieldPreviewClient | null | undefined>(undefined);
  const fieldPreviewLoadingRef = useRef(false);
  // GPU falloff-preview (issue #315 T1): identity of the FROZEN CHAIN currently
  // resident in the renderer's preview texture — `revision|shape|past|future|M`.
  // Deliberately NOT keyed on the proximity slider: freezing the chain is what
  // lets the shader remap proximity live (in both directions) from uniforms
  // alone. Nulled on dataset swap and whenever a chain slider moves.
  const shaderPreviewFreezeKeyRef = useRef<string | null>(null);
  // IN-DRAG TRUTH lane (issue #315, CS 2026-07-26). The frozen chain drifts as
  // the thumb travels away from the value it was frozen at, and the commit pays
  // that drift as a one-frame step. The lane periodically RE-FREEZES off-thread
  // at the value currently held, which makes the shader preview exact there
  // again — so by release only the LAST update's drift is left to jump. Scheduler
  // (single-flight, stale rejection, adaptive gate) lives in inDragTruth.ts.
  const truthLaneRef = useRef<TruthLaneState<number>>(truthLaneInitial<number>());
  /** The worker tick id of the lane's in-flight request, paired with its lane
   * seq — the client already drops stale tick ids, this pairs them back up. */
  const truthTickRef = useRef<{ tickId: number; seq: number; prox: number } | null>(null);
  /** The frozen chain currently resident in the renderer's preview texture and
   * the proximity value it was frozen at (the release blend's `from` is this
   * evaluated at the released slider). */
  const frozenChainRef = useRef<{ layers: FrozenChainLayers; prox: number } | null>(null);
  // Release cross-fade rAF handle + its start timestamp.
  const releaseBlendRafRef = useRef<number | null>(null);
  const releaseBlendStartRef = useRef(0);
  // GPU MOTION LANE (plan-gpu-motion-lane.md, behind gpuMotionLaneEnabled):
  // converged drag ticks computed on the GPU during motion, exact CPU at
  // rest (settle-commit) / release — the flag-gated step-B lane.
  const gpuMotionRafRef = useRef<number | null>(null);
  /** Identity of the field data currently uploaded to the GPU executor —
   * `datasetEpoch|fieldRevision|n`; a mismatch re-uploads. */
  const gpuMotionFieldKeyRef = useRef<string | null>(null);
  /** Permanent fallback latch after any GPU-lane failure (unsupported stack,
   * compile error): the drag keeps the worker lane, no repeated probing. */
  const gpuMotionBrokenRef = useRef(false);
  /** Adaptive motion-raster degradation (gpuMotionAdaptiveRes.ts): sticky
   * per session, driven by the tick-cost fence samples polled below. */
  const gpuMotionAdaptiveResRef = useRef(createGpuMotionAdaptiveRes());
  /** Chain doubling tables, cached per dataset precomputation identity. */
  const gpuJumpTablesRef = useRef<{
    pred: Int32Array;
    tables: ChainJumpTables;
  } | null>(null);
  /** True while the GPU lane owns the drag — worker results are then TRUTH
   * updates (blend-in), never direct paints. Cleared by stopPreviewRAF. */
  const gpuMotionActiveRef = useRef(false);
  /** Truth-blend fade state: rAF handle, start stamp, and a stable copy of
   * the exact field being blended (the worker's buffer is ping-pong reused). */
  const gpuTruthBlendRafRef = useRef<number | null>(null);
  const gpuTruthBlendStartRef = useRef(0);
  const gpuTruthScratchRef = useRef<Float32Array | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Drop the preview-only RENDER STATE: the GPU falloff preview (whose
   * `max(field, spatial)` fold is the live drag image) and the interactive
   * quality reduction. Split out of `stopPreviewRAF` (issue #315 P7): the
   * commit path must keep BOTH on screen until the committed field replaces
   * them — clearing them at release reverted the view to the stale field for
   * the whole propagate RTT (CS: "the preview disappears for ~1s"). The
   * held preview is a better approximation of the incoming result than the
   * field it would revert to, and it is evaluated at the released slider
   * value, so nothing on screen changes when the commit finally lands.
   *
   * Idempotent + defensive optional calls (older renderers lack both).
   */
  const clearPreviewVisuals = useCallback(() => {
    rendererRef.current?.setFalloffPreview?.(null);
    rendererRef.current?.setInteractiveQuality?.(false);
  }, [rendererRef]);

  // ── Release cross-fade (issue #315, CS 2026-07-26) ────────────────────────
  //
  // The commit used to replace the drag preview with the committed field in ONE
  // frame. Whatever drift the frozen chain accumulated over the drag therefore
  // landed as a visible pop (measured mean |Δ| 0.002 but up to 0.23 per point and
  // ~1.5 % of points crossing the gray-out threshold on a long log-shape drag —
  // bench/prox-release-jump.py). The fade is PRESENTATION ONLY: the shaders mix
  // the preview term toward the committed opacity texture through one animated
  // uniform (zero per-frame CPU, no second texture, no extra upload at any
  // dataset size), and the END state is `setFalloffPreview(null)` — the exact
  // committed field, never a lerp of it.

  /** End the fade NOW, at its end state (the preview term switched off, i.e. the
   * exact committed field). Idempotent; also the cancel-forward a new drag tick
   * needs (a fade must never fight the thumb). */
  const finishReleaseBlend = useCallback(() => {
    if (releaseBlendRafRef.current === null) return;
    cancelAnimationFrame(releaseBlendRafRef.current);
    releaseBlendRafRef.current = null;
    rendererRef.current?.setFalloffPreview?.(null);
    rendererRef.current?.render?.();
  }, [rendererRef]);

  /**
   * Start the fade from the preview currently on screen to the committed opacity
   * texture (which the caller must already have pushed). Falls back to the
   * one-frame swap when the renderer has no blend uniform or no preview is up —
   * there is then nothing to fade FROM.
   */
  const startReleaseBlend = useCallback(() => {
    const renderer = rendererRef.current;
    // The interactive-quality restore is NOT part of the fade: it has to land in
    // the same frame as the committed texture, or the backing store sharpens
    // 150 ms after release as a SECOND pop. Idempotent, so this is free.
    renderer?.setInteractiveQuality?.(false);
    if (!renderer || typeof renderer.setFalloffPreviewBlend !== "function") {
      clearPreviewVisuals();
      return;
    }
    finishReleaseBlend();
    releaseBlendStartRef.current = performance.now();
    renderer.setFalloffPreviewBlend(0);
    const step = () => {
      releaseBlendRafRef.current = null;
      const api = rendererRef.current;
      if (!api?.setFalloffPreviewBlend) return;
      const t = (performance.now() - releaseBlendStartRef.current) / RELEASE_BLEND_MS;
      if (t >= 1) {
        // Exact end state: the preview term is switched OFF, so the image is the
        // committed opacity field itself — not mix(..., 1.0) of it.
        api.setFalloffPreview?.(null);
        api.render?.();
        return;
      }
      api.setFalloffPreviewBlend(t);
      api.render?.();
      releaseBlendRafRef.current = requestAnimationFrame(step);
    };
    releaseBlendRafRef.current = requestAnimationFrame(step);
  }, [clearPreviewVisuals, finishReleaseBlend, rendererRef]);

  /**
   * Cancel any in-flight preview compute.
   * `keepVisuals` stops the COMPUTE only and leaves the last preview frame on
   * screen — the commit path's contract (see `clearPreviewVisuals`).
   */
  const stopPreviewRAF = useCallback((keepVisuals = false) => {
    if (fieldPreviewTimerRef.current !== null) {
      clearTimeout(fieldPreviewTimerRef.current);
      fieldPreviewTimerRef.current = null;
    }
    // A pending settle-commit is anchored on the drag/dataset that is ending
    // (the commit handler clears it at entry too; this covers dataset swaps).
    if (convSettleTimerRef.current !== null) {
      clearTimeout(convSettleTimerRef.current);
      convSettleTimerRef.current = null;
    }
    if (shaderPreviewRafRef.current !== null) {
      cancelAnimationFrame(shaderPreviewRafRef.current);
      shaderPreviewRafRef.current = null;
    }
    if (gpuMotionRafRef.current !== null) {
      cancelAnimationFrame(gpuMotionRafRef.current);
      gpuMotionRafRef.current = null;
    }
    if (gpuTruthBlendRafRef.current !== null) {
      cancelAnimationFrame(gpuTruthBlendRafRef.current);
      gpuTruthBlendRafRef.current = null;
    }
    // The GPU lane no longer owns the drag: worker results (if any straggle
    // in before the client reset below lands) go back to direct paints.
    gpuMotionActiveRef.current = false;
    if (previewUiRafRef.current !== null) {
      cancelAnimationFrame(previewUiRafRef.current);
      previewUiRafRef.current = null;
    }
    previewUiPendingRef.current = null;
    // The in-drag truth lane is anchored on the drag that is ending: no response
    // from it may land afterwards (truthLaneReset invalidates every seq).
    truthLaneRef.current = truthLaneReset(truthLaneRef.current);
    truthTickRef.current = null;
    // Turn off the GPU falloff preview (issue #315): the exact commit / reset
    // path then repaints from the opacity texture alone, byte-identical to the
    // pre-preview behavior. Also restores full render resolution (§10.1).
    // DEFERRED on the commit path — see clearPreviewVisuals.
    if (!keepVisuals) clearPreviewVisuals();
    // Tear down the field-preview worker (covers dataset swap too —
    // notifyDatasetSwap calls this). The instance stays reusable; the next
    // drag recreates the worker under the new field revision.
    const previewClient = fieldPreviewClientRef.current;
    if (previewClient) previewClient.reset();
  }, [clearPreviewVisuals]);

  // ── Public: notify dataset swap ────────────────────────────────────────────

  const notifyDatasetSwap = useCallback(() => {
    datasetEpochRef.current += 1;
    stopPreviewRAF();

    // Force a frozen-chain re-upload for the next drag on the new dataset.
    shaderPreviewFreezeKeyRef.current = null;
    frozenChainRef.current = null;
    // Free the GPU motion lane's per-field textures (stale n/coords) and
    // drop the jump-table cache — the next drag re-uploads under the new
    // dataset epoch.
    gpuMotionFieldKeyRef.current = null;
    gpuJumpTablesRef.current = null;
    rendererRef.current?.setConvergedMotionField?.(null);
    // A settle auto-commit key from the OLD dataset must not absorb a release
    // on the new one (the key is slider values only — it cannot tell datasets
    // apart).
    convAutoCommitKeyRef.current = null;
    // Drop the truth lane's measured round-trip too: it is a property of THIS
    // dataset's node count + selection, so the new dataset must re-probe.
    truthLaneRef.current = truthLaneInitial<number>();

    const renderer = rendererRef.current;
    const nodes = dataRef.current;
    if (!renderer || !nodes?.length) return;

    renderer.setOpacityField?.(doiOpacityField(nodes));
    renderer.render?.();
  }, [rendererRef, dataRef, stopPreviewRAF]);

  // ── Field drag preview (issue #315) ──────────────────────────────────────

  /**
   * Synchronous field-preview remap — the fallback when the worker is
   * unavailable (or not yet loaded). Throttled to one remap per
   * FIELD_PREVIEW_MIN_INTERVAL_MS with a guaranteed trailing run (the timer
   * always fires with the freshest settings from the ref): at 1M the
   * remap+upload costs ~30 ms, and running it every frame starved the thumb.
   */
  const runFieldPreviewSync = useCallback(() => {
    if (fieldPreviewTimerRef.current !== null) return;
    const elapsed = performance.now() - fieldPreviewLastRef.current;
    const delay = Math.max(0, FIELD_PREVIEW_MIN_INTERVAL_MS - elapsed);
    fieldPreviewTimerRef.current = setTimeout(() => {
      fieldPreviewTimerRef.current = null;
      fieldPreviewLastRef.current = performance.now();
      const nodes = dataRef.current;
      const renderer = rendererRef.current;
      if (!nodes?.length || !renderer) return;
      const s = currentSliderSettingsRef.current;
      const opacity = previewFalloffOpacity(nodes, {
        proximitySlider: s.proximitySlider,
        pastSlider: s.pastSlider,
        futureSlider: s.futureSlider,
        maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
        grayOutDoiThreshold: s.grayOutDoiThreshold,
        annotationDoiThreshold: s.annotationDoiThreshold,
        insetDoiThreshold: s.insetDoiThreshold,
      });
      if (!opacity) return;
      renderer.setOpacityField?.(opacity);
      renderer.render?.();
    }, delay);
  }, [dataRef, rendererRef, currentSliderSettingsRef, visualSettings.maxEmbeddingDistance]);

  /**
   * Every field-preview worker result lands here (plain remap AND in-drag truth
   * freeze). Held in a ref because the `onResult` closure is created once, at
   * lazy-import time, and must not capture a stale `maxEmbeddingDistance`.
   *
   * A FREEZE result (`meta.frozen`) is an in-drag TRUTH update: the layers
   * re-anchor the shader preview at the value they were frozen at — from then on
   * the shader is EXACT there and drifts only from there — and `out` (bit-equal
   * to `computeFieldPreview`, i.e. to what the release commit will paint) goes
   * into the opacity texture so the DoI-color encoding and the release
   * cross-fade's start state are right too. Stale seqs never apply.
   */
  const handlePreviewResultRef = useRef<
    (out: Float32Array, meta: FieldPreviewResultMeta) => void
  >(() => {});
  handlePreviewResultRef.current = (out, meta) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (meta.frozen) {
      const dispatch = truthTickRef.current;
      const decision = truthLaneComplete(
        truthLaneRef.current,
        dispatch && dispatch.tickId === meta.tickId ? dispatch.seq : -1,
        performance.now(),
        meta.elapsedMs
      );
      truthLaneRef.current = decision.state;
      truthTickRef.current = null;
      if (!decision.apply) return; // superseded / post-reset — never paint it
      const field = getResidentField();
      const shape = getFalloffShape();
      if (!field) return;
      frozenChainRef.current = { layers: meta.frozen, prox: dispatch!.prox };
      renderer.setDistanceField(field.recordDist, meta.frozen);
      // Re-assert the LIVE slider params: the thumb has moved on since the
      // request went out, and the re-anchored chain must be remapped to where it
      // is now (not to the value it was frozen at).
      renderer.setFalloffPreview(
        computeFalloffPreviewParams(
          shape,
          currentSliderSettingsRef.current.proximitySlider,
          visualSettings.maxEmbeddingDistance
        )
      );
      renderer.setOpacityField?.(out);
      renderer.render?.();
      ledgerEvent(
        "doi:preview-truth",
        `p=${dispatch!.prox.toFixed(3)} rt=${meta.elapsedMs.toFixed(1)}ms`
      );
      if (decision.dispatch) dispatchInDragTruthRef.current(decision.dispatch.seq, decision.dispatch.value);
      return;
    }
    // GPU MOTION TRUTH (plan §5b): while the GPU lane owns the drag, worker
    // results are the EXACT converged field computed behind the preview —
    // apply only if the thumb still holds the values it was computed at
    // (else a newer compute is already queued by latest-wins), and FADE it
    // in instead of stepping, so the release has nothing visible left to do.
    if (gpuMotionActiveRef.current) {
      const s = currentSliderSettingsRef.current;
      const p = meta.params;
      const matches =
        !!p &&
        p.prox === s.proximitySlider &&
        p.past === s.pastSlider &&
        p.future === s.futureSlider &&
        p.shape === getFalloffShape() &&
        p.maxEmb === visualSettings.maxEmbeddingDistance;
      if (!matches) return; // superseded — the drained latest tick follows
      let copy = gpuTruthScratchRef.current;
      if (!copy || copy.length !== out.length) {
        copy = new Float32Array(out.length);
        gpuTruthScratchRef.current = copy;
      }
      copy.set(out); // `out` is the worker's ping-pong buffer — keep a copy
      if (!renderer.uploadConvergedMotionExact?.(copy)) {
        // No blend infra (lost mid-drag): one-frame exact swap still beats a
        // release jump. Fresh copy — setOpacityField retains the reference.
        renderer.setOpacityField?.(new Float32Array(copy));
        renderer.render?.();
        ledgerEvent("doi:gpu-truth", `swap rt=${meta.elapsedMs.toFixed(1)}ms`);
        return;
      }
      startGpuTruthBlendRef.current(copy);
      ledgerEvent("doi:gpu-truth", `rt=${meta.elapsedMs.toFixed(1)}ms`);
      return;
    }
    // Plain remap: ping-pong safe — setOpacityField copies `out` into the
    // texture scratch before the worker reuses the buffer.
    renderer.setOpacityField?.(out);
    renderer.render?.();
  };

  /** Animate the truth blend 0 → 1 over GPU_TRUTH_BLEND_MS; the END state
   * hands `endField` to the canonical CPU path (setOpacityField clears the
   * texture override and refreshes the node VBO — the texture already holds
   * the exact values, so nothing steps on screen; a fresh copy because
   * setOpacityField retains the reference). Shared by the in-drag truth
   * applications AND the GPU-lane commit fade (release/settle — CS feel
   * round 2: the mid-motion release stepped where the hold no longer did).
   * Held in a ref so the result handler above can call it without a
   * dependency cycle; a new drag tick or the commit path cancels the rAF. */
  const startGpuTruthBlendRef = useRef<(endField: Float32Array) => void>(() => {});
  startGpuTruthBlendRef.current = (endField: Float32Array) => {
    if (gpuTruthBlendRafRef.current !== null) {
      cancelAnimationFrame(gpuTruthBlendRafRef.current);
      gpuTruthBlendRafRef.current = null;
    }
    gpuTruthBlendStartRef.current = performance.now();
    const step = () => {
      gpuTruthBlendRafRef.current = null;
      const api = rendererRef.current;
      if (!api) return;
      const t =
        (performance.now() - gpuTruthBlendStartRef.current) / GPU_TRUTH_BLEND_MS;
      if (t >= 1) {
        api.setOpacityField?.(new Float32Array(endField));
        api.render?.();
        return;
      }
      if (!api.blendConvergedMotionExact?.(t)) return;
      api.render?.();
      gpuTruthBlendRafRef.current = requestAnimationFrame(step);
    };
    gpuTruthBlendRafRef.current = requestAnimationFrame(step);
  };

  /**
   * Resolve the field-preview worker client, kicking its lazy import once.
   * Returns the live client, or null while it is still loading / permanently
   * unavailable. Held in a ref so both the worker preview path and the in-drag
   * truth lane can call it without a dependency cycle.
   */
  const ensureFieldPreviewClientRef = useRef<() => FieldPreviewClient | null>(() => null);
  ensureFieldPreviewClientRef.current = () => {
    const client = fieldPreviewClientRef.current;
    if (client !== undefined) return client;
    if (!fieldPreviewLoadingRef.current) {
      fieldPreviewLoadingRef.current = true;
      import("../doiPropagation/fieldPreviewClient")
        .then(({ FieldPreviewClient }) => {
          fieldPreviewClientRef.current = new FieldPreviewClient((out, meta) =>
            handlePreviewResultRef.current(out, meta)
          );
        })
        .catch(() => {
          fieldPreviewClientRef.current = null;
        });
    }
    return null;
  };

  /** Send one lane request (held in a ref so the result handler above can drain
   * the pending latest without a circular useCallback dependency). */
  const dispatchInDragTruthRef = useRef<(seq: number, prox: number) => void>(() => {});
  dispatchInDragTruthRef.current = (seq, prox) => {
    const client = fieldPreviewClientRef.current;
    const field = getResidentField();
    const seeds = getSeedClampIndices();
    const nodes = dataRef.current;
    const shape = getFalloffShape();
    if (!client || !field || !seeds || !nodes?.length) {
      truthLaneRef.current = truthLaneReset(truthLaneRef.current);
      return;
    }
    const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
    const s = currentSliderSettingsRef.current;
    const tickId = client.freezeTick(
      {
        revision: field.revision,
        length: nodes.length,
        recordDist: field.recordDist,
        predIndex,
        succIndex,
        seedIdx: Int32Array.from(seeds),
        coords: () => snapshotCoords(nodes),
      },
      {
        shape: shape as FieldPreviewShape,
        prox,
        past: s.pastSlider,
        future: s.futureSlider,
        maxEmb: visualSettings.maxEmbeddingDistance,
      }
    );
    if (tickId === null) {
      // Worker unavailable / already busy: give the seq back so the lane is not
      // left waiting forever on a request that was never sent.
      truthLaneRef.current = truthLaneReset(truthLaneRef.current);
      return;
    }
    truthTickRef.current = { tickId, seq, prox };
  };

  /**
   * IN-DRAG TRUTH tick. Asks the lane whether a truth update may go out for the
   * value currently held; the lane enforces single-flight, the minimum interval
   * and the adaptive round-trip gate (see inDragTruth.ts). A no-op when the
   * worker client is not up yet — the shader preview alone drives the drag, as
   * before.
   */
  const requestInDragTruth = useCallback((prox: number) => {
    // The shader path never calls runFieldPreviewTick, so the lane is what kicks
    // the lazy worker import on a proximity-only drag. Until it resolves the
    // drag is pure shader preview (today's behaviour).
    if (!ensureFieldPreviewClientRef.current()) return;
    if (!truthLaneArmed(truthLaneRef.current)) return;
    const decision = truthLaneRequest(truthLaneRef.current, prox, performance.now());
    truthLaneRef.current = decision.state;
    if (decision.dispatch) {
      dispatchInDragTruthRef.current(decision.dispatch.seq, decision.dispatch.value);
    }
  }, []);

  /**
   * One field-preview tick. Tries the worker path first (main thread = upload
   * only): the exact f(D)+chain math runs off-thread and the result lands via
   * the client's onResult → setOpacityField + render. The worker is (re)inited
   * lazily on the first drag after a commit and re-inited on a field revision
   * change; ANY failure degrades to the throttled synchronous remap.
   */
  const runFieldPreviewTick = useCallback(() => {
    ledgerEvent("doi:preview-worker", "tick");
    // Pins / labeled exclusion (#337): the worker protocol carries neither
    // the pin clamp nor the labeled zeroing (both can change without a field
    // revision bump) — the synchronous remap replays both
    // (previewFalloffOpacity), and both are small-dataset workflows.
    if (fieldPreviewExclusionsActive()) {
      runFieldPreviewSync();
      return;
    }
    const client = fieldPreviewClientRef.current;
    if (client === null) {
      runFieldPreviewSync();
      return;
    }
    if (client === undefined) {
      // First field drag: kick the lazy import once; keep the thumb live with
      // the synchronous path until the client resolves.
      ensureFieldPreviewClientRef.current();
      runFieldPreviewSync();
      return;
    }

    // Worker ready. Seeds/field are set by the last commit apply; if either is
    // missing (a preview before any commit) fall back synchronously.
    const field = getResidentField();
    const seeds = getSeedClampIndices();
    const nodes = dataRef.current;
    if (!field || !seeds || !nodes?.length) {
      runFieldPreviewSync();
      return;
    }
    const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
    const s = currentSliderSettingsRef.current;
    const ok = client.tick(
      {
        revision: field.revision,
        length: nodes.length,
        recordDist: field.recordDist,
        predIndex,
        succIndex,
        seedIdx: Int32Array.from(seeds),
        coords: () => snapshotCoords(nodes),
      },
      {
        // Non-hop guaranteed by the hasResidentFieldPreview route guard.
        shape: getFalloffShape() as FieldPreviewShape,
        prox: s.proximitySlider,
        past: s.pastSlider,
        future: s.futureSlider,
        maxEmb: visualSettings.maxEmbeddingDistance,
      }
    );
    if (!ok) {
      // Worker creation failed — permanent synchronous fallback.
      fieldPreviewClientRef.current = null;
      runFieldPreviewSync();
    }
  }, [runFieldPreviewSync, dataRef, currentSliderSettingsRef, visualSettings.maxEmbeddingDistance]);

  /**
   * ADAPTIVE RES poll chain (gpuMotionAdaptiveRes.ts): each motion tick
   * leaves a GPU cost fence behind; this chain polls it once per frame and
   * feeds the time-to-signal to the adaptive controller — the only honest
   * tick-cost signal (the CPU-side encode is ~0.2 ms on every GPU, and rAF
   * scheduling stays prompt even under a saturated queue; both measured
   * 2026-08-21). Self-terminating: ends when no fence is outstanding or the
   * renderer is gone. The `window.__gpuMotionGridRes` knob suspends the
   * adaptive path (manual override — never fight it).
   */
  const gpuMotionFencePollRef = useRef<number | null>(null);
  const pollGpuMotionTickCost = useCallback(() => {
    if (gpuMotionFencePollRef.current !== null) return; // chain already live
    const step = () => {
      gpuMotionFencePollRef.current = null;
      const ms = rendererRef.current?.pollConvergedMotionTickMs?.();
      if (ms === null) {
        // Fence still pending — poll again next frame.
        gpuMotionFencePollRef.current = requestAnimationFrame(step);
        return;
      }
      if (typeof ms !== "number") return; // no fence outstanding
      const knob = (window as { __gpuMotionGridRes?: unknown }).__gpuMotionGridRes;
      if (typeof knob === "number" && knob >= 64) return;
      const degraded = gpuMotionAdaptiveResRef.current.note(ms);
      if (degraded !== null) {
        console.info(
          `[gpu-motion] sustained over-budget ticks (last ${ms.toFixed(0)} ms)` +
            ` — motion raster degraded to ${degraded}; the exact field still` +
            ` lands at rest (override via window.__gpuMotionGridRes)`
        );
        ledgerEvent(
          "doi:gpu-motion-degrade",
          `res=${degraded} gpuMs=${ms.toFixed(1)}`
        );
      }
    };
    gpuMotionFencePollRef.current = requestAnimationFrame(step);
  }, [rendererRef]);

  /**
   * GPU MOTION LANE tick (plan-gpu-motion-lane.md). Returns true when the
   * tick was scheduled on the GPU executor — the caller then skips the
   * worker/sync preview routing for this onChange (the settle-commit arming
   * is untouched: the exact CPU flush at rest is the contract's other half).
   * Any failure latches the permanent fallback and returns false, so the
   * drag continues on the worker lane without re-probing.
   *
   * Exclusion drags (pins/labeled) stay on the synchronous lane — the GPU
   * executor deliberately does not carry the replay sets, for the same
   * reason the worker does not (they change without a field-revision bump).
   */
  const tryGpuMotionTick = useCallback((): boolean => {
    if (gpuMotionBrokenRef.current || !gpuMotionLaneEnabled()) return false;
    if (fieldPreviewExclusionsActive()) return false;
    const renderer = rendererRef.current;
    if (!renderer?.runConvergedMotionTick || !renderer.setConvergedMotionField) {
      return false;
    }
    const field = getResidentField();
    const seeds = getSeedClampIndices();
    const nodes = dataRef.current;
    const maxEmb = visualSettings.maxEmbeddingDistance;
    if (
      !field ||
      !seeds ||
      !nodes?.length ||
      field.recordDist.length !== nodes.length ||
      !(maxEmb > 0)
    ) {
      return false;
    }

    // MOTION raster resolution (plan-gpu-motion-lane.md §4): default = the
    // ENGINE's exact grid (f32-ulp parity with the commit; full frame rate
    // on CS's GPU). Drops to 512/256 for weaker iGPUs, trading f-slope ×
    // cellSize quantization (max |GPU−CPU| 0.009 / 0.02, snapped exact by
    // the truth blend + settle/release flush) for tick cost (measured on a
    // Ryzen iGPU: 54 → 24 → 12-18 ms); values ≥ FIELD_GRID_RESOLUTION mean
    // the exact CPU raster. The drop happens ADAPTIVELY when sustained tick
    // fence samples show the GPU cannot hold the exact grid (see
    // gpuMotionAdaptiveRes.ts — some browsers pin WebGL to a machine's weak
    // adapter); the `window.__gpuMotionGridRes` knob (≥ 64) overrides both.
    const resKnob = (window as { __gpuMotionGridRes?: unknown }).__gpuMotionGridRes;
    const requestedRes = resolveMotionGridRes(
      resKnob,
      gpuMotionAdaptiveResRef.current.current(),
      GPU_MOTION_GRID_RES
    );
    const motionRes = requestedRes >= FIELD_GRID_RESOLUTION ? 0 : requestedRes;
    const fieldKey = `${datasetEpochRef.current}|${field.revision}|${nodes.length}|${motionRes}`;
    if (gpuMotionFieldKeyRef.current !== fieldKey) {
      let raster = getFieldPreviewRaster(nodes);
      if (raster && motionRes) {
        const coords = snapshotCoords(nodes);
        raster = rasterize(coords.x, coords.y, motionRes);
      }
      if (!raster) return false;
      const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
      let jt = gpuJumpTablesRef.current;
      if (!jt || jt.pred !== predIndex) {
        jt = { pred: predIndex, tables: buildChainJumpTables(predIndex, succIndex) };
        gpuJumpTablesRef.current = jt;
      }
      const uploaded = renderer.setConvergedMotionField({
        n: nodes.length,
        recordDist: field.recordDist,
        seedIdx: seeds,
        raster,
        levels: jt.tables.levels,
        predJumps: jt.tables.predJumps,
        succJumps: jt.tables.succJumps,
      });
      if (!uploaded) {
        // The latch used to be silent — a whole deployed-lag debugging
        // session (2026-08-21) was blind because of it. Keep the info line.
        console.info(
          "[gpu-motion] field upload refused (unsupported GL stack) — " +
            "worker preview lane takes over permanently"
        );
        gpuMotionBrokenRef.current = true;
        return false;
      }
      gpuMotionFieldKeyRef.current = fieldKey;
    }

    // One GPU tick per frame — onChange fires per pointermove (100+/s).
    if (gpuMotionRafRef.current === null) {
      gpuMotionRafRef.current = requestAnimationFrame(() => {
        gpuMotionRafRef.current = null;
        const api = rendererRef.current;
        if (!api?.runConvergedMotionTick) return;
        const s = currentSliderSettingsRef.current;
        const shape = getFalloffShape();
        const prox = s.proximitySlider;
        const p = computeFalloffPreviewParams(shape, prox, maxEmb);
        const scale = falloffScale(prox);
        const t0 = performance.now();
        const ok = api.runConvergedMotionTick({
          shapeCode: p.shapeCode,
          sScaled: p.sScaled,
          invMaxEmb: p.invMaxEmb,
          mode: p.mode,
          past: s.pastSlider,
          future: s.futureSlider,
          scaleD: isFinite(scale) ? scale * maxEmb : 0,
          maxDist: falloffInverse(CONV_RESPREAD_FLOOR, shape, prox, maxEmb),
        });
        if (!ok) {
          // Mid-drag loss (context loss, realloc): latch the fallback and
          // keep the drag alive on the worker lane.
          console.info(
            "[gpu-motion] tick failed mid-drag (context loss/realloc) — " +
              "worker preview lane takes over permanently"
          );
          gpuMotionBrokenRef.current = true;
          gpuMotionFieldKeyRef.current = null;
          runFieldPreviewTick();
          return;
        }
        api.render?.();
        // ADAPTIVE RES: the tick left a cost fence behind — poll it per
        // frame until the GPU signals (pollGpuMotionTickCost above).
        pollGpuMotionTickCost();
        // enc = CPU-side encode time; the true GPU cost is what the tick
        // fence measures (ledgerEvent doi:gpu-motion-degrade on a tier drop).
        ledgerEvent(
          "doi:gpu-motion",
          `p=${prox.toFixed(3)} enc=${(performance.now() - t0).toFixed(1)}ms`
        );
      });
    }

    // New input cancels a truth fade in flight (the GPU tick above repaints
    // at the new values; the drained latest-wins compute follows it).
    if (gpuTruthBlendRafRef.current !== null) {
      cancelAnimationFrame(gpuTruthBlendRafRef.current);
      gpuTruthBlendRafRef.current = null;
    }
    gpuMotionActiveRef.current = true;

    // TRUTH dispatch (plan §5b): ask the worker for the EXACT converged field
    // at these values, latest-wins (at most one in flight; a superseding tick
    // replaces the pending params). The result lands in the handler above and
    // fades in only if the thumb still holds its values. Until the lazy
    // client import resolves, the drag is GPU-only — as before.
    const client = ensureFieldPreviewClientRef.current();
    if (client) {
      const s = currentSliderSettingsRef.current;
      const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
      const ok = client.tick(
        {
          revision: field.revision,
          length: nodes.length,
          recordDist: field.recordDist,
          predIndex,
          succIndex,
          seedIdx: Int32Array.from(seeds),
          coords: () => snapshotCoords(nodes),
        },
        {
          shape: getFalloffShape() as FieldPreviewShape,
          prox: s.proximitySlider,
          past: s.pastSlider,
          future: s.futureSlider,
          maxEmb,
        }
      );
      if (!ok) fieldPreviewClientRef.current = null; // worker unavailable: GPU-only
    }
    return true;
  }, [
    rendererRef,
    dataRef,
    currentSliderSettingsRef,
    visualSettings.maxEmbeddingDistance,
    runFieldPreviewTick,
    pollGpuMotionTickCost,
  ]);

  /** Cheap probe: can a frozen chain be built right now? (A resident field
   * matching the node count, a field shape, and the commit's seed indices.)
   * Checked BEFORE a drag tick picks its path, so a missing input routes to the
   * worker instead of leaving a stale shader preview on screen. */
  const canFreezeChain = useCallback((): boolean => {
    const field = getResidentField();
    const nodes = dataRef.current;
    return (
      !!field &&
      !!nodes?.length &&
      field.recordDist.length === nodes.length &&
      getSeedClampIndices() !== null &&
      // Pins / labeled exclusion (#337): the shader's max-composition can
      // only raise values — neither the pin clamp nor the labeled zeroing
      // is expressible, so excluded drags take the synchronous lane.
      !fieldPreviewRequiresSync()
    );
  }, [dataRef]);

  /**
   * GPU falloff preview (issue #315 T1). The preview DoI is evaluated IN THE
   * SHADER from a FROZEN CHAIN: `max(seedChain, f(D, p), gain · f(srcDist, p))`,
   * whose slider-independent layers are the frozen trajectory cascade
   * (fieldPreviewCore's `computeFrozenChain`), uploaded once per field revision
   * + chain-slider value.
   * A proximity tick is then a few uniform writes — no 4 MB opacity re-upload,
   * guaranteed 60 fps — and because the shader term is monotone in the slider,
   * the preview follows it in BOTH directions (the max() against the committed
   * opacity texture it replaced could only ever raise values, so dragging DOWN
   * previewed nothing: CS 2026-07-26).
   *
   * Returns false (and the caller keeps the worker/sync path as the sole
   * preview) when the renderer lacks the API or a freeze input is missing.
   */
  const applyShaderFalloffPreview = useCallback((): boolean => {
    const renderer = rendererRef.current;
    if (!renderer || !canUseShaderFalloffPreview(renderer)) return false;
    const field = getResidentField();
    const nodes = dataRef.current;
    if (!field || !nodes?.length || field.recordDist.length !== nodes.length) return false;
    const shape = getFalloffShape();
    const seeds = getSeedClampIndices();
    if (!seeds) return false;

    const s = currentSliderSettingsRef.current;
    // Freeze + upload the chain once per (revision, shape, chain sliders,
    // diameter) — everything the shader cannot re-derive per tick. The frozen
    // pair reproduces the full preview exactly at the proximity value it was
    // frozen at, so entering a drag changes nothing on screen.
    const freezeKey = `${field.revision}|${shape}|${s.pastSlider}|${s.futureSlider}|${visualSettings.maxEmbeddingDistance}`;
    if (shaderPreviewFreezeKeyRef.current !== freezeKey) {
      const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
      const frozen = computeFrozenChain({
        recordDist: field.recordDist,
        predIndex,
        succIndex,
        seedIdx: Int32Array.from(seeds),
        shape: shape as FieldPreviewShape,
        prox: s.proximitySlider,
        past: s.pastSlider,
        future: s.futureSlider,
        maxEmb: visualSettings.maxEmbeddingDistance,
      });
      renderer.setDistanceField(field.recordDist, frozen);
      frozenChainRef.current = { layers: frozen, prox: s.proximitySlider };
      shaderPreviewFreezeKeyRef.current = freezeKey;
    }

    const params = computeFalloffPreviewParams(
      shape,
      s.proximitySlider,
      visualSettings.maxEmbeddingDistance
    );
    renderer.setFalloffPreview(params);
    renderer.render?.();
    ledgerEvent("doi:preview-shader", `shape=${shape} p=${s.proximitySlider.toFixed(3)}`);
    return true;
  }, [rendererRef, dataRef, currentSliderSettingsRef, visualSettings.maxEmbeddingDistance]);

  // ── PREVIEW: while the slider thumb is held ───────────────────────────────

  /**
   * Called on every slider onChange event (fires rapidly while dragging).
   *
   * Design:
   *  - Always commits settings to the shared ref (single source of truth for
   *    the running RAF loop).
   *  - DoI-threshold changes: GPU uniform update only, no re-propagation.
   *  - P/B/F changes: set needsPreviewResetRef so the loop resets at the next
   *    frame boundary.  If the loop has gone idle, restart it.
   */
  const handlePropagationSliderChange = useCallback(
    (newSettings: SliderSettings) => {
      notifyDoiStateInvalidation();
      // A release cross-fade must never fight the thumb: new input finishes it
      // FORWARD to its end state (the committed field) before the drag re-arms
      // the preview on top (issue #315, CS 2026-07-26).
      finishReleaseBlend();
      const prevSnap = currentSliderSettingsRef.current;
      // Propagation parameters (Proximity/Backward/Forward) vs threshold-only.
      const pbfChanged =
        newSettings.proximitySlider !== prevSnap.proximitySlider ||
        newSettings.pastSlider !== prevSnap.pastSlider ||
        newSettings.futureSlider !== prevSnap.futureSlider;
      // A P/B/F drag over a resident field runs the CONVERGED synchronous
      // preview below — the exact commit field per tick.
      const convergedPreviewDrag =
        pbfChanged && hasResidentFieldPreview(dataRef.current?.length ?? 0);
      // Interactive quality reduction (issue #315 §10.1): the first preview tick
      // of a DoI-threshold drag drops the backing-store resolution so the
      // per-tick full-scene repaints stop being fill-bound. Idempotent, so
      // calling it every onChange is free; stopPreviewRAF restores full quality
      // on release/commit. CONVERGED drags are exempt (instrument finding,
      // 14.08): the half-res backing store visibly washes out the dense
      // converged field — the bit-identical preview then reads as "less spread
      // than the commit" — and the converged compute dominates the tick cost
      // anyway, so full-res repaints change nothing.
      if (!convergedPreviewDrag) {
        rendererRef.current?.setInteractiveQuality?.(true);
      }

      // Single source of truth for slider values (RAF loop reads this).
      currentSliderSettingsRef.current = { ...prevSnap, ...newSettings };

      // Mirror into the LIVE store at most once per frame — never into React
      // state (issue #330: the per-frame App-state echo re-rendered the whole
      // tree and capped the drag at ~13 fps). Only the slider rows and the
      // color legend subscribe; App state updates on commit.
      previewUiPendingRef.current = { ...prevSnap, ...newSettings };
      if (previewUiRafRef.current === null) {
        previewUiRafRef.current = requestAnimationFrame(() => {
          previewUiRafRef.current = null;
          const pending = previewUiPendingRef.current;
          previewUiPendingRef.current = null;
          if (!pending) return;
          setLiveSliderSettings(pending);
        });
      }

      // DoI threshold: GPU-only uniform update, no propagation needed.
      rendererRef.current?.setOpacityParams?.({
        threshold: newSettings.grayOutDoiThreshold,
        minAlpha: visualSettings.minimumOpacityClamping,
        maxAlpha: visualSettings.maximumOpacityClamping,
      });

      // Keep Redux in sync so clustering and App.tsx sync-effect read current values.
      const thresholdChanged =
        newSettings.grayOutDoiThreshold !== prevSnap.grayOutDoiThreshold ||
        newSettings.annotationDoiThreshold !== prevSnap.annotationDoiThreshold ||
        newSettings.insetDoiThreshold !== prevSnap.insetDoiThreshold;
      if (thresholdChanged) {
        dispatch(updateSettings({
          grayOutDoiThreshold: newSettings.grayOutDoiThreshold,
          annotationDoiThreshold: newSettings.annotationDoiThreshold,
          insetDoiThreshold: newSettings.insetDoiThreshold,
        }));
      }

      if (!pbfChanged) return; // Threshold-only change — done.

      const mix = Math.max(
        newSettings.proximitySlider,
        newSettings.pastSlider,
        newSettings.futureSlider
      );
      rendererRef.current?.setOpacityMix?.(mix);

      // Field path — CONVERGED previews (CS 14.08): with a resident distance
      // field every P/B/F drag tick runs the SAME converged alternation the
      // release commit runs, OFF-THREAD in the field-preview worker (thumb
      // never blocks on the compute; the client's latest-wins scheduling
      // keeps at most one tick in flight and drops stale intermediates).
      // Pins/labeled drags and worker-less environments take the throttled
      // synchronous remap instead — identical values, main-thread cost. The
      // round-0 shader frozen-chain branch below is unreachable
      // (`fieldPreviewRequiresSync` is always true — it cannot express the
      // re-spread); the machinery stays for the GPU motion lane (step B).
      if (convergedPreviewDrag) {
        // GPU MOTION LANE first (plan-gpu-motion-lane.md, flag-gated): the
        // converged tick runs entirely on the GPU into the opacity texture —
        // the worker/sync routing below is skipped for this onChange, the
        // settle-commit arming (further down) is not.
        if (!tryGpuMotionTick()) {
          // GPU-preview path (issue #315 T1): the shader previews the whole DoI
          // field from the frozen chain. THREE scheduling rules, each learned the
          // hard way from CS's live testing:
          // (a) rAF-COALESCE — onChange fires per pointermove (100+/s) and an
          //     uncoalesced render() per event saturated the main thread (the
          //     residual "slider lags behind mouse");
          // (b) a PROXIMITY-only drag never runs the worker: the shader alone is
          //     the live signal, its frozen chain covers the past/future term, and
          //     the worker's ~10 Hz opacity landings only snapped pixels under it
          //     (the residual "flicker");
          // (c) a CHAIN (past/future) drag invalidates the freeze, so the shader
          //     term is switched OFF and the worker's full off-thread remap drives
          //     the preview instead — refreezing per pointermove would put an O(n)
          //     scan + a 2-channel re-upload on the main thread at 1M. The next
          //     proximity-only move refreezes at the new chain values.
          const renderer = rendererRef.current;
          const shaderOk =
            !!renderer && canUseShaderFalloffPreview(renderer) && canFreezeChain();
          const chainChanged =
            newSettings.pastSlider !== prevSnap.pastSlider ||
            newSettings.futureSlider !== prevSnap.futureSlider;
          if (shaderOk && !chainChanged) {
            if (shaderPreviewRafRef.current === null) {
              shaderPreviewRafRef.current = requestAnimationFrame(() => {
                shaderPreviewRafRef.current = null;
                // A freeze input that vanished between the probe and the frame
                // must not strand a stale shader preview — fall back cleanly.
                if (!applyShaderFalloffPreview()) {
                  rendererRef.current?.setFalloffPreview?.(null);
                  runFieldPreviewTick();
                }
              });
            }
            // (d) IN-DRAG TRUTH (issue #315, CS 2026-07-26): ask off-thread for the
            //     TRUE field at the value being held and re-anchor the freeze on it,
            //     so the release commit has (almost) nothing left to step. The lane
            //     itself decides whether the round-trip is cheap enough.
            requestInDragTruth(newSettings.proximitySlider);
          } else {
            if (shaderPreviewRafRef.current !== null) {
              cancelAnimationFrame(shaderPreviewRafRef.current);
              shaderPreviewRafRef.current = null;
            }
            // The frozen chain is stale (or unavailable): drop the shader term so
            // the worker's field is what the user sees, and re-freeze on the next
            // proximity-only tick. The truth lane is anchored on that freeze, so it
            // resets with it.
            shaderPreviewFreezeKeyRef.current = null;
            frozenChainRef.current = null;
            truthLaneRef.current = truthLaneReset(truthLaneRef.current);
            renderer?.setFalloffPreview?.(null);
            runFieldPreviewTick();
          }
        }
        // SETTLE-COMMIT (CS 14.08, instrument-verified): when the thumb rests
        // ~350 ms with the pointer still down, run the SAME full commit the
        // release runs (recluster/labels/insets included) so the held view
        // converges to the exact commit appearance; the later release at an
        // unchanged value is absorbed by the single-shot skip in the commit
        // handler — hold-then-release shows no jump. Every tick moves the
        // value, so it clears the skip key and re-arms the timer.
        convAutoCommitKeyRef.current = null;
        if (convSettleTimerRef.current !== null) {
          clearTimeout(convSettleTimerRef.current);
        }
        convSettleTimerRef.current = setTimeout(() => {
          convSettleTimerRef.current = null;
          const held = { ...currentSliderSettingsRef.current };
          ledgerEvent("doi:settle-commit", `p=${held.proximitySlider.toFixed(3)}`);
          // Call FIRST, set the skip key AFTER: the commit handler's own
          // entry check must not see the key it is about to earn.
          const p = handlePropagationSliderFinalChangeRef.current(held);
          convAutoCommitKeyRef.current = convSettleKeyOf(held);
          void p;
        }, CONV_SETTLE_MS);
        return;
      }

      // No resident field (no committed selection yet, or the all-labeled
      // full-space state): nothing to preview — the graph PreviewPropagator
      // lane retired with the hop oracle (#337 PR B); the release commit
      // produces the field.
    },
    [
      dispatch,
      currentSliderSettingsRef,
      rendererRef,
      visualSettings.minimumOpacityClamping,
      visualSettings.maximumOpacityClamping,
      runFieldPreviewTick,
      applyShaderFalloffPreview,
      requestInDragTruth,
      finishReleaseBlend,
      canFreezeChain,
      tryGpuMotionTick,
      dataRef,
    ]
  );

  // ── COMMIT: when the slider thumb is released ──────────────────────────────

  /**
   * Called once when the user releases the slider thumb.
   * Runs the full deterministic propagation, updates node groups and edge DOIs,
   * then triggers clustering.
   */
  const handlePropagationSliderFinalChange = useCallback(
    async (finalSettings: SliderSettings) => {
      // Settle-commit absorption (CS 14.08): a release right after the settle
      // auto-commit at an unchanged value must not recompute or re-fit
      // anything — the re-fit IS the jump. Single-shot: the key is only set
      // by the settle commit and cleared by every drag tick, so real value
      // changes always commit. A pending settle timer is superseded by this
      // commit either way.
      if (convSettleTimerRef.current !== null) {
        clearTimeout(convSettleTimerRef.current);
        convSettleTimerRef.current = null;
      }
      if (convAutoCommitKeyRef.current === convSettleKeyOf(finalSettings)) {
        convAutoCommitKeyRef.current = null;
        ledgerEvent("doi:commit-absorbed", "release == settle auto-commit");
        return;
      }
      notifyDoiStateInvalidation();
      // Whether the GPU motion lane owned the drag this commit ends — decides
      // the commit-fade below. Captured BEFORE stopPreviewRAF clears it.
      const wasGpuMotion = gpuMotionActiveRef.current;
      // Stop the in-flight preview COMPUTE but hold its last frame on screen
      // (issue #315 P7): the preview is a closer approximation of the field
      // this commit is about to produce than the stale committed field is, so
      // clearing it here made the view jump BACKWARD for the whole propagate
      // RTT (CS: "the preview disappears for ~1s"). Released together with the
      // new field below — and on every early return, so a bailed commit can
      // never strand a preview frame.
      stopPreviewRAF(true);

      // This operation supersedes any previously-started clustering (e.g. an
      // in-flight initial clustering or a previous slider commit that hasn't
      // finished yet).  All runHdbscanClusteringWithStatus calls below carry
      // this token and will bail if a newer operation starts before they wake
      // up from their setTimeout yield.
      const epoch = bumpClusteringEpoch();

      // Commit settings as the authoritative source of truth.
      currentSliderSettingsRef.current = finalSettings;
      setSliderSettings(finalSettings);
      setLiveSliderSettings(finalSettings);

      if (sliderUpdateFrameRef.current) {
        cancelAnimationFrame(sliderUpdateFrameRef.current);
      }

      const nodes = dataRef.current;
      const segs = segmentsRef.current;
      const renderer = rendererRef.current;
      if (!nodes?.length || !renderer) {
        clearPreviewVisuals();
        return;
      }

      const mix = Math.max(
        finalSettings.proximitySlider,
        finalSettings.pastSlider,
        finalSettings.futureSlider
      );
      // Deferred to AFTER the field commit (issue #315 P7 S5): setting the
      // opacity uniforms here changed the rendered image against the OLD
      // field for the whole propagate RTT — CS's "visuals shift before the
      // new clustering arrives" on slider commits.
      const applyOpacityUniforms = () => {
        renderer.setOpacityMix(mix);
        renderer.setOpacityParams({
          threshold: finalSettings.grayOutDoiThreshold,
          minAlpha: visualSettings.minimumOpacityClamping,
          maxAlpha: visualSettings.maximumOpacityClamping,
        });
      };

      // ── Full deterministic propagation ──────────────────────────────────────
      // Selection column (issue #315 R1a, §3.1): the maintained index list
      // answers this without touching a row.
      const hasSelection = hasAnySelected(nodes) ?? nodes.some((n) => n.selected);

      // Read labeling state from the store at call-time so we don't need
      // assignments in the dep array (avoiding re-creation on every label change).
      const labelingState = store.getState().labeling;
      const labeledNodeIds: Set<string> | undefined = labelingState.unlabeledOnlyMode
        ? new Set(labelingState.assignments.keys())
        : undefined;

      const commitSettings = {
        proximitySlider: finalSettings.proximitySlider,
        pastSlider: finalSettings.pastSlider,
        futureSlider: finalSettings.futureSlider,
        maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
        grayOutDoiThreshold: finalSettings.grayOutDoiThreshold,
        annotationDoiThreshold: finalSettings.annotationDoiThreshold,
        insetDoiThreshold: finalSettings.insetDoiThreshold,
      };
      // Server-cut datasets (issue #315 A3 / P-d): the slider commit
      // re-propagates server-side from the retained revision (one RTT, 409
      // re-seeds from the current selection). Failure falls through to the
      // client field lane (#337 PR B — formerly the graph oracle).
      const willTryServer = hasSelection && serverPropagationEligible({
        nodeCount: nodes.length,
        labeledExclusionActive: !!labeledNodeIds,
        pinnedCount: freehandPinnedIds(store.getState().freehand).size,
      });
      let serverApplied = false;
      if (willTryServer) {
        serverApplied = await propagateSliderCommitOnServer(nodes, commitSettings);
        if (!isCurrentClusteringEpoch(epoch)) {
          // Superseded: the newer commit owns the preview frame from here.
          return;
        }
      }
      // Client field lane (issue #315 field parity): re-run the falloff over
      // the RESIDENT field — the distances are seed-dependent only, so a
      // slider commit needs no recompute. First field commit without a
      // resident field (deep-link straight to a slider release) computes it.
      // Reuse is refused across the unlabeled-only toggle (#337,
      // canReuseResidentField): labeled commits always recompute
      // (assignments move between commits) and a field seeded under labeled
      // exclusion must not serve an unlabeled commit (small-dataset workflow
      // — the EDT recompute is cheap).
      let localFieldApplied = false;
      const commitPinnedIds = freehandPinnedIds(store.getState().freehand);
      if (!serverApplied && hasSelection) {
        localFieldApplied = canReuseResidentField(nodes.length, !!labeledNodeIds)
          ? applyResidentFieldLocally(nodes, commitSettings, undefined, {
              pinnedNodeIds: commitPinnedIds,
            })
          : await runLocalFieldPropagation(nodes, commitSettings, undefined, {
              labeledNodeIds,
              pinnedNodeIds: commitPinnedIds,
            });
        if (!isCurrentClusteringEpoch(epoch)) return;
      }
      if (!hasSelection) {
        // No selection: doi = 1 for all (every lane — the opacity rebuild
        // below reads the column).
        const cols = columnsOf(nodes);
        if (cols) cols.doi.fill(1);
        else for (const node of nodes) node.DoI = 1;
        // The doiGroup pass is skipped on server-cut for the same reason the
        // boot marking pass is (issue #315 A3 P-a, useInitialClustering):
        // with uniform DoI an UNWRITTEN doiGroup already classifies as
        // "inset" there (cutDrivenGroups' undefinedGroup), so the O(n) row
        // pass produces the state the absence already encodes — and on the
        // row-lazy lane it would have to materialize the whole dataset.
        if (!resolveCutProvider(undefined)) {
          for (const node of nodes) {
            updateNodeGroup(node, {
              grayOutDoiThreshold: finalSettings.grayOutDoiThreshold,
              annotationDoiThreshold: finalSettings.annotationDoiThreshold,
              insetDoiThreshold: finalSettings.insetDoiThreshold,
            }, labeledNodeIds);
          }
        }
      }

      // Skipped on the server path (deletion census, plan §7.4): edgeDoi
      // reader unreachable on server-cut, midpoint DoI write-only.
      if (!serverApplied) {
        updateEdgeColumnDois(segs, nodes);
        updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
      }

      // Push final opacity field to the renderer.
      // Server/field path (issue #315 P7 S5): the apply already materialized
      // exactly this buffer — uploading it directly skips a 1M alloc +
      // accessor-read sweep per slider commit. Labeled-exclusion commits
      // (#337) deliberately set NO applied buffer, so they land in the
      // zeroing branch below and labeled points paint transparent.
      const appliedField =
        serverApplied || localFieldApplied ? getAppliedFieldOpacity() : null;
      applyOpacityUniforms();
      let gpuCommitFade = false;
      if (appliedField && appliedField.length === nodes.length) {
        // GPU-lane COMMIT FADE (plan §5c, CS feel round 2): a release without
        // a prior hold used to swap the GPU preview for the committed field
        // in one frame — the same visible step the truth blend already
        // removed for holds. Fade the committed field in through the same
        // mechanism instead (settle-commits ride it too, softening the
        // in-place apply). Degrades to the one-frame swap when the blend
        // infra is unavailable.
        if (wasGpuMotion && renderer.uploadConvergedMotionExact?.(appliedField)) {
          clearPreviewVisuals(); // quality restore; no shader preview is up
          startGpuTruthBlendRef.current(appliedField);
          ledgerEvent("doi:gpu-commit-fade", `n=${appliedField.length}`);
          gpuCommitFade = true;
        } else {
          renderer.setOpacityField(appliedField);
        }
      } else {
        // In unlabeled-only mode, labeled nodes are zeroed so they appear
        // visually transparent regardless of their computed DoI.
        const opacityValues = doiOpacityField(nodes);
        if (labeledNodeIds) {
          // Labeled nodes render transparent regardless of their DoI. Reached
          // only in unlabeled-only labeling mode, which materializes the rows
          // when labeling is enabled (issue #315 R1b) — the id column serves
          // it columnar anyway.
          const labelCols = columnsOf(nodes);
          for (let i = 0; i < nodes.length; i++) {
            const id = labelCols ? labelCols.id[i] : nodes[i].id;
            if (labeledNodeIds.has(String(id))) opacityValues[i] = 0;
          }
        }
        renderer.setOpacityField(opacityValues);
      }
      // CROSS-FADE instead of the one-frame swap (issue #315, CS 2026-07-26): the
      // committed texture is already uploaded, so the fade only has to walk the
      // shaders' mix uniform from the held preview to it. Its end state calls
      // clearPreviewVisuals() — the exact committed field, plus the full-quality
      // restore the drag deferred. The GPU commit fade above replaces it on
      // that path (there is no shader preview term to walk).
      if (!gpuCommitFade) startReleaseBlend();
      renderer.render();

      // ── Clustering ───────────────────────────────────────────────────────────
      // Read from refs so we always have the latest instance even if this async
      // function was created before hdbscan finished initialising.
      const hdbscan = fullSelectionHdbscanRef.current;
      const midpointHdbscan = fullSelectionMidpointHdbscanRef.current;

      // Server-cut datasets (issue #315 S2b) ship no trees: hdbscan is
      // undefined, but the commit must still recluster — the DoI-filtered
      // subset worker-fits from coords, the full-bundle case uses the cut
      // provider. Without this, releasing a propagation slider never produced
      // the new insets on a treeless dataset (CS report 2026-07-18).
      if (!hdbscan && !resolveCutProvider(undefined)) {
        if (isCurrentClusteringEpoch(epoch)) performZoomClustering();
        return;
      }

      // Single unified clustering: all visible nodes (annotation+inset doiGroups)
      // are clustered together; the function internally splits by avg DoI per cluster.
      await runHdbscanClusteringWithStatus(nodes, hdbscan, undefined, epoch);

      if (midpointHdbscan || resolveCutProvider(undefined)) {
        await runTrajectoryMidpointClusteringWithStatus(
          trajectoryMidpointsRef.current,
          finalSettings.annotationDoiThreshold,
          midpointHdbscan,
          undefined,
          epoch
        );
      }

      if (isCurrentClusteringEpoch(epoch)) performZoomClustering();
    },
    [
      stopPreviewRAF,
      clearPreviewVisuals,
      startReleaseBlend,
      setSliderSettings,
      currentSliderSettingsRef,
      sliderUpdateFrameRef,
      rendererRef,
      visualSettings,
      dataRef,
      segmentsRef,
      trajectoryMidpointsRef,
      performZoomClustering,
      fullSelectionHdbscanRef,
      fullSelectionMidpointHdbscanRef,
      // unlabeledOnlyMode and assignments are read from store.getState() at
      // call-time — no need to list them here and cause re-creation on every
      // label assignment.
    ]
  );

  // Keep an always-current ref so the effect below never captures a stale
  // version of the commit callback.
  const handlePropagationSliderFinalChangeRef = useRef(handlePropagationSliderFinalChange);
  handlePropagationSliderFinalChangeRef.current = handlePropagationSliderFinalChange;

  // Re-run the full commit propagation whenever unlabeled-only mode is toggled.
  // This immediately re-groups all nodes so the exclusion takes effect without
  // requiring the user to move a slider.
  const isFirstUnlabeledOnlyRender = useRef(true);
  useEffect(() => {
    if (isFirstUnlabeledOnlyRender.current) {
      isFirstUnlabeledOnlyRender.current = false;
      return;
    }
    void handlePropagationSliderFinalChangeRef.current(currentSliderSettingsRef.current);
  }, [unlabeledOnlyMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // GPU motion lane bench probe (plan-gpu-motion-lane.md §5): flag-gated
  // window hook the e2e harness calls mid-drag — reads the last GPU tick's
  // field back and diffs it against the exact CPU converged preview at the
  // LIVE slider values (the reported f32-vs-f64 delta). Debug only: the
  // readback stalls the GPU pipe.
  useEffect(() => {
    if (typeof window === "undefined" || !gpuMotionLaneEnabled()) return;
    const w = window as unknown as {
      __gpuMotionProbe?: () =>
        | { n: number; maxDelta: number; meanDelta: number }
        | null;
    };
    w.__gpuMotionProbe = () => {
      const api = rendererRef.current;
      const nodes = dataRef.current;
      const gpu = api?.readConvergedMotionField?.();
      if (!gpu || !nodes?.length || gpu.length !== nodes.length) return null;
      const s = currentSliderSettingsRef.current;
      const cpu = previewFalloffOpacity(nodes, {
        proximitySlider: s.proximitySlider,
        pastSlider: s.pastSlider,
        futureSlider: s.futureSlider,
        maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
        grayOutDoiThreshold: s.grayOutDoiThreshold,
        annotationDoiThreshold: s.annotationDoiThreshold,
        insetDoiThreshold: s.insetDoiThreshold,
      });
      if (!cpu) return null;
      let maxDelta = 0;
      let sum = 0;
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.abs(gpu[i] - cpu[i]);
        if (d > maxDelta) maxDelta = d;
        sum += d;
      }
      return { n: nodes.length, maxDelta, meanDelta: sum / nodes.length };
    };
    return () => {
      delete w.__gpuMotionProbe;
    };
  }, [rendererRef, dataRef, currentSliderSettingsRef, visualSettings.maxEmbeddingDistance]);

  // Terminate the field-preview worker on unmount (avoid a leaked Worker) and
  // disarm a pending settle-commit.
  useEffect(() => {
    return () => {
      const client = fieldPreviewClientRef.current;
      if (client) client.reset();
      if (convSettleTimerRef.current !== null) {
        clearTimeout(convSettleTimerRef.current);
        convSettleTimerRef.current = null;
      }
    };
  }, []);

  return {
    handlePropagationSliderChange,
    handlePropagationSliderFinalChange,
    notifyDatasetSwap,
  };
}
