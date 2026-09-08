/**
 * Lazy trajectory-midpoints registry (issue #315 B2): the boot pipeline
 * registers a builder instead of building the ~one-object-per-edge array;
 * the first consumer materializes it through ensureTrajectoryMidpoints.
 * Pinned here: build-once memoization, concurrent dedupe, unregistered ⇒ [],
 * failure ⇒ [] with a later retry allowed, re-registration drops the memo.
 */

import type { TrajectoryMidpoint } from "./dataPreprocessing";
import {
  ensureTrajectoryMidpoints,
  registerTrajectoryMidpointsBuilder,
} from "./lazyTrajectoryMidpoints";

const mid = (id: number): TrajectoryMidpoint =>
  ({ id, midPoint: { x: id, y: id }, DoI: 1 } as unknown as TrajectoryMidpoint);

afterEach(() => registerTrajectoryMidpointsBuilder(null));

describe("ensureTrajectoryMidpoints", () => {
  it("returns [] when no builder is registered", async () => {
    await expect(ensureTrajectoryMidpoints()).resolves.toEqual([]);
  });

  it("builds exactly once and memoizes the result", async () => {
    const built = [mid(1), mid(2)];
    const builder = jest.fn(async () => built);
    registerTrajectoryMidpointsBuilder(builder);

    await expect(ensureTrajectoryMidpoints()).resolves.toBe(built);
    await expect(ensureTrajectoryMidpoints()).resolves.toBe(built);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls into one build", async () => {
    let release!: (m: TrajectoryMidpoint[]) => void;
    const builder = jest.fn(() => new Promise<TrajectoryMidpoint[]>((r) => { release = r; }));
    registerTrajectoryMidpointsBuilder(builder);

    const a = ensureTrajectoryMidpoints();
    const b = ensureTrajectoryMidpoints();
    release([mid(7)]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(builder).toHaveBeenCalledTimes(1);
  });

  it("resolves [] on builder failure and allows a retry", async () => {
    const builder = jest
      .fn<Promise<TrajectoryMidpoint[]>, []>()
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
      .mockResolvedValueOnce([mid(3)]);
    registerTrajectoryMidpointsBuilder(builder);

    await expect(ensureTrajectoryMidpoints()).resolves.toEqual([]);
    await expect(ensureTrajectoryMidpoints()).resolves.toEqual([mid(3)]);
    expect(builder).toHaveBeenCalledTimes(2);
  });

  it("re-registration drops the previous memo", async () => {
    registerTrajectoryMidpointsBuilder(async () => [mid(1)]);
    await expect(ensureTrajectoryMidpoints()).resolves.toEqual([mid(1)]);

    registerTrajectoryMidpointsBuilder(async () => [mid(2)]);
    await expect(ensureTrajectoryMidpoints()).resolves.toEqual([mid(2)]);
  });
});
