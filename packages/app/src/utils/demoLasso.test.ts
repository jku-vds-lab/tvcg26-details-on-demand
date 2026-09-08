import { describe, expect, it } from "@jest/globals";
import { computeGhostLassoPath, resamplePath, splitIntoRegions, ScreenPoint } from "./demoLasso";

const blob = (cx: number, cy: number, n = 12, r = 20): ScreenPoint[] =>
  Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((i / n) * 2 * Math.PI) * (0.4 + (i % 3) * 0.3),
    y: cy + r * Math.sin((i / n) * 2 * Math.PI) * (0.4 + (i % 3) * 0.3),
  }));

describe("splitIntoRegions", () => {
  it("keeps one dense blob as a single region", () => {
    const regions = splitIntoRegions(blob(100, 100), 30);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveLength(12);
  });

  it("splits two far-apart blobs (ctrl-composed selection) into two regions, left first", () => {
    const regions = splitIntoRegions([...blob(600, 100), ...blob(100, 100)], 30);
    expect(regions).toHaveLength(2);
    expect(Math.min(...regions[0].map((p) => p.x))).toBeLessThan(
      Math.min(...regions[1].map((p) => p.x))
    );
    expect(regions[0].length + regions[1].length).toBe(24);
  });

  it("merges blobs when eps spans the gap", () => {
    expect(splitIntoRegions([...blob(100, 100), ...blob(220, 100)], 200)).toHaveLength(1);
  });

  it("handles empty input and singletons", () => {
    expect(splitIntoRegions([], 30)).toEqual([]);
    expect(splitIntoRegions([{ x: 5, y: 5 }], 30)).toEqual([[{ x: 5, y: 5 }]]);
  });
});

describe("computeGhostLassoPath", () => {
  it("returns a closed path containing every region point", () => {
    const region = blob(100, 100);
    const path = computeGhostLassoPath(region, 14);
    expect(path.length).toBeGreaterThanOrEqual(4);
    expect(path[0]).toEqual(path[path.length - 1]);
    // Every point strictly inside the padded hull (ray casting).
    const inside = (p: ScreenPoint) => {
      let is = false;
      for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
        const a = path[i];
        const b = path[j];
        if (
          a.y > p.y !== b.y > p.y &&
          p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
        ) {
          is = !is;
        }
      }
      return is;
    };
    for (const p of region) expect(inside(p)).toBe(true);
  });

  it("falls back to a circle for degenerate regions", () => {
    const path = computeGhostLassoPath([{ x: 10, y: 10 }, { x: 12, y: 10 }], 14);
    expect(path.length).toBeGreaterThan(10);
    expect(path[0]).toEqual(path[path.length - 1]);
  });

  it("returns empty for empty regions", () => {
    expect(computeGhostLassoPath([], 14)).toEqual([]);
  });
});

describe("resamplePath", () => {
  it("spaces vertices ~stepPx apart at constant speed", () => {
    const line: ScreenPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ];
    const out = resamplePath(line, 10);
    for (let i = 1; i < out.length - 1; i++) {
      const d = Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y);
      expect(d).toBeGreaterThan(9.99);
      expect(d).toBeLessThan(10.01);
    }
    expect(out[out.length - 1]).toEqual({ x: 100, y: 50 });
  });

  it("keeps short paths intact", () => {
    expect(resamplePath([{ x: 0, y: 0 }], 10)).toEqual([{ x: 0, y: 0 }]);
    expect(resamplePath([], 10)).toEqual([]);
  });
});
