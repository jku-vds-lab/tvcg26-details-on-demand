/* src/hooks/useCanvasInteractions.ts */

import { RefObject, useEffect } from "react";
import { InteractionBehavior } from "../types/InteractionBehavior";

/**
 * useCanvasInteractions sets up a single, centralized event dispatcher
 * on the given container. It listens for pointer and wheel events,
 * then routes them to the first matching InteractionBehavior.
 *
 * @param containerRef - ref to the HTML element wrapping the canvas
 * @param behaviors - array of InteractionBehavior to choose from
 */
export function useCanvasInteractions(
  containerRef: RefObject<HTMLElement>,
  behaviors: InteractionBehavior[]
) {
  useEffect(() => {
    // Grab the actual DOM element from the ref
    const container = containerRef.current;
    if (!container) return;  // nothing to do if it's not mounted

    // Map of pointerId to the behavior that claimed that pointer
    const active = new Map<number, InteractionBehavior>();

    /**
     * Called on pointerdown. Finds a behavior whose filter() returns true,
     * then captures the pointer and kicks off that behavior's onStart().
     */
    function onDown(e: PointerEvent) {
      if (!container) throw new Error("Container not found");
      // Pick the first behavior willing to handle this event
      const beh = behaviors.find(b => b.filter(e));
      if (!beh) return;

      // Take exclusive control of this pointer (mouse/finger)
      container.setPointerCapture(e.pointerId);
      active.set(e.pointerId, beh);

      // Let the behavior initialize any state it needs
      beh.onStart(e);

      // Once a behavior has started, listen for its subsequent move/end
      container.addEventListener("pointermove", onMove);
      container.addEventListener("pointerup",   onUp);
      container.addEventListener("pointercancel", onUp);
    }

    /**
     * Called on pointermove for an active pointer. Delegates to the
     * matching behavior's onMove().
     */
    function onMove(e: PointerEvent) {
      // If a behavior claimed this pointer, forward the move event
      active.get(e.pointerId)?.onMove(e);
    }

    /**
     * Called on pointerup or pointercancel. For the claiming behavior,
     * calls onEnd(), releases capture, and cleans up listeners if idle.
     */
    function onUp(e: PointerEvent) {
      if (!container) throw new Error("Container not found");
      const beh = active.get(e.pointerId);
      if (beh) {
        beh.onEnd(e);
        active.delete(e.pointerId);
      }

      // Stop capturing the pointer
      container.releasePointerCapture(e.pointerId);

      // If no pointers remain active, remove move/up listeners
      if (active.size === 0) {
        container.removeEventListener("pointermove", onMove);
        container.removeEventListener("pointerup",   onUp);
        container.removeEventListener("pointercancel", onUp);
      }
    }

    /**
     * Called on wheel. Iterates behaviors in order and invokes onWheel()
     * until one returns true (handled). Prevents default scrolling if handled.
     */
    function onWheel(e: WheelEvent) {
      for (const b of behaviors) {
        // If behavior declares it handled the wheel, stop there
        if (b.onWheel?.(e) === true) {
          e.preventDefault();
          break;
        }
      }
    }

    // Attach the primary listeners
    container.addEventListener("pointerdown", onDown);
    container.addEventListener("wheel",        onWheel, { passive: false });

    // Cleanup: remove everything when unmounting or dependencies change
    return () => {
      container.removeEventListener("pointerdown", onDown);
      container.removeEventListener("wheel",        onWheel);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup",   onUp);
      container.removeEventListener("pointercancel", onUp);
      active.clear();
    };
  }, [containerRef, behaviors]);
}
