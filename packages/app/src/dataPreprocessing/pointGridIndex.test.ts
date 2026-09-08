// Mock rbush (ESM) to avoid transform issues, matching the repo convention
// (see splineGeometry.test.ts). The mock reproduces rbush's inclusive
// intersection test, so it is a faithful search/all oracle for parity.
jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); return this; }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); return this; }
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

import rbush from "rbush";
import { buildPointGridIndexChunked } from "./pointGridIndex";
import type { DataPoint, RTreeItem } from "./dataPreprocessing";

/** Deterministic LCG so the parity test is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PADDING = 0.5;

function makePoints(rng: () => number, n: number, spanX = 200, spanY = 120): DataPoint[] {
  return Array.from({ length: n }, (_, id) => ({
    id,
    x: rng() * spanX - spanX / 2,
    y: rng() * spanY - spanY / 2,
  })) as unknown as DataPoint[];
}

/** The rbush the old buildPointRTreeChunked produced — the parity oracle. */
function makeRbush(points: DataPoint[]): rbush<RTreeItem<DataPoint>> {
  const tree = new rbush<RTreeItem<DataPoint>>();
  tree.load(
    points.map((p) => ({
      minX: p.x - PADDING,
      minY: p.y - PADDING,
      maxX: p.x + PADDING,
      maxY: p.y + PADDING,
      data: p,
    }))
  );
  return tree;
}

const idSet = (items: RTreeItem<DataPoint>[]): Set<number> =>
  new Set(items.map((it) => it.data.id));

describe("buildPointGridIndexChunked", () => {
  it("returns identical search result SETS to a real rbush across random boxes", async () => {
    const rng = makeRng(1234);
    const points = makePoints(rng, 800);
    const grid = await buildPointGridIndexChunked(points);
    const oracle = makeRbush(points);

    for (let t = 0; t < 500; t++) {
      const cx = rng() * 220 - 110;
      const cy = rng() * 140 - 70;
      const w = rng() * 40;
      const h = rng() * 40;
      const box = { minX: cx, minY: cy, maxX: cx + w, maxY: cy + h };
      const got = idSet(grid.search(box));
      const want = idSet(oracle.search(box));
      expect(Array.from(got).sort((a, b) => a - b)).toEqual(Array.from(want).sort((a, b) => a - b));
    }
  });

  it("matches rbush on edge-touching boxes that exercise the 0.5 padding", async () => {
    // A single point at the origin: padded box is [-0.5, 0.5]^2.
    const points = makePoints(() => 0.5, 1); // rng const -> x=0, y=0
    const grid = await buildPointGridIndexChunked(points);
    const oracle = makeRbush(points);

    // Boxes whose edge lands exactly on / just inside / just outside the pad.
    const boxes = [
      { minX: -0.5, minY: -0.5, maxX: -0.5, maxY: -0.5 }, // corner touch -> hit
      { minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }, // opposite corner -> hit
      { minX: -0.5, minY: 0, maxX: -0.5, maxY: 0 }, // left edge exact -> hit
      { minX: -0.5001, minY: 0, maxX: -0.5001, maxY: 0 }, // just outside -> miss
      { minX: 0.5001, minY: 0, maxX: 0.5001, maxY: 0 }, // just outside -> miss
      { minX: -10, minY: -10, maxX: 10, maxY: 10 }, // fully contains -> hit
    ];
    for (const box of boxes) {
      expect(idSet(grid.search(box))).toEqual(idSet(oracle.search(box)));
    }
  });

  it("matches rbush on collinear and coincident points", async () => {
    const rng = makeRng(77);
    // Collinear (height collapses) and duplicate coordinates.
    const points = [
      ...Array.from({ length: 50 }, (_, id) => ({ id, x: id * 2 - 40, y: 5 })),
      ...Array.from({ length: 20 }, (_, id) => ({ id: 100 + id, x: 3, y: 5 })),
    ] as unknown as DataPoint[];
    const grid = await buildPointGridIndexChunked(points);
    const oracle = makeRbush(points);

    for (let t = 0; t < 200; t++) {
      const cx = rng() * 100 - 50;
      const w = rng() * 20;
      const box = { minX: cx, minY: 4, maxX: cx + w, maxY: 6 };
      expect(Array.from(idSet(grid.search(box))).sort((a, b) => a - b)).toEqual(
        Array.from(idSet(oracle.search(box))).sort((a, b) => a - b)
      );
    }
  });

  // ── Consumer-mapped methods ───────────────────────────────────────────────
  // The point R-tree's consumers (ClusterVisualizations filteredNodeTree +
  // viewport query, DebugLassoBehavior lasso prefilter + stale-tree guard)
  // call only .all() and .search(box).

  it(".all() returns every point as an RTreeItem with padded bounds", async () => {
    const rng = makeRng(9);
    const points = makePoints(rng, 250);
    const grid = await buildPointGridIndexChunked(points);

    const all = grid.all();
    expect(all).toHaveLength(points.length);
    expect(idSet(all)).toEqual(new Set(points.map((p) => p.id)));
    for (const it of all) {
      expect(it.minX).toBe(it.data.x - PADDING);
      expect(it.minY).toBe(it.data.y - PADDING);
      expect(it.maxX).toBe(it.data.x + PADDING);
      expect(it.maxY).toBe(it.data.y + PADDING);
    }
  });

  it(".search(box) returns RTreeItem<DataPoint> objects carrying the point in .data", async () => {
    const rng = makeRng(5);
    const points = makePoints(rng, 300);
    const grid = await buildPointGridIndexChunked(points);

    const hits = grid.search({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
    expect(hits.length).toBeGreaterThan(0);
    for (const it of hits) {
      expect(points).toContain(it.data);
      expect(it).toEqual({
        minX: it.data.x - PADDING,
        minY: it.data.y - PADDING,
        maxX: it.data.x + PADDING,
        maxY: it.data.y + PADDING,
        data: it.data,
      });
    }
  });

  it("handles an empty dataset", async () => {
    const grid = await buildPointGridIndexChunked([]);
    expect(grid.all()).toEqual([]);
    expect(grid.search({ minX: -1, minY: -1, maxX: 1, maxY: 1 })).toEqual([]);
  });

  it("honors the abort signal between chunks", async () => {
    const rng = makeRng(3);
    const points = makePoints(rng, 6000);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(buildPointGridIndexChunked(points, ctrl.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
