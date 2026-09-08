import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Finds the 0-based thumb index from a double-click event on a MUI Slider.
 * MUI renders thumbs as `<span data-index="N">` elements.
 * Returns null if the click did not land on (or inside) a thumb.
 */
export function getThumbIndexFromEvent(e: React.MouseEvent): number | null {
  const thumb = (e.target as HTMLElement).closest('[data-index]');
  if (!thumb) return null;
  const raw = (thumb as HTMLElement).dataset.index;
  if (raw === undefined) return null;
  const index = parseInt(raw, 10);
  return isNaN(index) ? null : index;
}

/**
 * Computes the value to restore when a slider thumb is double-click-reset.
 *
 * - **Range sliders** (array values): resets *only* the thumb at `thumbIndex`
 *   to `defaultValue[thumbIndex]`, preserving the other thumb's current value.
 * - **Single-value sliders**: returns `defaultValue` as-is (thumbIndex ignored).
 */
export function computeThumbResetValue(
  defaultValue: number | number[],
  currentValue: number | number[],
  thumbIndex: number,
): number | number[] {
  if (Array.isArray(currentValue) && Array.isArray(defaultValue)) {
    const next = currentValue.slice() as number[];
    const dv = defaultValue[thumbIndex];
    if (dv !== undefined) next[thumbIndex] = dv;
    return next;
  }
  if (!Array.isArray(defaultValue)) return defaultValue;
  // Scalar slider whose defaultValue was inadvertently passed as array – best-effort.
  return defaultValue[thumbIndex] ?? defaultValue[0];
}

/**
 * MUI Slider `sx` snippet that disables thumb and track CSS transitions for
 * one render cycle, preventing the animated drift when a value is set
 * programmatically (e.g. on double-click reset).
 */
const NO_TRANSITION_SX = {
  '& .MuiSlider-thumb': { transition: 'none' },
  '& .MuiSlider-track': { transition: 'none' },
} as const;

/**
 * Returns a `noTransitionSx` object to spread onto a MUI Slider's `sx` prop
 * and a `prepareInstantReset()` function to call immediately before any
 * programmatic value change that should snap without animation.
 *
 * **How it works**: calling `prepareInstantReset()` sets an internal flag that
 * makes `noTransitionSx` carry `transition: 'none'` overrides. Because React 18
 * batches all synchronous state updates in the same event handler, the flag and
 * the new slider value land in a single paint — the thumb renders at its new
 * position without CSS transition. One `requestAnimationFrame` later the flag
 * clears and transitions are restored for subsequent interactions.
 */
export function useInstantReset(): {
  noTransitionSx: typeof NO_TRANSITION_SX | Record<string, unknown>;
  prepareInstantReset: () => void;
} {
  const [active, setActive] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setActive(false);
      rafRef.current = null;
    });
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active]);

  const prepareInstantReset = useCallback(() => setActive(true), []);

  return {
    noTransitionSx: active ? NO_TRANSITION_SX : {},
    prepareInstantReset,
  };
}

/**
 * Combines double-click-reset logic with instant (no-animation) positioning.
 *
 * Returns:
 * - `onDoubleClick` — attach to the wrapping `<Box onDoubleClick={…}>`
 * - `noTransitionSx` — spread onto the MUI Slider's `sx` prop so the thumb
 *   snaps to its default position without a CSS transition.
 *
 * Pass `undefined` as `defaultValue` to disable the behaviour entirely.
 */
export function useSliderDoubleClickReset(
  defaultValue: number | number[] | undefined,
  value: number | number[],
  onReset: (e: React.MouseEvent, resetValue: number | number[]) => void,
): { onDoubleClick: (e: React.MouseEvent) => void; noTransitionSx: typeof NO_TRANSITION_SX | Record<string, unknown> } {
  const { noTransitionSx, prepareInstantReset } = useInstantReset();

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (defaultValue === undefined) return;
      const thumbIndex = getThumbIndexFromEvent(e);
      if (thumbIndex === null) return;
      const resetValue = computeThumbResetValue(defaultValue, value, thumbIndex);
      prepareInstantReset();
      onReset(e, resetValue);
    },
    [defaultValue, value, onReset, prepareInstantReset],
  );

  return { onDoubleClick, noTransitionSx };
}
