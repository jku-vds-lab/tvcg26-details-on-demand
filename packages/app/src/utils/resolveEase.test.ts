import { resolveEase } from "./resolveEase";

describe("resolveEase", () => {
  it("passes through names whose CSS keyword is mathematically exact", () => {
    expect(resolveEase("linear")).toBe("linear");
    expect(resolveEase("easeIn")).toBe("easeIn");
    expect(resolveEase("easeOut")).toBe("easeOut");
    expect(resolveEase("easeInOut")).toBe("easeInOut");
  });

  it("resolves circOut to the true math function, not the WAAPI bezier stand-in", () => {
    const fn = resolveEase("circOut");
    expect(typeof fn).toBe("function");
    const circOut = fn as (t: number) => number;
    expect(circOut(0)).toBeCloseTo(0, 10);
    expect(circOut(1)).toBeCloseTo(1, 10);
    // sqrt(0.5 * (2 - 0.5)) = sqrt(0.75) ≈ 0.866 — the WAAPI cubic-bezier
    // substitute for "circOut" yields ~0.15 here, so this pins the true curve.
    expect(circOut(0.5)).toBeCloseTo(Math.sqrt(0.75), 5);
  });

  it("resolves other WAAPI-approximated names to functions", () => {
    for (const name of ["circIn", "circInOut", "backIn", "backOut", "backInOut", "anticipate"]) {
      const fn = resolveEase(name);
      expect(typeof fn).toBe("function");
      const ease = fn as (t: number) => number;
      // anticipate ends at ~0.9995 (its expo tail never reaches exactly 1),
      // so endpoint checks use a loose precision.
      expect(ease(0)).toBeCloseTo(0, 3);
      expect(ease(1)).toBeCloseTo(1, 2);
    }
  });
});
