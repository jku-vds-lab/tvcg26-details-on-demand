/**
 * relationLeaderStyle.ts
 *
 * Pure, side-effect-free mapping from a normalised direction strength [0,1]
 * to visual channel values for a relation leader line.
 *
 * All sizes are in data-space px at zoom=1; callers multiply by cssScale (=1/k)
 * before using them in screen-space SVG.
 *
 * Design: **Strategy** pattern.
 * The opts object selects between two line-width strategies: constant (default)
 * and strength-lerp.  The caller owns the choice; this module owns the math.
 */

export interface RelationLeaderStyleOpts {
  /** Minimum arrowhead length (at strength=0). */
  minArrow: number;
  /** Maximum arrowhead length (at strength=1). */
  maxArrow: number;
  /**
   * Minimum leader line width when `widthEncodesStrength` is true.
   * Ignored when false (line width is always `baseWidth`).
   */
  minWidth: number;
  /** Full/base line width (used as the ceiling when width-encoding is on). */
  baseWidth: number;
  /**
   * Target total outline/halo width.  The halo added on top of the line is
   * `max(0, outlineThickness - baseWidth)` so it is consistent regardless of
   * whether width-encoding changes the line width.
   */
  outlineThickness: number;
  /** When true, line width lerps from minWidth (strength=0) to baseWidth (strength=1). */
  widthEncodesStrength: boolean;
}

export interface RelationLeaderStyle {
  /** Arrowhead length (px, pre-cssScale). */
  arrowLength: number;
  /** Leader line stroke-width (px, pre-cssScale). */
  lineWidth: number;
  /** Outline/halo stroke-width (px, pre-cssScale).  Always ≥ lineWidth. */
  outlineWidth: number;
}

/**
 * Compute leader-line style values for a single direction at the given normalised strength.
 *
 * @param strength  Normalised directional score ∈ [0,1] (already divided by allMax).
 * @param opts      Styling parameters from the Redux store.
 */
export function computeRelationLeaderStyle(
  strength: number,
  opts: RelationLeaderStyleOpts
): RelationLeaderStyle {
  const s = Math.max(0, Math.min(1, strength));

  // Arrow: always shows at least minArrow; grows to maxArrow at full strength.
  const maxA = Math.max(opts.minArrow, opts.maxArrow);
  const arrowLength = opts.minArrow + (maxA - opts.minArrow) * s;

  // Line width: constant baseWidth by default; lerps from minWidth when encoding is on.
  const lineWidth = opts.widthEncodesStrength
    ? opts.minWidth + Math.max(0, opts.baseWidth - opts.minWidth) * s
    : opts.baseWidth;

  // Outline: constant halo = outlineThickness - baseWidth, applied on top of current lineWidth.
  const halo = Math.max(0, opts.outlineThickness - opts.baseWidth);
  const outlineWidth = lineWidth + halo;

  return { arrowLength, lineWidth, outlineWidth };
}
