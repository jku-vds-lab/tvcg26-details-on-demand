// GPU falloff-preview support probe (issue #315 T1).
//
// Standalone (type-only imports) so it can be unit-tested without dragging in
// the heavy hook/data modules. Used by useDoIPropagation's drag-preview branch.

import type { RendererAPI } from "./RendererAPI";

/**
 * Whether the renderer exposes the GPU falloff-preview API. A defensive
 * optional-call guard: when false the drag-preview branch keeps the worker/sync
 * path as the sole preview (byte-identical to pre-#315 behavior), so a renderer
 * built before the API — or a test double lacking it — degrades cleanly instead
 * of throwing.
 */
export function canUseShaderFalloffPreview(
  renderer: Partial<Pick<RendererAPI, "setFalloffPreview" | "setDistanceField">> | null | undefined
): boolean {
  return (
    !!renderer &&
    typeof renderer.setFalloffPreview === "function" &&
    typeof renderer.setDistanceField === "function"
  );
}
