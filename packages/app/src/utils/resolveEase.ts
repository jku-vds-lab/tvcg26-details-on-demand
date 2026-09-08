import { easingDefinitionToFunction, type Easing } from "framer-motion";

/**
 * Resolve a clusterSettings ease name to a form that renders the SAME curve on
 * every animation pipeline in play:
 *
 * - framer-motion's WAAPI path (motion.div — HTML elements only, see
 *   motion-dom's `supportsBrowserAnimation`): given a *string* ease it
 *   silently substitutes named eases without native CSS keywords (the circ,
 *   back, and anticipate families) with a fixed cubic-bezier approximation
 *   whose shape diverges drastically from the true math function (e.g.
 *   "circOut": true curve reaches ~87% at halfway, the bezier stand-in ~15%).
 *   Given a *function* it generates an exact sampled CSS linear() easing.
 * - framer-motion's JS loop (motion.g/motion.line — SVG) and scalar animate()
 *   tweens: run the true math function for named eases.
 *
 * So: names with mathematically exact CSS keywords pass through as strings;
 * everything else resolves to the true easing function, which every pipeline
 * renders exactly. Used by all spotlight overlay layers and the WebGL
 * spotlight tween so their fades stay in visual sync (issue #233).
 */
const EXACT_CSS_EASINGS = new Set(["linear", "easeIn", "easeOut", "easeInOut"]);

export function resolveEase(ease: string): Easing {
  if (EXACT_CSS_EASINGS.has(ease)) return ease as Easing;
  return easingDefinitionToFunction(ease as Easing);
}
