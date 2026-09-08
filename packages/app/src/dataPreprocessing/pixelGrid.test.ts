import {
  MIN_PIXEL_GRID_KEYS,
  PIXEL_GRID_KEY_RE,
  attachPixelViews,
  detectPixelGrid,
  extractPixelGrid,
  getTypedGridPixels,
} from "./pixelGrid";

/** Build a point carrying a full width*height grid, key "axb" = a*1000 + b. */
function makeGridPoint(
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
  value: (a: number, b: number) => unknown = (a, b) => a * 1000 + b
): Record<string, unknown> {
  const p: Record<string, unknown> = { ...extra };
  for (let b = 1; b <= height; b++) {
    for (let a = 1; a <= width; a++) {
      p[`${a}x${b}`] = value(a, b);
    }
  }
  return p;
}

describe("PIXEL_GRID_KEY_RE", () => {
  it("matches pixel keys and rejects feature-like keys", () => {
    expect(PIXEL_GRID_KEY_RE.test("1x1")).toBe(true);
    expect(PIXEL_GRID_KEY_RE.test("128x72")).toBe(true);
    expect(PIXEL_GRID_KEY_RE.test("x1")).toBe(false);
    expect(PIXEL_GRID_KEY_RE.test("1x")).toBe(false);
    expect(PIXEL_GRID_KEY_RE.test("age")).toBe(false);
    expect(PIXEL_GRID_KEY_RE.test("2x4wood")).toBe(false);
  });
});

describe("detectPixelGrid", () => {
  it("detects a complete grid at the minimum key count", () => {
    // 8x8 = 64 = MIN_PIXEL_GRID_KEYS
    expect(64).toBe(MIN_PIXEL_GRID_KEYS);
    const p = makeGridPoint(8, 8, { id: 1, label: "a" });
    expect(detectPixelGrid(p)).toEqual({ width: 8, height: 8 });
  });

  it("rejects grids below the minimum key count", () => {
    const p = makeGridPoint(7, 9); // 63 keys
    expect(detectPixelGrid(p)).toBeNull();
  });

  it("rejects incomplete grids (missing keys)", () => {
    const p = makeGridPoint(10, 10);
    delete p["5x5"];
    expect(detectPixelGrid(p)).toBeNull();
  });

  it("rejects non-objects and points without pixel keys", () => {
    expect(detectPixelGrid(null)).toBeNull();
    expect(detectPixelGrid([1, 2, 3])).toBeNull();
    expect(detectPixelGrid({ id: 1, x: 2, y: 3 })).toBeNull();
  });
});

describe("extractPixelGrid", () => {
  it("stores key 'axb' at canonical index (b-1)*width + (a-1)", () => {
    const p = makeGridPoint(16, 4, { id: 7 }, (a, b) => (a + b) % 256);
    const ex = extractPixelGrid([p]);
    expect(ex).not.toBeNull();
    expect(ex!.width).toBe(16);
    expect(ex!.height).toBe(4);
    expect(ex!.kind).toBe("u8");
    const buf = new Uint8Array(ex!.buffer);
    for (let b = 1; b <= 4; b++) {
      for (let a = 1; a <= 16; a++) {
        expect(buf[(b - 1) * 16 + (a - 1)]).toBe((a + b) % 256);
      }
    }
  });

  it("returns slim points without pixel keys, preserving other keys", () => {
    const p = makeGridPoint(8, 8, { id: 3, label: "walk", x: 1.5, y: -2 });
    const ex = extractPixelGrid([p]);
    expect(ex!.points[0]).toEqual({ id: 3, label: "walk", x: 1.5, y: -2 });
  });

  it("uses f32 when values are not byte integers", () => {
    const p = makeGridPoint(8, 8, {}, () => 0.5);
    const ex = extractPixelGrid([p]);
    expect(ex!.kind).toBe("f32");
    expect(new Float32Array(ex!.buffer)[0]).toBeCloseTo(0.5);
  });

  it("coerces values like the legacy inset extraction", () => {
    const p = makeGridPoint(8, 8, {}, (a, b) => {
      const i = (b - 1) * 8 + (a - 1);
      if (i === 0) return "12"; // numeric string
      if (i === 1) return true; // -> 1
      if (i === 2) return "garbage"; // -> 0
      if (i === 3) return null; // -> 0
      return 5;
    });
    const ex = extractPixelGrid([p]);
    const buf = new Uint8Array(ex!.buffer);
    expect(buf[0]).toBe(12);
    expect(buf[1]).toBe(1);
    expect(buf[2]).toBe(0);
    expect(buf[3]).toBe(0);
    expect(buf[4]).toBe(5);
  });

  it("returns null for non-pixel datasets", () => {
    expect(extractPixelGrid([{ id: 1, x: 0, y: 0 }])).toBeNull();
    expect(extractPixelGrid([])).toBeNull();
  });

  it("packs multiple points contiguously", () => {
    const p1 = makeGridPoint(8, 8, { id: 1 }, () => 10);
    const p2 = makeGridPoint(8, 8, { id: 2 }, () => 20);
    const ex = extractPixelGrid([p1, p2]);
    const buf = new Uint8Array(ex!.buffer);
    expect(buf[0]).toBe(10);
    expect(buf[64]).toBe(20);
    expect(buf.length).toBe(128);
  });
});

describe("attachPixelViews", () => {
  it("attaches zero-copy views with correct offsets and dims", () => {
    const p1 = makeGridPoint(8, 8, { id: 1 }, () => 10);
    const p2 = makeGridPoint(8, 8, { id: 2 }, () => 20);
    const ex = extractPixelGrid([p1, p2])!;
    attachPixelViews(ex.points, ex);

    const s1 = ex.points[0] as { pixels: Uint8Array; pixelsWidth: number; pixelsHeight: number };
    const s2 = ex.points[1] as { pixels: Uint8Array };
    expect(s1.pixels).toBeInstanceOf(Uint8Array);
    expect(s1.pixels.length).toBe(64);
    expect(s1.pixelsWidth).toBe(8);
    expect(s1.pixelsHeight).toBe(8);
    expect(s1.pixels[0]).toBe(10);
    expect(s2.pixels[0]).toBe(20);
    // zero-copy: views share the transferred buffer
    expect(s1.pixels.buffer).toBe(ex.buffer);
    expect(s2.pixels.buffer).toBe(ex.buffer);
  });
});

describe("getTypedGridPixels", () => {
  it("returns null without a typed pixels field or on size mismatch", () => {
    expect(getTypedGridPixels({ id: 1 }, 64)).toBeNull();
    expect(getTypedGridPixels({ pixels: new Uint8Array(32) }, 64)).toBeNull();
    expect(getTypedGridPixels(null, 64)).toBeNull();
  });

  it("reads pixels inherited via the prototype chain (hover-synth points)", () => {
    const base = makeGridPoint(8, 8, { id: 1 }, () => 42);
    const ex = extractPixelGrid([base])!;
    attachPixelViews(ex.points, ex);
    const synth = Object.create(ex.points[0]) as Record<string, unknown>;
    const px = getTypedGridPixels(synth, 64);
    expect(px).not.toBeNull();
    expect(px![0]).toBe(42);
  });

  it("matches the legacy CCTV-convention extraction (untransposed)", () => {
    const W = 16;
    const H = 4;
    const NUM = W * H;
    const point = makeGridPoint(W, H, { id: 5 }, (a, b) => (a * 7 + b * 3) % 256);

    // Legacy path: CCTV PIXEL_KEYS are `${c}x${r}` at i = (r-1)*W + (c-1)
    const legacy = new Float32Array(NUM);
    for (let r = 1; r <= H; r++) {
      for (let c = 1; c <= W; c++) {
        legacy[(r - 1) * W + (c - 1)] = point[`${c}x${r}`] as number;
      }
    }

    const ex = extractPixelGrid([point])!;
    attachPixelViews(ex.points, ex);
    const typed = getTypedGridPixels(ex.points[0], NUM)!;
    expect(Array.from(typed)).toEqual(Array.from(legacy));
  });

  it("matches the legacy MNIST-convention extraction (transposed)", () => {
    const S = 8; // square grid, MNIST-style "{row}x{col}" keys
    const NUM = S * S;
    const point = makeGridPoint(S, S, { id: 9 }, (a, b) => (a * 11 + b * 5) % 256);

    // Legacy path: MNIST PIXEL_KEYS are `${r}x${c}` at i = (r-1)*S + (c-1),
    // i.e. the FIRST key index is the row.
    const legacy = new Float32Array(NUM);
    for (let r = 1; r <= S; r++) {
      for (let c = 1; c <= S; c++) {
        legacy[(r - 1) * S + (c - 1)] = point[`${r}x${c}`] as number;
      }
    }

    const ex = extractPixelGrid([point])!;
    attachPixelViews(ex.points, ex);
    const typed = getTypedGridPixels(ex.points[0], NUM, true)!;
    expect(Array.from(typed)).toEqual(Array.from(legacy));
  });
});
