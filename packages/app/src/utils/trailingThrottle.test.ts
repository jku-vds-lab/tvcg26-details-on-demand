import { createTrailingThrottle } from "./trailingThrottle";

describe("createTrailingThrottle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("applies only the latest value once per window (no leading call)", () => {
    const applied: number[] = [];
    const t = createTrailingThrottle<number>((v) => applied.push(v), 150);

    t.push(1);
    t.push(2);
    t.push(3);
    expect(applied).toEqual([]); // no leading edge

    jest.advanceTimersByTime(150);
    expect(applied).toEqual([3]);
  });

  it("fires roughly once per window during sustained pushes", () => {
    const applied: number[] = [];
    const t = createTrailingThrottle<number>((v) => applied.push(v), 100);

    for (let i = 0; i < 10; i++) {
      t.push(i);
      jest.advanceTimersByTime(50); // pushes every 50ms for 500ms
    }
    // windows fire at t=100,200,300,400,500 → 5 applications
    expect(applied.length).toBe(5);
    expect(applied[applied.length - 1]).toBe(9);
  });

  it("flush applies the pending value immediately", () => {
    const applied: number[] = [];
    const t = createTrailingThrottle<number>((v) => applied.push(v), 150);

    t.push(7);
    t.flush();
    expect(applied).toEqual([7]);

    // no double-fire when the old timer would have elapsed
    jest.advanceTimersByTime(300);
    expect(applied).toEqual([7]);
  });

  it("flush without a pending value is a no-op", () => {
    const applied: number[] = [];
    const t = createTrailingThrottle<number>((v) => applied.push(v), 150);
    t.flush();
    expect(applied).toEqual([]);
  });

  it("cancel drops the pending value", () => {
    const applied: number[] = [];
    const t = createTrailingThrottle<number>((v) => applied.push(v), 150);
    t.push(1);
    t.cancel();
    jest.advanceTimersByTime(300);
    expect(applied).toEqual([]);
  });
});
