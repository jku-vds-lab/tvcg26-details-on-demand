import { describe, expect, it } from "@jest/globals";
import { diffRgbaFromImages, diffRgbaFromPresence, luminanceFromRgba } from "./gymDiff";

function rgbaPixel(r: number, g: number, b: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, 255]);
}

describe("gymDiff", () => {
  it("computes Rec. 601 luminance normalized to [0, 1]", () => {
    expect(luminanceFromRgba(rgbaPixel(255, 255, 255))[0]).toBeCloseTo(1, 5);
    expect(luminanceFromRgba(rgbaPixel(0, 0, 0))[0]).toBeCloseTo(0, 5);
    // Pure green: 0.587
    expect(luminanceFromRgba(rgbaPixel(0, 255, 0))[0]).toBeCloseTo(0.587, 3);
  });

  it("maps equal images to the near-white palette midpoint", () => {
    const img = rgbaPixel(120, 40, 200);
    const diff = diffRgbaFromImages(img, img);
    // Palette midpoint is #f7f7f7 (see imageDiffShared DIFF_PALETTE).
    expect([diff[0], diff[1], diff[2], diff[3]]).toEqual([0xf7, 0xf7, 0xf7, 255]);
  });

  it("colors brighter-at-end orange and darker-at-end blue", () => {
    const dark = rgbaPixel(0, 0, 0);
    const bright = rgbaPixel(255, 255, 255);

    const brighter = diffRgbaFromImages(dark, bright); // end − start = +1 → orange #ef8a62
    expect([brighter[0], brighter[1], brighter[2]]).toEqual([0xef, 0x8a, 0x62]);

    const darker = diffRgbaFromImages(bright, dark); // end − start = −1 → blue #67a9cf
    expect([darker[0], darker[1], darker[2]]).toEqual([0x67, 0xa9, 0xcf]);
  });

  it("contrast-normalizes so the strongest difference saturates the palette", () => {
    // Mean-image diffs are small (here ~0.31 luminance); the largest
    // difference must still hit the full palette end.
    const start = new Uint8ClampedArray([200, 200, 200, 255, 200, 200, 200, 255]);
    const end = new Uint8ClampedArray([120, 120, 120, 255, 160, 160, 160, 255]);
    const diff = diffRgbaFromImages(start, end);
    expect([diff[0], diff[1], diff[2]]).toEqual([0x67, 0xa9, 0xcf]); // max diff → full blue
    // The half-as-strong pixel lands mid-way, not at the end.
    expect(diff[6]).toBeGreaterThan(diff[2]); // less blue than the max pixel
    expect([diff[4], diff[5], diff[6]]).not.toEqual([0xf7, 0xf7, 0xf7]);
  });

  it("does not amplify sub-noise-floor differences (AA wobble stays near-white)", () => {
    const start = new Uint8ClampedArray([200, 200, 200, 255]);
    const end = new Uint8ClampedArray([196, 196, 196, 255]); // ~0.016 luminance delta
    const diff = diffRgbaFromImages(start, end);
    // Near the #f7f7f7 midpoint, far from saturated.
    expect(Math.abs(diff[0] - 0xf7)).toBeLessThan(8);
    expect(Math.abs(diff[2] - 0xf7)).toBeLessThan(8);
  });

  describe("white-background (classic control) occupancy mode", () => {
    const W = 4;
    // 4x4 all-white image; inner pixels are 5, 6, 9, 10 (border ring stays white).
    function whiteImage(overrides: Record<number, number> = {}): Uint8ClampedArray {
      const rgba = new Uint8ClampedArray(W * W * 4).fill(255);
      for (const [index, value] of Object.entries(overrides)) {
        const o = Number(index) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = value;
      }
      return rgba;
    }

    it("content appearing at the end side saturates to full orange", () => {
      const diff = diffRgbaFromImages(whiteImage(), whiteImage({ 5: 60 }), W);
      const o = 5 * 4;
      expect([diff[o], diff[o + 1], diff[o + 2]]).toEqual([0xef, 0x8a, 0x62]);
      // Background pixels stay at the midpoint.
      expect([diff[0], diff[1], diff[2]]).toEqual([0xf7, 0xf7, 0xf7]);
    });

    it("content disappearing maps to full blue", () => {
      const diff = diffRgbaFromImages(whiteImage({ 5: 60 }), whiteImage(), W);
      const o = 5 * 4;
      expect([diff[o], diff[o + 1], diff[o + 2]]).toEqual([0x67, 0xa9, 0xcf]);
    });

    it("boosts low-occupancy regions to clearly visible (but not full) orange", () => {
      // Pixel 6 is covered by ~25% of the end cluster's members
      // (mean = 0.25·60 + 0.75·255 ≈ 206); pixel 5 is always covered.
      const diff = diffRgbaFromImages(whiteImage(), whiteImage({ 5: 60, 6: 206 }), W);
      const o = 6 * 4;
      expect(diff[o]).toBeGreaterThan(diff[o + 2] + 30); // clearly orange
      expect(diff[o + 2]).toBeGreaterThan(0x62); // but not fully saturated
    });
  });

  describe("presence-map diffs (server agg='presence')", () => {
    function presencePx(value: number): Uint8ClampedArray {
      return new Uint8ClampedArray([value, value, value, 255]);
    }

    it("full occupancy appearing at the end side is full orange", () => {
      const diff = diffRgbaFromPresence(presencePx(0), presencePx(255));
      expect([diff[0], diff[1], diff[2]]).toEqual([0xef, 0x8a, 0x62]);
    });

    it("full occupancy disappearing is full blue", () => {
      const diff = diffRgbaFromPresence(presencePx(255), presencePx(0));
      expect([diff[0], diff[1], diff[2]]).toEqual([0x67, 0xa9, 0xcf]);
    });

    it("identical presence stays at the midpoint", () => {
      const diff = diffRgbaFromPresence(presencePx(128), presencePx(128));
      expect([diff[0], diff[1], diff[2]]).toEqual([0xf7, 0xf7, 0xf7]);
    });

    it("sqrt-boosts partial occupancy against an always-covered anchor", () => {
      // Pixel 0: occupancy 0 → 25% (sqrt-boosted to 0.5); pixel 1 anchors the
      // final normalization at 1 (0 → full).
      const start = new Uint8ClampedArray(8).fill(255);
      start.set([0, 0, 0, 255, 0, 0, 0, 255]);
      const end = new Uint8ClampedArray([64, 64, 64, 255, 255, 255, 255, 255]);
      const diff = diffRgbaFromPresence(start, end);
      expect(diff[0]).toBeGreaterThan(diff[2] + 30); // clearly orange
      expect(diff[2]).toBeGreaterThan(0x62); // but not fully saturated
    });
  });

  it("diffs per pixel independently", () => {
    const start = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    const end = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]);
    const diff = diffRgbaFromImages(start, end);
    expect([diff[0], diff[1], diff[2]]).toEqual([0xef, 0x8a, 0x62]); // changed → orange
    expect([diff[4], diff[5], diff[6]]).toEqual([0xf7, 0xf7, 0xf7]); // unchanged → mid
  });
});
