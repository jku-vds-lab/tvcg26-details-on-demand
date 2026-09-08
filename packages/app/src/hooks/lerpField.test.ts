import { lerpField } from "./lerpField";

describe("lerpField", () => {
  it("returns `from` when t=0", () => {
    const from = new Float32Array([1, 2, 3]);
    const to = new Float32Array([4, 5, 6]);
    const result = lerpField(from, to, 0);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it("returns `to` when t=1", () => {
    const from = new Float32Array([1, 2, 3]);
    const to = new Float32Array([4, 5, 6]);
    const result = lerpField(from, to, 1);
    expect(Array.from(result)).toEqual([4, 5, 6]);
  });

  it("interpolates correctly at t=0.5", () => {
    const from = new Float32Array([0, 0, 0]);
    const to = new Float32Array([2, 4, 6]);
    const result = lerpField(from, to, 0.5);
    expect(result[0]).toBeCloseTo(1);
    expect(result[1]).toBeCloseTo(2);
    expect(result[2]).toBeCloseTo(3);
  });

  it("clamps t below 0 to 0", () => {
    const from = new Float32Array([10]);
    const to = new Float32Array([20]);
    const result = lerpField(from, to, -1);
    expect(result[0]).toBeCloseTo(10);
  });

  it("clamps t above 1 to 1", () => {
    const from = new Float32Array([10]);
    const to = new Float32Array([20]);
    const result = lerpField(from, to, 2);
    expect(result[0]).toBeCloseTo(20);
  });

  it("returns a Float32Array of the same length as `from`", () => {
    const from = new Float32Array(5);
    const to = new Float32Array(5);
    const result = lerpField(from, to, 0.5);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(5);
  });

  it("does not mutate from or to", () => {
    const from = new Float32Array([1, 2]);
    const to = new Float32Array([3, 4]);
    lerpField(from, to, 0.5);
    expect(Array.from(from)).toEqual([1, 2]);
    expect(Array.from(to)).toEqual([3, 4]);
  });
});
