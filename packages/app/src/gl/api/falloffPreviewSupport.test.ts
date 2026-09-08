/**
 * Hook-branch guard for the GPU falloff preview (issue #315 T1).
 *
 * The drag-preview branch uses the shader path only when the renderer exposes
 * BOTH setFalloffPreview and setDistanceField; otherwise it falls back to the
 * worker/sync tick as the sole preview (byte-identical to pre-#315 behavior).
 * This pins that defensive optional-call decision without mounting the hook.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { canUseShaderFalloffPreview } from "./falloffPreviewSupport";

describe("canUseShaderFalloffPreview", () => {
  it("is true only when both methods are present", () => {
    expect(
      canUseShaderFalloffPreview({
        setFalloffPreview: jest.fn(),
        setDistanceField: jest.fn(),
      })
    ).toBe(true);
  });

  it("is false when the renderer is null/undefined (falls back to worker path)", () => {
    expect(canUseShaderFalloffPreview(null)).toBe(false);
    expect(canUseShaderFalloffPreview(undefined)).toBe(false);
  });

  it("is false when either method is missing (older renderer)", () => {
    expect(canUseShaderFalloffPreview({ setFalloffPreview: jest.fn() })).toBe(false);
    expect(canUseShaderFalloffPreview({ setDistanceField: jest.fn() })).toBe(false);
    expect(canUseShaderFalloffPreview({})).toBe(false);
  });
});
