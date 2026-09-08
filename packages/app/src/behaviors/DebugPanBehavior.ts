import { InteractionBehavior } from "../types/InteractionBehavior";

export const DebugPanBehavior: InteractionBehavior = {
  filter: e => e.button === 2, // right‐click
  onStart: e => console.log("[Pan] start", e.pointerId, "at", e.clientX, e.clientY),
  onMove: e => console.log("[Pan] move", e.pointerId, "to", e.clientX, e.clientY),
  onEnd:  e => console.log("[Pan] end", e.pointerId),
  onWheel: e => { console.log("[Pan] wheel delta", e.deltaY); return false; }
};