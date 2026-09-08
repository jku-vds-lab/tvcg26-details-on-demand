/**
 * Helpers for the D2 diff-inset spotlight: compute per-element JSX opacity
 * so that clusters unrelated to the hovered relation fade to SPOTLIGHT_DIM
 * in sync with the WebGL scatterplot dimming.
 *
 * spotlightUids is null when no spotlight is active (→ all elements full opacity).
 * When active it holds the two endpoint cluster uids from the hovered relation's
 * `element.relationAnchors.{uidA, uidB}`.
 */
export { SPOTLIGHT_DIM } from "src/hooks/relationSpotlightField";

import { SPOTLIGHT_DIM } from "src/hooks/relationSpotlightField";

/**
 * Opacity for a single-cluster glyph (node inset, annotation label, contour,
 * node leader). Returns full opacity (1) when there is no active spotlight or
 * when the element's cluster uid is one of the spotlighted pair; otherwise
 * returns SPOTLIGHT_DIM.
 */
export function spotlightOpacity(
  uid: string,
  spotlightUids: ReadonlySet<string> | null
): number {
  if (!spotlightUids) return 1;
  return spotlightUids.has(uid) ? 1 : SPOTLIGHT_DIM;
}

/**
 * Opacity for a relation glyph (relation/edge inset or relation leader).
 * Returns full opacity only when BOTH endpoint uids are spotlighted — i.e.
 * this is exactly the hovered relation. All other relations dim to SPOTLIGHT_DIM.
 */
export function relationSpotlightOpacity(
  uidA: string,
  uidB: string,
  spotlightUids: ReadonlySet<string> | null
): number {
  if (!spotlightUids) return 1;
  return spotlightUids.has(uidA) && spotlightUids.has(uidB) ? 1 : SPOTLIGHT_DIM;
}
