/**
 * Defines a pluggable interaction behavior.
 */
export interface InteractionBehavior {
  /**
   * Should this behavior claim the pointerdown event?
   */
  filter: (e: PointerEvent) => boolean;

  /**
   * Called when the pointerdown event is captured by this behavior.
   */
  onStart: (e: PointerEvent) => void;

  /**
   * Called for pointermove events while this behavior is active.
   */
  onMove: (e: PointerEvent) => void;

  /**
   * Called when pointerup is received after onStart.
   */
  onEnd: (e: PointerEvent) => void;

  /**
   * Optional wheel handler: return `true` if the event was handled, else `false`.
   */
  onWheel?: (e: WheelEvent) => boolean;
}
