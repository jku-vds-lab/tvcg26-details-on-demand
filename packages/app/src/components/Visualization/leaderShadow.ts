/**
 * Computes a CSS `drop-shadow(...)` filter string for SVG leader lines.
 *
 * Apply to a `<g>` wrapping the coloured line + arrowhead (NOT the bg-colour
 * halo line underneath) so the halo is not double-shadowed.
 *
 * Blur and offset are scaled by `cssScale` (= 1/zoomK) so the shadow stays
 * visually constant across zoom — the same mechanism used for leader widths
 * and arrowhead sizes.
 *
 * @param enabled   - whether the shadow is turned on in settings
 * @param intensity - blur radius in data-space px at zoom=1
 * @param cssScale  - element.currentCssScale (= 1/zoomK)
 * @returns a CSS `drop-shadow()` string, or `undefined` when shadow is off
 */
export function computeLeaderShadowFilter(
  enabled: boolean,
  intensity: number,
  cssScale: number
): string | undefined {
  if (!enabled || intensity <= 0) return undefined;
  const blur = intensity * cssScale;
  const offset = blur / 2;
  return `drop-shadow(0px ${offset}px ${blur}px rgba(0,0,0,0.45))`;
}
