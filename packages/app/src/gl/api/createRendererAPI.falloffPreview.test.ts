/**
 * RendererAPI surface for the GPU falloff preview (issue #315 T1).
 *
 * The API must forward setDistanceField / setFalloffPreview straight to the
 * underlying WebGLRenderer — the drag path relies on both being callable so the
 * shader spatial term (and its distance texture) reach the GPU.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { createRendererAPI } from "./createRendererAPI";
import type { WebGLRenderer } from "../core/webglRenderer";
import type { FalloffPreviewParams } from "../../doiPropagation/falloff";

function makeMockRenderer(): WebGLRenderer {
  // Only the fields createRendererAPI touches at construction + the two new
  // setters need to exist; everything else is an unused stub.
  return {
    nodesList: [],
    currentVisualSettings: { colorPalette: [] },
    updateData: jest.fn(),
    setDistanceField: jest.fn(),
    setFalloffPreview: jest.fn(),
  } as unknown as WebGLRenderer;
}

describe("createRendererAPI falloff-preview surface", () => {
  it("exposes both methods", () => {
    const api = createRendererAPI(makeMockRenderer());
    expect(typeof api.setDistanceField).toBe("function");
    expect(typeof api.setFalloffPreview).toBe("function");
  });

  it("forwards setDistanceField to the renderer verbatim", () => {
    const renderer = makeMockRenderer();
    const api = createRendererAPI(renderer);
    const dist = Float32Array.from([0, 1.5, Infinity]);
    api.setDistanceField(dist);
    expect(renderer.setDistanceField).toHaveBeenCalledTimes(1);
    expect(renderer.setDistanceField).toHaveBeenCalledWith(dist, undefined);
  });

  it("forwards the frozen-chain layers alongside the distances", () => {
    const renderer = makeMockRenderer();
    const api = createRendererAPI(renderer);
    // Frozen chain (issue #315): the source distance / gain / seed-chain layers
    // must reach the renderer, or the shader previews the bare spatial term
    // without the trajectory cascade — and a downward drag reads wrong.
    const dist = Float32Array.from([0, 1.5, Infinity]);
    const frozen = {
      srcDist: Float32Array.from([0, 1.5, 1.5]),
      gain: Float32Array.from([1, 1, 0.5]),
      seedChain: Float32Array.from([1, 0.5, 0.25]),
    };
    api.setDistanceField(dist, frozen);
    expect(renderer.setDistanceField).toHaveBeenCalledWith(dist, frozen);
  });

  it("forwards setFalloffPreview params and null (off) to the renderer", () => {
    const renderer = makeMockRenderer();
    const api = createRendererAPI(renderer);
    const params: FalloffPreviewParams = { shapeCode: 3, sScaled: 0.4, invMaxEmb: 0.1, mode: 1 };
    api.setFalloffPreview(params);
    expect(renderer.setFalloffPreview).toHaveBeenCalledWith(params);
    api.setFalloffPreview(null);
    expect(renderer.setFalloffPreview).toHaveBeenLastCalledWith(null);
  });
});
