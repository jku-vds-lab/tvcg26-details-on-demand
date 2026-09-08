// src/behaviors/ZoomBehavior.ts

import * as d3 from "d3";
import type { RendererAPI } from "../gl/api/RendererAPI";
import { updateRendererTransform } from "../semanticZoom/semanticZoom";
import type { VisualizationSettings } from "../store";
import type { InteractionBehavior } from "../types/InteractionBehavior";
import { getTranslateExtent } from "../utils/constants";

/**
 * A D3‐powered zoom/pan behavior driving both wheel‐zoom and right‐click pan.
 */
export function createZoomBehavior(
  canvas: HTMLCanvasElement,
  getParams: () =>
    | {
        width: number;
        height: number;
        xScale: d3.ScaleLinear<number, number>;
        yScale: d3.ScaleLinear<number, number>;
      }
    | null,
  onZoomChange: (t: d3.ZoomTransform) => void,
  settings: VisualizationSettings,
  renderer: RendererAPI,
  opts?: {
    onStart?: () => void;
    onZoom?: () => void;
    onEnd?: () => void;
    /**
     * Called once with the d3 zoom instance right after it is built, so callers
     * can apply programmatic transforms (`zoom.transform(d3.select(canvas), t)`)
     * that flow through the same "zoom" handler as user gestures.
     */
    onZoomReady?: (handle: {
      zoom: d3.ZoomBehavior<HTMLCanvasElement, unknown>;
      canvas: HTMLCanvasElement;
    }) => void;
    /**
     * Destination announcement (issue #315 T0): fired per animated wheel
     * notch with the transform the burst's ease will END on (compounded
     * targetK, focal point invariant — the same endpoint d3's scaleTo
     * computes, minus the rarely-active translate constrain), and with
     * null when the burst closes. Lets the server request be keyed to
     * where the glide is going instead of a mid-ease frame.
     */
    onWheelDestination?: (t: d3.ZoomTransform | null) => void;
  }
): InteractionBehavior {
  // True from the first animated wheel notch until the last notch's
  // transition ends — the whole burst is surfaced as ONE gesture.
  let wheelBurstActive = false;
  // Set by the final notch's end/interrupt listener; consumed by the zoom
  // "end" forwarding below. The transition listener runs BEFORE d3-zoom's
  // own end.zoom listener (registration order), so closing the burst there
  // directly would un-suppress that same dispatch's zoom "end" and fire
  // onEnd twice. The hand-off also orders end-before-start correctly when
  // a real pan interrupts the animation mid-flight.
  let wheelBurstClosing = false;
  const zoom = d3
    .zoom<HTMLCanvasElement, unknown>()
    // Wheel events are accepted ONLY when re-dispatched by onWheel below
    // (flagged synthetic). d3's raw wheel listener stopImmediatePropagation()s
    // the event before the container dispatcher sees it, so accepting real
    // wheels here would bypass the animated-notch path for every wheel over
    // the canvas (issue #315). Rejected events keep bubbling to the
    // dispatcher, which routes them back through onWheel.
    .filter((event: MouseEvent) =>
      event.type === "wheel"
        ? (event as unknown as Record<string, unknown>).__zoomBehaviorSynthetic === true
        : event.button === 2
    )
    .scaleExtent([settings.minZoom, settings.maxZoom])
    .translateExtent(
      (() => {
        const p = getParams();
        const w = p?.width ?? canvas.clientWidth;
        const h = p?.height ?? canvas.clientHeight;
        return getTranslateExtent(w, h);
      })()
    )
    .on("start", () => {
      // Suppressed during an animated wheel burst: each notch's transition
      // emits its own start/end, but the burst must read as ONE gesture
      // (gesture-end work — settle pass + GL restore — is expensive at 1M).
      if (!wheelBurstActive) opts?.onStart?.();
    })
    .on("zoom", (event) => {
      onZoomChange(event.transform);
      const p = getParams();
      if (p) {
        updateRendererTransform(
          event.transform,
          p.width,
          p.height,
          p.xScale,
          p.yScale,
          renderer
        );
        renderer.render();
      }
      opts?.onZoom?.();
    })
    .on("end", () => {
      if (wheelBurstClosing) {
        wheelBurstClosing = false;
        wheelBurstActive = false;
        opts?.onEnd?.();
      } else if (!wheelBurstActive) {
        opts?.onEnd?.();
      }
    });

  opts?.onZoomReady?.({ zoom, canvas });

  // Animated wheel zoom (issue #315; CS: zoom feels "entirely static" vs
  // Google Maps): discrete wheel notches ease the transform over ~150 ms
  // instead of jumping. The transition drives the zoom behavior itself, so
  // every frame flows through the same "zoom" handler as user gestures —
  // mid-gesture frames ride the snapshot compositor on huge datasets, so
  // the animation costs ~1 ms/frame. Successive notches compound a TARGET
  // scale (not the mid-animation current scale), so fast scrolling keeps
  // the exact zoom-per-notch of the raw d3 wheel path. The DEFAULT
  // (unnamed) transition is used deliberately: d3-zoom's own gesture
  // bookkeeping interrupts it when a pan/drag starts mid-animation.
  const WHEEL_EASE_MS = 150;
  // Animated notches are tuned for scale-edition datasets, where mid-burst
  // frames ride the gesture compositor / aggregate base (~1 ms/frame). On
  // small (paper) datasets there is no compositor: every eased frame runs
  // the full annotation/inset pipeline plus mid-burst ticks, and the 150 ms
  // ease reads as a stutter loop per notch (CS, rubik 10x2, 2026-07-20).
  // Those keep the raw instant d3 notch — the feel CS calls perfectly
  // smooth there. Threshold matches the renderer's density-scale gate.
  const animatedNotchEligible = (): boolean => {
    const raw = renderer.getRaw?.() as
      | { nodeCount?: number; densityHint?: { count?: number } | null }
      | null
      | undefined;
    const count = Math.max(raw?.nodeCount ?? 0, raw?.densityHint?.count ?? 0);
    return count > 300_000;
  };
  let wheelTargetK: number | null = null;
  let wheelSeq = 0;
  // Timestamp of the last wheel event of ANY kind — the gap between events
  // is what separates detached mouse notches from trackpad streams.
  let lastWheelEventAtMs = Number.NEGATIVE_INFINITY;
  const animateWheelNotch = (e: WheelEvent | { deltaY: number; deltaMode?: number; clientX: number; clientY: number }): void => {
    const factor = Math.pow(
      2,
      -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002)
    );
    const currentK = d3.zoomTransform(canvas).k;
    const targetK = Math.max(
      settings.minZoom,
      Math.min(settings.maxZoom, (wheelTargetK ?? currentK) * factor)
    );
    wheelTargetK = targetK;
    const seq = ++wheelSeq;
    wheelBurstClosing = false; // a new notch keeps the burst open
    if (!wheelBurstActive) {
      wheelBurstActive = true;
      opts?.onStart?.();
    }
    const rect = canvas.getBoundingClientRect();
    const point: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
    if (opts?.onWheelDestination) {
      // Endpoint of the ease: keep the focal DATA point under the cursor at
      // targetK — screen = data·k + [x,y], so [x,y] = p − t.invert(p)·targetK.
      const t = d3.zoomTransform(canvas);
      const p1 = t.invert(point);
      opts.onWheelDestination(
        d3.zoomIdentity
          .translate(point[0] - p1[0] * targetK, point[1] - p1[1] * targetK)
          .scale(targetK)
      );
    }
    const transition = d3
      .select(canvas)
      .transition()
      .duration(WHEEL_EASE_MS)
      .ease(d3.easeCubicOut)
      .on("end interrupt", () => {
        // Only the freshest notch closes the burst — an older notch's
        // interrupt (fired when the next one retargets) must not. The
        // freshest one's "interrupt" also fires when a real gesture (pan)
        // cuts in, correctly ending the wheel burst before the pan starts.
        // The actual close happens in the zoom "end" forwarding (see
        // wheelBurstClosing) so onEnd fires exactly once.
        if (seq === wheelSeq) {
          wheelTargetK = null;
          wheelBurstClosing = true;
          opts?.onWheelDestination?.(null);
        }
      });
    zoom.scaleTo(
      transition as unknown as d3.TransitionLike<HTMLCanvasElement, unknown>,
      targetK,
      point
    );
  };

  return {
    filter: (e) => e.button === 2,

    onStart: (e) => {
      d3.select(canvas).call(zoom);
      try {
        canvas.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            clientX: e.clientX,
            clientY: e.clientY,
            button: e.button,
            // d3-drag/zoom read event.view.document — must be the real Window
            // (https://github.com/d3/d3-drag/issues/79). This was `global.window`,
            // which is undefined in the browser: the constructor threw into this
            // catch on EVERY call, so the synthetic dispatch never fired and
            // right-drag pan only worked when the real compat mousedown hit the
            // canvas directly — i.e. never when the gesture started on an inset.
            view: window,
          })
        );
      } catch {
        // swallow D3 nodrag_default errors
      }
    },

    onMove: () => {
      /* D3 handles move/up internally */
    },

    onEnd: () => {
      /* D3 handles move/up internally */
    },

    onWheel: (e) => {
      d3.select(canvas).call(zoom);
      // Trackpads stream many small deltas at high frequency (and pinch-zoom
      // sets ctrlKey) — those stay on d3's raw wheel path, which is the feel
      // CS explicitly wants preserved. Only unambiguous mouse notches get the
      // eased step: line-mode deltas (Firefox mice) or big pixel deltas
      // (≥100 — Chrome mice emit 100/120 per notch, trackpad streams rarely
      // reach that) that either continue an active animated burst or arrive
      // detached (≥50 ms since the previous wheel event — trackpad streams
      // run at 60 Hz+, so their big mid-flick deltas fail this test).
      const nowMs = performance.now();
      const gapMs = nowMs - lastWheelEventAtMs;
      lastWheelEventAtMs = nowMs;
      const notchSized = e.deltaMode !== 0 || Math.abs(e.deltaY) >= 100;
      if (
        notchSized &&
        !e.ctrlKey &&
        (wheelBurstActive || gapMs >= 50) &&
        animatedNotchEligible()
      ) {
        animateWheelNotch(e);
        return true;
      }
      try {
        const synthetic = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          // Full fidelity for d3's wheelDelta: deltaMode picks the per-unit
          // factor, ctrlKey applies the 10× pinch-zoom multiplier, deltaX
          // keeps horizontal pans intact. Dropping these (the original
          // regression) made trackpad pinch 10× slower than before.
          deltaY: e.deltaY,
          deltaX: e.deltaX,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        // Marks the event as ours so the zoom filter accepts it (real wheel
        // events are rejected there and routed through this handler instead).
        (synthetic as unknown as Record<string, unknown>).__zoomBehaviorSynthetic = true;
        canvas.dispatchEvent(synthetic);
      } catch {
        // swallow errors
      }
      return true;
    },
  };
}
