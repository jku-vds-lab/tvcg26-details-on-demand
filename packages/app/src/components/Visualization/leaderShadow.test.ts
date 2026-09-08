import { computeLeaderShadowFilter } from "./leaderShadow";

describe("computeLeaderShadowFilter", () => {
  it("returns undefined when disabled", () => {
    expect(computeLeaderShadowFilter(false, 6, 1)).toBeUndefined();
  });

  it("returns undefined when intensity is 0", () => {
    expect(computeLeaderShadowFilter(true, 0, 1)).toBeUndefined();
  });

  it("returns undefined when intensity is negative", () => {
    expect(computeLeaderShadowFilter(true, -1, 1)).toBeUndefined();
  });

  it("returns a well-formed drop-shadow string when enabled", () => {
    expect(computeLeaderShadowFilter(true, 6, 1)).toBe(
      "drop-shadow(0px 3px 6px rgba(0,0,0,0.45))"
    );
  });

  it("scales blur and offset by cssScale", () => {
    expect(computeLeaderShadowFilter(true, 6, 0.5)).toBe(
      "drop-shadow(0px 1.5px 3px rgba(0,0,0,0.45))"
    );
  });

  it("offset is exactly half of the scaled blur", () => {
    expect(computeLeaderShadowFilter(true, 10, 1)).toBe(
      "drop-shadow(0px 5px 10px rgba(0,0,0,0.45))"
    );
  });
});
