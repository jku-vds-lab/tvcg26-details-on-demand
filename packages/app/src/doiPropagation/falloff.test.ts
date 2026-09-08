/**
 * Falloff family for field-engine DoI (issue #315 A3 field-first v2,
 * CS slider spec 2026-07-24): slider 0 = spatial propagation off, slider
 * 1 = 100% DoI at the furthest reachable point, shapes govern only the
 * in-between profile via the scale s(p) = p/(1−p). These formulas must
 * mirror doi_field.py's falloff family exactly.
 */

import { describe, expect, it } from "@jest/globals";
import { evalFalloffField, falloffScale, falloffValue } from "./falloff";

const M = 10; // maxEmbeddingDistance (the projection diameter)
const SHAPES = ["exp", "linear", "gauss", "log", "plateau"] as const;

describe("falloffScale", () => {
  it("is p/(1-p) with off/no-falloff clamps", () => {
    expect(falloffScale(0.5)).toBeCloseTo(1, 12);
    expect(falloffScale(0.8)).toBeCloseTo(4, 12);
    expect(falloffScale(0)).toBe(0);
    expect(falloffScale(-1)).toBe(0);
    expect(falloffScale(1)).toBe(Infinity);
    expect(falloffScale(1.5)).toBe(Infinity);
  });
});

describe("falloffValue endpoints (CS slider spec)", () => {
  it("slider 1: every reachable point gets 100% DoI, for every shape", () => {
    for (const shape of SHAPES) {
      expect(falloffValue(M, shape, 1, M)).toBe(1); // the furthest point
      expect(falloffValue(0.1, shape, 1, M)).toBe(1);
      expect(falloffValue(Infinity, shape, 1, M)).toBe(0); // void-separated stays 0
    }
  });

  it("slider 0: spatial propagation fully off — even at D=0 (grid-coincident points)", () => {
    for (const shape of SHAPES) {
      expect(falloffValue(0.001, shape, 0, M)).toBe(0);
      // D=0 means same grid cell, NOT seedhood — the caller clamps seeds.
      expect(falloffValue(0, shape, 0, M)).toBe(0);
    }
  });

  it("is monotone in the slider at fixed distance", () => {
    for (const shape of SHAPES) {
      let prev = -1;
      for (const p of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
        const v = falloffValue(M / 2, shape, p, M);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });
});

describe("falloffValue shape profiles (s = p/(1−p))", () => {
  it("exp: exp(−u/s)", () => {
    const p = 0.6, s = 0.6 / 0.4, d = 3;
    expect(falloffValue(d, "exp", p, M)).toBeCloseTo(Math.exp(-(d / M) / s), 12);
  });

  it("linear: 1 − u/s with a hard edge; p=0.5 spans exactly the projection", () => {
    expect(falloffValue(4, "linear", 0.5, M)).toBeCloseTo(1 - 4 / M, 12);
    expect(falloffValue(M, "linear", 0.5, M)).toBe(0); // far point at exactly 0
    const s = 0.8 / 0.2; // p=0.8 -> s=4: edge at u=4, beyond the projection
    expect(falloffValue(M, "linear", 0.8, M)).toBeCloseTo(1 - 1 / s, 12);
  });

  it("gauss: exp(−(u/s)²)", () => {
    const p = 0.8, s = 4, d = 4;
    expect(falloffValue(d, "gauss", p, M)).toBeCloseTo(Math.exp(-((d / M / s) ** 2)), 12);
  });
});

describe("compact-support shapes (log, plateau): CS 2026-07-24", () => {
  // r = s/5 (diameter units); v = f(u/r), 0 past the bounded radius R = r·M.
  const p = 0.7;
  const s = p / (1 - p); // 7/3
  const r = s / 5;
  const R = r * M; // radius in distance units

  it("log: v = log2(2 − u/r); spot at u = r/2 is log2(1.5), 0 past R", () => {
    expect(falloffValue(0, "log", p, M)).toBe(1); // full interest at the selection
    expect(falloffValue(R / 2, "log", p, M)).toBeCloseTo(Math.log2(1.5), 12);
    expect(falloffValue(R * 0.999, "log", p, M)).toBeLessThan(0.01); // ~0 at R
    expect(falloffValue(R * 1.5, "log", p, M)).toBe(0); // strictly 0 beyond R
    expect(falloffValue(Infinity, "log", p, M)).toBe(0);
  });

  it("plateau: smoothstep t²(3−2t); spot at u = r/2 is 0.5, plateau near 0", () => {
    expect(falloffValue(0, "plateau", p, M)).toBe(1);
    expect(falloffValue(R / 2, "plateau", p, M)).toBeCloseTo(0.5, 12);
    expect(falloffValue(R * 0.1, "plateau", p, M)).toBeGreaterThan(0.97); // flat top
    expect(falloffValue(R * 0.999, "plateau", p, M)).toBeLessThan(0.01);
    expect(falloffValue(R * 1.5, "plateau", p, M)).toBe(0);
    expect(falloffValue(Infinity, "plateau", p, M)).toBe(0);
  });

  it("monotone decreasing in distance for both", () => {
    for (const shape of ["log", "plateau"] as const) {
      let prev = Infinity;
      for (let d = 0; d <= 1.2 * R; d += R / 40) {
        const v = falloffValue(d, shape, p, M);
        expect(v).toBeLessThanOrEqual(prev + 1e-12);
        prev = v;
      }
    }
  });

  it("corners only near the top: at p = 0.5 (r = 0.2) the far half is exactly 0", () => {
    // r = 0.2 ⇒ radius at D = 2; the whole far half (D ∈ [5, 10]) is 0.
    for (const shape of ["log", "plateau"] as const) {
      for (const d of [5, 6, 7, 8, 9, 10]) {
        expect(falloffValue(d, shape, 0.5, M)).toBe(0);
      }
      expect(falloffValue(1, shape, 0.5, M)).toBeGreaterThan(0); // near selection lit
    }
  });
});

describe("evalFalloffField", () => {
  const dist = Float32Array.from([0, 1, 5, Infinity]);

  it("matches the scalar function element-wise for every shape and slider", () => {
    for (const shape of SHAPES) {
      for (const p of [0, 0.3, 0.7, 1]) {
        const v = evalFalloffField(dist, shape, p, M);
        for (let i = 0; i < dist.length; i++) {
          expect(v[i]).toBeCloseTo(falloffValue(dist[i], shape, p, M), 6);
        }
      }
    }
  });

  it("reuses a matching scratch buffer, allocates otherwise", () => {
    const scratch = new Float32Array(dist.length);
    expect(evalFalloffField(dist, "exp", 0.7, M, scratch)).toBe(scratch);
    expect(evalFalloffField(dist, "exp", 0.7, M, new Float32Array(2))).not.toHaveLength(2);
  });
});
