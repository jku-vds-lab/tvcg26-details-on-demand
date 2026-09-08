import { animate, type Easing } from "framer-motion";
import { useCallback, useEffect, useRef } from "react";
import { useDataRef } from "src/contexts/DataContext";
import { useRendererApiRef } from "src/contexts/RendererApiContext";
import { getPropagationPrecomputation } from "src/doiPropagation/propagateDoi";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";
import { doiOpacityField } from "../dataPreprocessing/pointColumns";
import store from "src/store";
import { resolveEase } from "src/utils/resolveEase";
import { lerpField } from "./lerpField";
import { relationEmphasisField } from "./relationEmphasisField";
import { SPOTLIGHT_DIM, relationSpotlightField } from "./relationSpotlightField";

/**
 * Returns a stable `spotlight` callback for D2 diff-inset hover:
 * - spotlight(item): animates the scatterplot from the current opacity/emphasis
 *   state to the spotlight target (dim everything, raise endpoint nodes) over
 *   clusterSettings.duration with clusterSettings.ease — the same timing as
 *   the inset glyph animations.
 * - spotlight(null): animates back to the DoI-based opacity field (zeros emphasis).
 *
 * Animation uses framer-motion `animate()` (0→1 scalar tween) + elementwise
 * lerpField() to produce per-frame Float32Array uploads via setOpacityField /
 * setEmphasisField. In-flight tweens are cancelled on each new call and on unmount.
 *
 * `setEmphasisScale` is called once per gesture with the current
 * `spotlightEmphasisScale` setting so the renderer's scale uniform is fresh.
 */
export function useRelationSpotlight(): (item: ClusterItem | null) => void {
  const dataRef = useDataRef();
  const rendererApiRef = useRendererApiRef();

  // Current "from" fields for the tween — updated at tween completion.
  const fromOpacityRef = useRef<Float32Array | null>(null);
  const fromEmphasisRef = useRef<Float32Array | null>(null);
  // In-flight framer-motion controls — cancelled on re-entry and unmount.
  const controlsRef = useRef<ReturnType<typeof animate> | null>(null);

  // Cancel on unmount.
  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
    };
  }, []);

  return useCallback(
    (item: ClusterItem | null) => {
      const renderer = rendererApiRef.current;
      const data = dataRef.current;
      if (!renderer || !data.length) return;

      // Cancel any in-flight tween.
      controlsRef.current?.stop();
      controlsRef.current = null;

      const state = store.getState();
      const { duration, ease, spotlightEmphasisScale } = state.clusterSettings;
      // During spotlight: force gray-below-threshold and use a threshold just above
      // SPOTLIGHT_DIM so dimmed nodes render gray. On restore: use the user's setting.
      const opacityParams = item !== null
        ? {
            threshold: SPOTLIGHT_DIM + 0.01,
            minAlpha: state.visualizationSettings.minimumOpacityClamping,
            maxAlpha: state.visualizationSettings.maximumOpacityClamping,
            forceApplyGray: true,
          }
        : {
            threshold: state.visualizationSettings.grayOutDoiThreshold,
            minAlpha: state.visualizationSettings.minimumOpacityClamping,
            maxAlpha: state.visualizationSettings.maximumOpacityClamping,
            forceApplyGray: false,
          };

      // Build the "restore" opacity field (DoI-based) and zeros emphasis for reuse.
      // Columnar DoI read (issue #315 R1b): the accessor twin over a row-lazy
      // array would dereference holes, and this runs per hover.
      const restoreOpacity = doiOpacityField(data);
      const restoreEmphasis = new Float32Array(data.length); // all zeros

      // Initialise from-refs on first call so the first tween has a valid start.
      if (!fromOpacityRef.current) fromOpacityRef.current = restoreOpacity.slice();
      if (!fromEmphasisRef.current) fromEmphasisRef.current = restoreEmphasis.slice();

      let toOpacity: Float32Array;
      let toEmphasis: Float32Array;

      if (item !== null) {
        const { indexById } = getPropagationPrecomputation(data);
        toOpacity = relationSpotlightField(
          item.element.samples as EdgeAugmentedPoint[],
          indexById,
          data.length
        );
        toEmphasis = relationEmphasisField(
          item.element.samples as EdgeAugmentedPoint[],
          indexById,
          data.length
        );
      } else {
        toOpacity = restoreOpacity;
        toEmphasis = restoreEmphasis;
      }

      // Apply the emphasis scale and opacity params once (uniform-only, instant).
      renderer.setEmphasisScale(spotlightEmphasisScale);
      renderer.setOpacityParams(opacityParams);

      const fromOpacity = fromOpacityRef.current!;
      const fromEmphasis = fromEmphasisRef.current!;

      // Resolve the ease the same way every JSX spotlight layer does (see
      // resolveEase.ts) so this JS-driven tween renders the identical curve as
      // the motion.div/motion.g/motion.line spotlight fades.
      const resolvedEase: Easing = resolveEase(ease);
      const controls = animate(0, 1, {
        duration,
        ease: resolvedEase,
        onUpdate(t: number) {
          if (!renderer) return;
          renderer.setOpacityField(lerpField(fromOpacity, toOpacity, t));
          renderer.setEmphasisField(lerpField(fromEmphasis, toEmphasis, t));
          renderer.render();
        },
      });
      // Store controls first so cancelation works immediately; update from-refs on completion.
      controlsRef.current = controls;
      controls.then(() => {
        fromOpacityRef.current = toOpacity;
        fromEmphasisRef.current = toEmphasis;
        controlsRef.current = null;
      });
    },
    [dataRef, rendererApiRef]
  );
}
