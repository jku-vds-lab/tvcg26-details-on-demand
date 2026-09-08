// packages/app/src/doiPropagation/falloffInverse.test.ts
//
// f⁻¹ contract for the converged alternation (convergedField.ts): a raised
// value v re-enters the falloff at distance f⁻¹(v), so f(f⁻¹(v)) must return
// v and the continuation f(f⁻¹(v) + d) must never exceed v (the offset
// CONTINUES the falloff, it does not restart it).

import { falloffInverse, falloffValue, FIELD_FALLOFF_SHAPES } from "./falloff";

const MAX_EMB = 3.7;
const PROX = [0.05, 0.1, 0.3, 0.5, 0.75, 0.9];
const VALUES = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999];

describe("falloffInverse", () => {
  for (const shape of FIELD_FALLOFF_SHAPES) {
    test(`${shape}: f(f⁻¹(v)) = v within 1e-9`, () => {
      for (const prox of PROX) {
        for (const v of VALUES) {
          const d = falloffInverse(v, shape, prox, MAX_EMB);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(isFinite(d)).toBe(true);
          const back = falloffValue(d, shape, prox, MAX_EMB);
          expect(Math.abs(back - v)).toBeLessThanOrEqual(1e-9);
        }
      }
    });

    test(`${shape}: continuation f(f⁻¹(v) + d) ≤ v (monotone offset)`, () => {
      for (const prox of PROX) {
        for (const v of VALUES) {
          const d0 = falloffInverse(v, shape, prox, MAX_EMB);
          for (const step of [0.01, 0.1, 1]) {
            const cont = falloffValue(d0 + step * MAX_EMB, shape, prox, MAX_EMB);
            expect(cont).toBeLessThanOrEqual(v + 1e-12);
          }
        }
      }
    });

    test(`${shape}: endpoint guards mirror the python closures`, () => {
      // Non-spatial (p ≤ 0) and flood (p ≥ 1) have no finite metric term.
      expect(falloffInverse(0.5, shape, 0, MAX_EMB)).toBe(0);
      expect(falloffInverse(0.5, shape, 1, MAX_EMB)).toBe(0);
      expect(falloffInverse(0.5, shape, 0.5, 0)).toBe(0);
      // v ≥ 1 enters at the seed itself.
      expect(falloffInverse(1, shape, 0.5, MAX_EMB)).toBe(0);
      expect(falloffInverse(1.5, shape, 0.5, MAX_EMB)).toBe(0);
    });
  }

  test("compact shapes: v ≤ 0 lands on the finite support distance", () => {
    // log/plateau support R = s·maxEmb/5; linear support s·maxEmb.
    const prox = 0.5; // s = 1
    expect(falloffInverse(0, "log", prox, MAX_EMB)).toBeCloseTo(MAX_EMB / 5, 12);
    expect(falloffInverse(0, "plateau", prox, MAX_EMB)).toBeCloseTo(MAX_EMB / 5, 12);
    expect(falloffInverse(0, "linear", prox, MAX_EMB)).toBeCloseTo(MAX_EMB, 12);
  });

  test("plateau: set-valued f⁻¹ takes the infimum (v=1 → 0, not the flat top)", () => {
    expect(falloffInverse(1, "plateau", 0.5, MAX_EMB)).toBe(0);
    // Just below 1 the inverse must stay near the seed (infimum of the
    // preimage), giving the one-sided over-coloring bias, never under.
    const d = falloffInverse(0.9999, "plateau", 0.5, MAX_EMB);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(falloffValue(d, "plateau", 0.5, MAX_EMB)).toBeGreaterThanOrEqual(0.9999 - 1e-9);
  });
});
