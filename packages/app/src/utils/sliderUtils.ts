// src/utils/sliderUtils.ts

// Factor to control the curvature. A higher factor results in a steeper rise near 0.
const factor = 5;

/**
 * Converts a linear value [0, 1] to a logarithmic-like scale.
 * @param linear - A number between 0 and 1.
 * @returns A logarithmic-like scaled value.
 */
export const linearToLog = (linear: number): number =>
  1 - (Math.exp((1 - linear) * factor) - 1) / (Math.exp(factor) - 1);

/**
 * Converts a logarithmic-like value back to a linear [0, 1] value.
 * @param logValue - A number between 0 and 1.
 * @returns A linear value corresponding to the logarithmic input.
 */
export const logToLinear = (logValue: number): number =>
  1 - Math.log((1 - logValue) * (Math.exp(factor) - 1) + 1) / factor;

/**
 * Generates marks for the slider at each 0.1 step in the logarithmic-like scale.
 * @returns An array of objects with a `value` property for each mark.
 */
export const generateLogMarks = (): { value: number }[] =>
  Array.from({ length: 9 }, (_, i) => {
    const val = (i + 1) / 10;
    return { value: logToLinear(val) };
  });

/**
 * Cubic low-end slider warp (issue #315 A3): the thumb runs on a POSITION
 * q ∈ [0, 1] with a fine step, and the semantic value the app receives is
 * v = q³. The cubic gives the bottom decade (v ≤ 0.01) ~22% of the track —
 * where the interesting region lives for controls whose 0→1-2% band matters
 * (proximity reach, transparency clamping) — while v = 0.1 still sits near
 * mid-track. Endpoints are exact (q=0 → v=0, q=1 → v=1), so the [0, 1]
 * semantics of the underlying value are preserved.
 * @param q - Slider position in [0, 1].
 * @returns The semantic value v = q³.
 */
export const cubicSliderToValue = (q: number): number => q * q * q;

/**
 * Inverse of {@link cubicSliderToValue}: recover the slider position q from a
 * semantic value v, used when reflecting external state into the thumb.
 * @param v - Semantic value in [0, 1].
 * @returns The slider position q = ∛v.
 */
export const cubicValueToSlider = (v: number): number => Math.cbrt(v);

/** @deprecated Use {@link cubicSliderToValue}. Kept as the proximity alias. */
export const proximitySliderToValue = cubicSliderToValue;
/** @deprecated Use {@link cubicValueToSlider}. Kept as the proximity alias. */
export const proximityValueToSlider = cubicValueToSlider;

/**
 * Formats a slider value label by stripping binary floating-point dust
 * accumulated when MUI steps a fractional-step slider via the keyboard
 * (e.g. 0.30000000000000004 → "0.3"), while leaving clean values
 * untouched (12 → "12", 0.35 → "0.35").
 */
export const formatSliderLabel = (value: number): string =>
  String(parseFloat(value.toPrecision(12)));

// ── Reach-linear chain-slider mapping (CS 2026-08-17, third feel pass) ──────
//
// The chain value k steps along a trajectory is w^k, so any mapping that is
// smooth in the WEIGHT w feels violently nonlinear in what the eye sees: the
// visible reach ≈ ln(FLOOR)/ln(w) explodes hyperbolically near w = 1 (log,
// cubic and identity mappings were all tried and rejected — "the difference
// between 0.94 and 1.0 is huge"). The fix inverts the exponential IN THE UI:
// the thumb is linear in the FRACTION OF A TYPICAL TRAJECTORY the chain
// visibly reaches. Two zones, continuous and monotone:
//   [0 … SPAN]   how FAR:  reach = (q/SPAN)·L steps at the visibility floor
//                (slider at 20 % of the span ⇒ trail along 20 % of a median
//                trajectory), w = FLOOR^(1/reach);
//   (SPAN … 1]   how STRONG: the full-length trail saturates — the far end's
//                DoI walks FLOOR → 1, hitting exactly w = 1 at the top (a
//                purely reach-linear track could never reach flood: w = 1 is
//                infinitely far in reach space).
// L = the dataset's median trajectory length (utils/trajectoryStats) — the
// same thumb position means the same thing on 10-ply chess openings and
// 100-step rubik solves. The STORE still holds the true weight w (deep links,
// engine, preview==commit untouched); only the thumb↔weight curve changes.

/** DoI level the reach is measured at (the default gray-out threshold — a UI
 * constant, deliberately NOT the live threshold so thumb positions are
 * stationary). */
const CHAIN_REACH_FLOOR = 0.05;
/** Fraction of the track devoted to length; the rest saturates. */
const CHAIN_REACH_SPAN = 0.75;

/**
 * Thumb position q → effective per-hop chain weight w, linear in visible
 * reach as a fraction of `medianLength` (see the block comment above).
 */
export const chainReachSliderToWeight = (q: number, medianLength: number): number => {
  const L = Math.max(2, medianLength);
  if (q <= 0) return 0;
  if (q >= 1) return 1;
  if (q <= CHAIN_REACH_SPAN) {
    const reach = (q / CHAIN_REACH_SPAN) * L;
    return Math.pow(CHAIN_REACH_FLOOR, 1 / reach);
  }
  const u = (q - CHAIN_REACH_SPAN) / (1 - CHAIN_REACH_SPAN);
  return Math.pow(CHAIN_REACH_FLOOR, (1 - u) / L);
};

/**
 * Inverse of {@link chainReachSliderToWeight}: thumb position for a stored
 * weight (defaults, deep links, demo glides).
 */
export const chainReachWeightToSlider = (w: number, medianLength: number): number => {
  const L = Math.max(2, medianLength);
  if (w <= 0) return 0;
  if (w >= 1) return 1;
  const invReach = Math.log(w) / Math.log(CHAIN_REACH_FLOOR); // = 1/reach
  if (invReach >= 1 / L) {
    // Length zone: reach = 1/invReach ≤ L  ⇒  q = SPAN·reach/L.
    return CHAIN_REACH_SPAN / (L * invReach);
  }
  // Saturation zone: w = FLOOR^((1−u)/L)  ⇒  u = 1 − L·invReach.
  const u = 1 - L * invReach;
  return CHAIN_REACH_SPAN + u * (1 - CHAIN_REACH_SPAN);
};
