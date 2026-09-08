import { computeKnnGraph } from "./knnGraph";

/** Deterministic LCG so the parity test is reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bruteForceDistances(
  points: { x: number; y: number }[],
  i: number,
  k: number
): number[] {
  const d2 = points.map((q) => {
    const dx = q.x - points[i].x;
    const dy = q.y - points[i].y;
    return dx * dx + dy * dy;
  });
  d2.sort((a, b) => a - b);
  return d2.slice(0, Math.min(k, points.length));
}

describe("computeKnnGraph", () => {
  it("returns an empty graph for no points", () => {
    expect(computeKnnGraph([], 5)).toEqual([]);
  });

  it("matches brute force distances on random data", () => {
    const rng = makeRng(42);
    const points = Array.from({ length: 300 }, () => ({
      x: rng() * 100 - 50,
      y: rng() * 60 - 30,
    }));
    const k = 5;
    const graph = computeKnnGraph(points, k);

    expect(graph).toHaveLength(points.length);
    for (let i = 0; i < points.length; i++) {
      const expected = bruteForceDistances(points, i, k);
      const actual = graph[i].map((j) => {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        return dx * dx + dy * dy;
      });
      expect(actual).toHaveLength(k);
      // Rows must be sorted ascending and match the true k smallest distances.
      for (let n = 0; n < k; n++) {
        expect(actual[n]).toBe(expected[n]);
      }
    }
  });

  it("includes the point itself first for distinct points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 5, y: 5 },
    ];
    const graph = computeKnnGraph(points, 3);
    for (let i = 0; i < points.length; i++) {
      expect(graph[i][0]).toBe(i);
    }
  });

  it("caps row length at n when k > n", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    const graph = computeKnnGraph(points, 5);
    expect(graph.map((row) => row.length)).toEqual([3, 3, 3]);
  });

  it("handles fully duplicated points", () => {
    const points = Array.from({ length: 10 }, () => ({ x: 3, y: 3 }));
    const graph = computeKnnGraph(points, 3);
    for (const row of graph) {
      expect(row).toHaveLength(3);
      for (const j of row) {
        expect(points[j]).toEqual({ x: 3, y: 3 });
      }
    }
  });

  it("stays exact across far-apart clusters (grid stress)", () => {
    const rng = makeRng(7);
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 100; i++) points.push({ x: rng(), y: rng() });
    for (let i = 0; i < 100; i++) points.push({ x: 1000 + rng(), y: 1000 + rng() });
    const k = 4;
    const graph = computeKnnGraph(points, k);
    for (let i = 0; i < points.length; i++) {
      const expected = bruteForceDistances(points, i, k);
      const actual = graph[i].map((j) => {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        return dx * dx + dy * dy;
      });
      for (let n = 0; n < k; n++) {
        expect(actual[n]).toBe(expected[n]);
      }
      // Neighbors must come from the same cluster.
      const cluster = i < 100 ? "low" : "high";
      for (const j of graph[i]) {
        expect(j < 100 ? "low" : "high").toBe(cluster);
      }
    }
  });
});
