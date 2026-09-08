/**
 * GPU falloff-preview parity (issue #315 T1 GPU-preview path).
 *
 * The proximity/falloff drag evaluates `v = f(D)` in the fragment/vertex stage
 * (glslUtils' GLSL_FALLOFF_PREVIEW) instead of re-uploading a 4 MB opacity
 * texture per tick. GLSL has no unit-test harness here, so we pin the shader's
 * exact arithmetic through its byte-for-byte JS mirror `evalFalloffPreviewParams`
 * against the authoritative CPU `falloffValue`: if the two ever drift, threshold
 * membership on screen would diverge from the committed field. The precompute
 * `computeFalloffPreviewParams` is the CPU→GPU bridge whose math is asserted here.
 */

import { describe, expect, it } from "@jest/globals";
import {
  FALLOFF_DIST_SENTINEL,
  FALLOFF_PREVIEW_SHAPE_CODE,
  computeFalloffPreviewParams,
  evalFalloffPreviewParams,
  falloffScale,
  falloffValue,
} from "./falloff";
import { computeFrozenChain, evaluateFrozenChain } from "./fieldPreviewCore";
import { GLSL_FALLOFF_PREVIEW, GLSL_FETCH_DIST } from "../gl/shaders/glslUtils";
import { nodeVertexShaderSource } from "../gl/shaders/node.vert";
import { nodeFragmentShaderSource } from "../gl/shaders/node.frag";
import { edgeFragmentShaderSource } from "../gl/shaders/edge.frag";

const M = 10; // maxEmbeddingDistance (projection diameter)
const SHAPES = ["exp", "linear", "gauss", "log", "plateau"] as const;
/** Slider samples: both endpoints plus a spread of the normal range. */
const PROX = [0, 0.1, 0.25, 0.5, 0.6, 0.75, 0.9, 0.99, 1];

describe("computeFalloffPreviewParams", () => {
  it("maps shapes to their GLSL switch codes", () => {
    expect(FALLOFF_PREVIEW_SHAPE_CODE).toEqual({
      exp: 0,
      linear: 1,
      gauss: 2,
      log: 3,
      plateau: 4,
    });
    for (const shape of SHAPES) {
      expect(computeFalloffPreviewParams(shape, 0.5, M).shapeCode).toBe(
        FALLOFF_PREVIEW_SHAPE_CODE[shape]
      );
    }
  });

  it("precomputes sScaled = s for exp/linear/gauss and s/5 (=r) for log/plateau", () => {
    const p = 0.7;
    const s = falloffScale(p); // 7/3
    for (const shape of ["exp", "linear", "gauss"] as const) {
      expect(computeFalloffPreviewParams(shape, p, M).sScaled).toBeCloseTo(s, 12);
    }
    for (const shape of ["log", "plateau"] as const) {
      expect(computeFalloffPreviewParams(shape, p, M).sScaled).toBeCloseTo(s / 5, 12);
    }
  });

  it("sets invMaxEmb = 1/M (0 when the diameter is degenerate)", () => {
    expect(computeFalloffPreviewParams("exp", 0.5, M).invMaxEmb).toBeCloseTo(1 / M, 12);
    expect(computeFalloffPreviewParams("exp", 0.5, 0).invMaxEmb).toBe(0);
  });

  it("routes the slider endpoints to OFF (mode 2) and FLOOD (mode 3)", () => {
    expect(computeFalloffPreviewParams("exp", 0, M).mode).toBe(2); // p<=0 -> off
    expect(computeFalloffPreviewParams("exp", -0.5, M).mode).toBe(2);
    expect(computeFalloffPreviewParams("exp", 0.5, M).mode).toBe(1); // normal
    expect(computeFalloffPreviewParams("exp", 1, M).mode).toBe(3); // p>=1 -> flood
    expect(computeFalloffPreviewParams("exp", 1.5, M).mode).toBe(3);
  });
});

describe("evalFalloffPreviewParams parity with falloffValue (the GLSL twin)", () => {
  // Finite sample distances across the whole reachable range plus D=0 (seed /
  // grid-coincident) and the unreachable sentinel (recordDist's +Infinity).
  const FINITE_DISTS = [0, 0.001, 0.5, 1, 2.5, 5, 7.5, 9.999, M, 1.5 * M];

  it("matches falloffValue for every shape, slider and sample distance", () => {
    for (const shape of SHAPES) {
      for (const p of PROX) {
        const params = computeFalloffPreviewParams(shape, p, M);
        for (const d of FINITE_DISTS) {
          expect(evalFalloffPreviewParams(params, d)).toBeCloseTo(
            falloffValue(d, shape, p, M),
            6
          );
        }
      }
    }
  });

  it("reads the unreachable sentinel as DoI 0 (matching falloffValue at Infinity)", () => {
    for (const shape of SHAPES) {
      for (const p of PROX) {
        const params = computeFalloffPreviewParams(shape, p, M);
        expect(evalFalloffPreviewParams(params, FALLOFF_DIST_SENTINEL)).toBe(0);
        expect(evalFalloffPreviewParams(params, Infinity)).toBe(0);
        expect(falloffValue(Infinity, shape, p, M)).toBe(0);
      }
    }
  });

  it("OFF endpoint (slider 0) is 0 everywhere including D=0; FLOOD (slider 1) is 1 for reachable", () => {
    for (const shape of SHAPES) {
      const off = computeFalloffPreviewParams(shape, 0, M);
      expect(evalFalloffPreviewParams(off, 0)).toBe(0);
      expect(evalFalloffPreviewParams(off, 3)).toBe(0);
      const flood = computeFalloffPreviewParams(shape, 1, M);
      expect(evalFalloffPreviewParams(flood, 0)).toBe(1);
      expect(evalFalloffPreviewParams(flood, M)).toBe(1);
      expect(evalFalloffPreviewParams(flood, FALLOFF_DIST_SENTINEL)).toBe(0);
    }
  });
});

/**
 * The shader SOURCE is the other half of the parity contract: the JS mirrors
 * above are only an oracle if the GLSL still spells the same composition. These
 * assertions pin the lines a future "optimization" could quietly change — each
 * of them is a shipped defect or its fix (issue #315, CS 2026-07-26).
 */
describe("GLSL text parity for the frozen-chain preview composition", () => {
  it("fetches all four frozen-chain channels from the preview texture", () => {
    expect(GLSL_FETCH_DIST).toContain("vec4 fetchFrozenChain(float idx)");
    expect(GLSL_FETCH_DIST).toContain("return texture(u_distFieldTex, uv);");
  });

  it("composes previewDoi as max(seedChain, f(D), gain * f(srcDist))", () => {
    // Channel order is the CPU→GPU contract: r = own D, g = source D, b = gain,
    // a = seed chain (see computeFrozenChain / setDistanceField's interleave).
    expect(GLSL_FALLOFF_PREVIEW).toContain(
      "float own = falloffPreview(fc.r, shape, sScaled, invMaxEmb, mode);"
    );
    expect(GLSL_FALLOFF_PREVIEW).toContain(
      "float chain = fc.b * falloffPreview(fc.g, shape, sScaled, invMaxEmb, mode);"
    );
    expect(GLSL_FALLOFF_PREVIEW).toContain("return max(fc.a, max(own, chain));");
  });

  it("keeps the OFF endpoint ahead of the D=0 shortcut (grid-coincidence rule)", () => {
    const sentinelAt = GLSL_FALLOFF_PREVIEW.indexOf("d >= DIST_SENTINEL * 0.5");
    const offAt = GLSL_FALLOFF_PREVIEW.indexOf("mode == 2");
    const zeroAt = GLSL_FALLOFF_PREVIEW.indexOf("d <= 0.0");
    expect(sentinelAt).toBeGreaterThanOrEqual(0);
    expect(offAt).toBeGreaterThan(sentinelAt);
    expect(zeroAt).toBeGreaterThan(offAt);
  });

  it("runs previewDoi (not the bare falloff) in the node and edge passes", () => {
    expect(nodeVertexShaderSource).toContain("vec4 fc = fetchFrozenChain(float(gl_VertexID));");
    expect(nodeVertexShaderSource).toContain("sp = previewDoi(fc,");
    expect(edgeFragmentShaderSource).toContain("previewDoi(fetchFrozenChain(v_lastIndex),");
    expect(edgeFragmentShaderSource).toContain("previewDoi(fetchFrozenChain(v_nextIndex),");
  });

  it("evaluateFrozenChain mirrors that composition channel for channel", () => {
    // The JS twin is the oracle for the GLSL above; if the channel order or the
    // max() nesting drifts, the on-screen drag stops matching the CPU preview.
    const recordDist = Float32Array.from([0, 2, 8, Infinity]);
    const frozen = computeFrozenChain({
      recordDist,
      predIndex: Int32Array.from([-1, 0, 1, 2]),
      succIndex: Int32Array.from([1, 2, 3, -1]),
      seedIdx: Int32Array.from([0]),
      shape: "log",
      prox: 0.6,
      past: 0.5,
      future: 0.5,
      maxEmb: M,
    });
    for (const p of PROX) {
      const params = computeFalloffPreviewParams("log", p, M);
      const out = evaluateFrozenChain(recordDist, frozen, params);
      for (let i = 0; i < out.length; i++) {
        const own = evalFalloffPreviewParams(params, recordDist[i]);
        const chain = frozen.gain[i] * evalFalloffPreviewParams(params, frozen.srcDist[i]);
        expect(out[i]).toBeCloseTo(Math.max(frozen.seedChain[i], Math.max(own, chain)), 7);
      }
    }
  });

  it("REPLACES the committed opacity while previewing (never max()es with it)", () => {
    // The regression this pins: max(committedField, preview) can only RAISE
    // values, so dragging the proximity slider DOWN previewed nothing until the
    // commit landed. The RELEASE CROSS-FADE (issue #315, CS 2026-07-26) turned the
    // replacement into a MIX toward the committed texture — a max() is still
    // forbidden, and the fade weight is 0 (pure preview) for the whole drag.
    expect(nodeFragmentShaderSource).toContain(
      "mix(v_spatialField, v_opacityField, u_falloffBlend)"
    );
    expect(nodeFragmentShaderSource).not.toContain("max(v_opacityField, v_spatialField)");
    expect(edgeFragmentShaderSource).not.toContain("max(opacityLast,");
    expect(edgeFragmentShaderSource).not.toContain("max(opacityNext,");
  });

  it("cross-fades the preview toward the committed texture with ONE uniform", () => {
    // Direction matters: mix(preview, committed, t) must go FROM the preview
    // (t = 0, the whole drag) TO the committed field (t = 1). Reversed, a commit
    // would fade the wrong way and the release step would be twice as large.
    expect(nodeFragmentShaderSource).toContain("uniform float u_falloffBlend;");
    expect(edgeFragmentShaderSource).toContain("uniform float u_falloffBlend;");
    expect(edgeFragmentShaderSource).toContain(
      "opacityLast = mix(previewDoi(fetchFrozenChain(v_lastIndex)"
    );
    expect(edgeFragmentShaderSource).toContain("u_falloffMode), opacityLast, u_falloffBlend);");
    expect(edgeFragmentShaderSource).toContain("u_falloffMode), opacityNext, u_falloffBlend);");
  });
});
