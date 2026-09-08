import { buildKnn2d } from "./knn2d";

/** Brute-force reference implementation. */
function bruteForce(coords: Float32Array, k: number): number[][] {
  const n = coords.length / 2;
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    const dists = [];
    for (let j = 0; j < n; j++) {
      const dx = coords[2 * j] - coords[2 * i];
      const dy = coords[2 * j + 1] - coords[2 * i + 1];
      dists.push({ index: j, distSq: dx * dx + dy * dy });
    }
    dists.sort((a, b) => a.distSq - b.distSq);
    const row = dists.slice(0, Math.min(k, n));
    result.push(row.map((d) => d.index));
  }
  return result;
}

describe("buildKnn2d", () => {
  it("returns empty for no points", () => {
    expect(buildKnn2d(new Float32Array(0))).toEqual([]);
  });

  it("puts self first in every row", () => {
    const coords = new Float32Array([0, 0, 1, 0, 2, 0, 3, 0]);
    const knn = buildKnn2d(coords, 3);
    knn.forEach((row, i) => expect(row[0]).toBe(i));
  });

  it("handles fewer points than k", () => {
    const coords = new Float32Array([0, 0, 1, 1]);
    const knn = buildKnn2d(coords, 5);
    expect(knn[0]).toEqual([0, 1]);
    expect(knn[1]).toEqual([1, 0]);
  });

  it("handles coincident points without losing self", () => {
    // 6 identical points, k=5: self must still lead each row.
    const coords = new Float32Array(12).fill(3);
    const knn = buildKnn2d(coords, 5);
    knn.forEach((row, i) => {
      expect(row[0]).toBe(i);
      expect(row).toHaveLength(5);
    });
  });

  it("matches brute force on random points (distances, self-first, k=5)", () => {
    const n = 500;
    const k = 5;
    let seed = 1234;
    const rand = () => {
      // mulberry32
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const coords = new Float32Array(2 * n);
    for (let i = 0; i < 2 * n; i++) coords[i] = rand() * 100 - 50;

    const expected = bruteForce(coords, k);
    const actual = buildKnn2d(coords, k);

    const distSq = (i: number, j: number) => {
      const dx = coords[2 * j] - coords[2 * i];
      const dy = coords[2 * j + 1] - coords[2 * i + 1];
      return dx * dx + dy * dy;
    };

    expect(actual).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(actual[i][0]).toBe(i);
      expect(actual[i]).toHaveLength(k);
      // Compare the multiset of neighbor distances (ties make exact index
      // comparison brittle).
      const actualDists = actual[i].map((j) => distSq(i, j)).sort((a, b) => a - b);
      const expectedDists = expected[i].map((j) => distSq(i, j)).sort((a, b) => a - b);
      expectedDists.forEach((d, idx) => expect(actualDists[idx]).toBeCloseTo(d, 6));
    }
  });
});
