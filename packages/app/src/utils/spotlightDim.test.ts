import { SPOTLIGHT_DIM, relationSpotlightOpacity, spotlightOpacity } from "./spotlightDim";

describe("spotlightOpacity", () => {
  it("returns 1 when spotlightUids is null (no active spotlight)", () => {
    expect(spotlightOpacity("cluster-a", null)).toBe(1);
  });

  it("returns 1 when the uid is in the spotlight set", () => {
    const spot = new Set(["cluster-a", "cluster-b"]);
    expect(spotlightOpacity("cluster-a", spot)).toBe(1);
    expect(spotlightOpacity("cluster-b", spot)).toBe(1);
  });

  it("returns SPOTLIGHT_DIM when the uid is not in the spotlight set", () => {
    const spot = new Set(["cluster-a", "cluster-b"]);
    expect(spotlightOpacity("cluster-c", spot)).toBe(SPOTLIGHT_DIM);
    expect(spotlightOpacity("unrelated", spot)).toBe(SPOTLIGHT_DIM);
  });
});

describe("relationSpotlightOpacity", () => {
  it("returns 1 when spotlightUids is null (no active spotlight)", () => {
    expect(relationSpotlightOpacity("uid-a", "uid-b", null)).toBe(1);
  });

  it("returns 1 when both endpoints are in the spotlight set", () => {
    const spot = new Set(["uid-a", "uid-b"]);
    expect(relationSpotlightOpacity("uid-a", "uid-b", spot)).toBe(1);
  });

  it("returns SPOTLIGHT_DIM when only uidA is in the spotlight set", () => {
    const spot = new Set(["uid-a", "uid-c"]);
    expect(relationSpotlightOpacity("uid-a", "uid-b", spot)).toBe(SPOTLIGHT_DIM);
  });

  it("returns SPOTLIGHT_DIM when only uidB is in the spotlight set", () => {
    const spot = new Set(["uid-c", "uid-b"]);
    expect(relationSpotlightOpacity("uid-a", "uid-b", spot)).toBe(SPOTLIGHT_DIM);
  });

  it("returns SPOTLIGHT_DIM when neither endpoint is in the spotlight set", () => {
    const spot = new Set(["uid-x", "uid-y"]);
    expect(relationSpotlightOpacity("uid-a", "uid-b", spot)).toBe(SPOTLIGHT_DIM);
  });
});
