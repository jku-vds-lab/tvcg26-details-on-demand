/**
 * Elementwise linear interpolation between two Float32Arrays of equal length.
 *
 * Returns a new array where each element is `from[i] + (to[i] - from[i]) * t`.
 * `t` is clamped to [0, 1].
 *
 * Used in useRelationSpotlight to drive per-frame opacity/emphasis field updates
 * during the framer-motion animate() tween so the WebGL spotlight transitions
 * at the same duration/ease as the inset glyphs.
 *
 * @param from  Starting field values.
 * @param to    Target field values.
 * @param t     Interpolation factor in [0, 1].
 */
export function lerpField(
  from: Float32Array,
  to: Float32Array,
  t: number,
): Float32Array {
  const tc = Math.max(0, Math.min(1, t));
  const out = new Float32Array(from.length);
  for (let i = 0; i < from.length; i++) {
    out[i] = from[i] + (to[i] - from[i]) * tc;
  }
  return out;
}
