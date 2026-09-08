import {
  computeClusterAverageIdle,
  computeImageDiffIdle,
  renderImageDiffToRgba,
} from "./imageDiffShared";

// Palette extremes (from imageDiffShared.ts)
const NEG = { r: 0x67, g: 0xa9, b: 0xcf }; // diff = -1
const MID = { r: 0xf7, g: 0xf7, b: 0xf7 }; // diff =  0
const POS = { r: 0xef, g: 0x8a, b: 0x62 }; // diff = +1

describe("renderImageDiffToRgba", () => {
  it("returns mid-palette (near-white) for equal inputs", () => {
    const n     = 4;
    const start = new Float32Array(n).fill(0.5);
    const end   = new Float32Array(n).fill(0.5);
    const rgba  = renderImageDiffToRgba(start, end);
    for (let i = 0; i < n; i++) {
      expect(rgba[i * 4]).toBe(MID.r);
      expect(rgba[i * 4 + 1]).toBe(MID.g);
      expect(rgba[i * 4 + 2]).toBe(MID.b);
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it("returns the positive (orange) extreme when diff = +1", () => {
    const rgba = renderImageDiffToRgba(new Float32Array([0]), new Float32Array([1]));
    expect(rgba[0]).toBe(POS.r);
    expect(rgba[1]).toBe(POS.g);
    expect(rgba[2]).toBe(POS.b);
    expect(rgba[3]).toBe(255);
  });

  it("returns the negative (blue) extreme when diff = -1", () => {
    const rgba = renderImageDiffToRgba(new Float32Array([1]), new Float32Array([0]));
    expect(rgba[0]).toBe(NEG.r);
    expect(rgba[1]).toBe(NEG.g);
    expect(rgba[2]).toBe(NEG.b);
    expect(rgba[3]).toBe(255);
  });

  it("clamps differences > +1 to the positive extreme", () => {
    const unclamped = renderImageDiffToRgba(new Float32Array([0]), new Float32Array([5]));
    const clamped   = renderImageDiffToRgba(new Float32Array([0]), new Float32Array([1]));
    expect(unclamped[0]).toBe(clamped[0]);
    expect(unclamped[1]).toBe(clamped[1]);
    expect(unclamped[2]).toBe(clamped[2]);
  });

  it("clamps differences < -1 to the negative extreme", () => {
    const unclamped = renderImageDiffToRgba(new Float32Array([5]), new Float32Array([0]));
    const clamped   = renderImageDiffToRgba(new Float32Array([1]), new Float32Array([0]));
    expect(unclamped[0]).toBe(clamped[0]);
    expect(unclamped[1]).toBe(clamped[1]);
    expect(unclamped[2]).toBe(clamped[2]);
  });

  it("returns an RGBA buffer of length numPixels × 4", () => {
    const n    = 10;
    const rgba = renderImageDiffToRgba(new Float32Array(n), new Float32Array(n));
    expect(rgba.length).toBe(n * 4);
  });
});

// Simple identity accessor — each "sample" is already a Float32Array of pixels.
const identity = (s: Float32Array) => s;

describe("computeImageDiffIdle", () => {
  it("returns mid-palette for equal start and end clusters", async () => {
    const n = 4;
    const px = new Float32Array(n).fill(0.5);
    const rgba = await computeImageDiffIdle([px], [px], n, identity, () => false);
    for (let i = 0; i < n; i++) {
      expect(rgba[i * 4]).toBe(MID.r);
      expect(rgba[i * 4 + 1]).toBe(MID.g);
      expect(rgba[i * 4 + 2]).toBe(MID.b);
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it("returns the positive (orange) extreme for start=0, end=1", async () => {
    const rgba = await computeImageDiffIdle(
      [new Float32Array([0])],
      [new Float32Array([1])],
      1,
      identity,
      () => false,
    );
    expect(rgba[0]).toBe(POS.r);
    expect(rgba[1]).toBe(POS.g);
    expect(rgba[2]).toBe(POS.b);
    expect(rgba[3]).toBe(255);
  });

  it("returns the negative (blue) extreme for start=1, end=0", async () => {
    const rgba = await computeImageDiffIdle(
      [new Float32Array([1])],
      [new Float32Array([0])],
      1,
      identity,
      () => false,
    );
    expect(rgba[0]).toBe(NEG.r);
    expect(rgba[1]).toBe(NEG.g);
    expect(rgba[2]).toBe(NEG.b);
  });

  it("clamps differences beyond ±1 to the palette extremes", async () => {
    const unclamped = await computeImageDiffIdle(
      [new Float32Array([0])],
      [new Float32Array([5])],
      1,
      identity,
      () => false,
    );
    expect(unclamped[0]).toBe(POS.r);
    expect(unclamped[1]).toBe(POS.g);
    expect(unclamped[2]).toBe(POS.b);
  });

  it("returns an empty buffer when both sample arrays are empty", async () => {
    const rgba = await computeImageDiffIdle([], [], 4, identity, () => false);
    expect(rgba.length).toBe(0);
  });

  it("returns an empty buffer immediately when isCancelled is true on entry", async () => {
    const px = new Float32Array([0.5]);
    const rgba = await computeImageDiffIdle([px], [px], 1, identity, () => true);
    expect(rgba.length).toBe(0);
  });

  it("averages multiple samples correctly", async () => {
    // start cluster: 0.0 and 1.0 → avg = 0.5; end: 1.0 → avg = 1.0; diff = 0.5 (pos side)
    const rgba = await computeImageDiffIdle(
      [new Float32Array([0.0]), new Float32Array([1.0])],
      [new Float32Array([1.0])],
      1,
      identity,
      () => false,
    );
    // diff = 1.0 - 0.5 = 0.5 → positive side; red interpolates MID.r(247)→POS.r(239)
    // At t=0.5: 247 + 0.5*(239-247) = 243, which is between POS.r and MID.r.
    expect(rgba[0]).toBeGreaterThan(POS.r - 1); // > 238
    expect(rgba[0]).toBeLessThan(MID.r + 1);    // < 248
    expect(rgba[3]).toBe(255);
  });
});

describe("computeClusterAverageIdle", () => {
  /** Reference implementation matching the previously-synchronous inset averaging. */
  function averageSync(samples: Float32Array[], numPixels: number) {
    const n = samples.length || 1;
    const acc = new Float32Array(numPixels);
    for (const px of samples) for (let i = 0; i < numPixels; i++) acc[i] += px[i];
    let maxAvg = 0;
    for (let i = 0; i < numPixels; i++) {
      // Track maxAvg from the f64 quotient (matches the original inset code),
      // not the f32-truncated stored value.
      const v = acc[i] / n;
      acc[i] = v;
      if (v > maxAvg) maxAvg = v;
    }
    return { avg: acc, maxAvg };
  }

  it("matches the synchronous average across chunk boundaries", async () => {
    const numPixels = 16;
    // 70 samples with chunkSize 32 → 3 chunks, exercises the slicing loop.
    const samples = Array.from({ length: 70 }, (_, s) =>
      Float32Array.from({ length: numPixels }, (_, p) => ((s * 31 + p * 7) % 256))
    );
    const expected = averageSync(samples, numPixels);
    const result = await computeClusterAverageIdle(samples, numPixels, identity, () => false);
    expect(result).not.toBeNull();
    expect(Array.from(result!.avg)).toEqual(Array.from(expected.avg));
    expect(result!.maxAvg).toBe(expected.maxAvg);
  });

  it("resolves null for empty samples", async () => {
    expect(await computeClusterAverageIdle([], 4, identity, () => false)).toBeNull();
  });

  it("resolves null when cancelled on entry", async () => {
    const px = new Float32Array([1, 2]);
    expect(await computeClusterAverageIdle([px], 2, identity, () => true)).toBeNull();
  });
});
