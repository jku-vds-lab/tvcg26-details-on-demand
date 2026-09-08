import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  collectFeatureColumns,
  computeDiffRows,
  computeSummaryRows,
  formatStatValue,
  getReferenceDistribution,
  jensenShannon,
  MAX_CATEGORIES,
  NUMERIC_BINS,
  sortDiffRows,
  sortSummaryRows,
} from "./featureStats";

const makePoint = (extra: Record<string, unknown>): DataPoint =>
  ({ x: 0, y: 0, id: 0, line: 0, DoI: 1, ...extra }) as unknown as DataPoint;

describe("collectFeatureColumns", () => {
  it("classifies numeric and low-cardinality string columns, skipping internals and pixel keys", () => {
    const samples = [
      makePoint({ reward: 1, variety: "setosa", "3x7": 255, step: "2", insetClusterId: 4 }),
      makePoint({ reward: "2.5", variety: "virginica", "3x7": 0, step: "3", insetClusterId: 4 }),
    ];
    expect(collectFeatureColumns(samples)).toEqual([
      { column: "reward", kind: "numeric" },
      { column: "step", kind: "numeric" },
      { column: "variety", kind: "categorical" },
    ]);
  });

  it("drops high-cardinality string columns (free text / ids)", () => {
    const samples = Array.from({ length: 60 }, (_, i) =>
      makePoint({ note: `unique text ${i}`, grade: i % 3 === 0 ? "a" : "b" })
    );
    expect(collectFeatureColumns(samples)).toEqual([{ column: "grade", kind: "categorical" }]);
  });

  it("excludes the pipeline-computed action and label copies (their source columns stay)", () => {
    const samples = [
      makePoint({ action: "setosa", label: "setosa", variety: "setosa" }),
      makePoint({ action: "virginica", label: "virginica", variety: "virginica" }),
    ];
    expect(collectFeatureColumns(samples)).toEqual([
      { column: "variety", kind: "categorical" },
    ]);
  });

  it("reads real values on labeled points instead of the assigned-label override", () => {
    // getAnnotationValue would return "MyLabel" for EVERY column here.
    const labeled = [1, 2, 3].map((v) =>
      makePoint({ v, features: { __assignedLabel: "MyLabel" } })
    );
    expect(collectFeatureColumns(labeled)).toEqual([{ column: "v", kind: "numeric" }]);
    const [row] = computeSummaryRows(labeled, [{ column: "v", kind: "numeric" }], labeled);
    expect(row.mean).toBe(2);
    expect(row.count).toBe(3);
  });

  it("reads columns stored under .features too, and returns empty for empty input", () => {
    expect(collectFeatureColumns([makePoint({ features: { speed: 3 } })])).toEqual([
      { column: "speed", kind: "numeric" },
    ]);
    expect(collectFeatureColumns([])).toEqual([]);
  });
});

describe("getReferenceDistribution", () => {
  it("bins numeric columns over the data range with probabilities summing to 1", () => {
    const data = [1, 2, 3, 4, 10].map((v) => makePoint({ v }));
    const dist = getReferenceDistribution(data, { column: "v", kind: "numeric" })!;
    expect(dist.min).toBe(1);
    expect(dist.max).toBe(10);
    expect(dist.probs).toHaveLength(NUMERIC_BINS);
    expect(dist.probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
  });

  it("keeps the top categories and folds the rest into 'other'", () => {
    const labels = [
      ...Array(20).fill("a"),
      ...Array(10).fill("b"),
      ..."cdefghij".split(""), // 8 rare singletons → overflow
    ];
    const data = labels.map((l) => makePoint({ l }));
    const dist = getReferenceDistribution(data, { column: "l", kind: "categorical" })!;
    expect(dist.categories!).toHaveLength(MAX_CATEGORIES);
    expect(dist.categories![0]).toBe("a");
    expect(dist.categories![dist.categories!.length - 1]).toBe("other");
    expect(dist.probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
  });

  it("is memoized per data-array identity", () => {
    const data = [makePoint({ v: 1 }), makePoint({ v: 2 })];
    const a = getReferenceDistribution(data, { column: "v", kind: "numeric" });
    const b = getReferenceDistribution(data, { column: "v", kind: "numeric" });
    expect(a).toBe(b);
  });
});

describe("jensenShannon", () => {
  it("is 0 for identical, 1 for disjoint, symmetric in between", () => {
    expect(jensenShannon([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(0, 9);
    expect(jensenShannon([1, 0], [0, 1])).toBeCloseTo(1, 9);
    const a = [0.8, 0.2, 0];
    const b = [0.2, 0.5, 0.3];
    expect(jensenShannon(a, b)).toBeCloseTo(jensenShannon(b, a), 12);
    expect(jensenShannon(a, b)).toBeGreaterThan(0);
    expect(jensenShannon(a, b)).toBeLessThan(1);
  });
});

describe("computeSummaryRows", () => {
  const globalData = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => makePoint({ v, cls: v <= 5 ? "low" : "high" })),
  ];

  it("computes numeric stats plus a divergence against the dataset distribution", () => {
    const cluster = globalData.slice(0, 3); // low end only → skewed vs global
    const [row] = computeSummaryRows(cluster, [{ column: "v", kind: "numeric" }], globalData);
    expect(row.kind).toBe("numeric");
    expect(row.mean).toBeCloseTo(2);
    expect(row.median).toBe(2);
    expect(row.count).toBe(3);
    expect(row.referenceProbs.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
    expect(row.divergence).toBeGreaterThan(0.2);
  });

  it("computes categorical rows with mode and shared category bins", () => {
    const cluster = globalData.slice(0, 4);
    const [row] = computeSummaryRows(cluster, [{ column: "cls", kind: "categorical" }], globalData);
    expect(row.kind).toBe("categorical");
    expect(row.modeLabel).toBe("low");
    expect(row.modeShare).toBe(1);
    expect(row.categories).toEqual(expect.arrayContaining(["low", "high"]));
    expect(row.divergence).toBeGreaterThan(0);
  });

  it("falls back to the cluster itself as reference (divergence 0) when no data given", () => {
    const cluster = [makePoint({ v: 1 }), makePoint({ v: 5 })];
    const [row] = computeSummaryRows(cluster, [{ column: "v", kind: "numeric" }], []);
    expect(row.divergence).toBeCloseTo(0, 9);
  });

  it("drops columns without usable values", () => {
    const cluster = [makePoint({ v: 1 })];
    expect(
      computeSummaryRows(cluster, [{ column: "absent", kind: "numeric" }], globalData)
    ).toHaveLength(0);
  });
});

describe("computeDiffRows", () => {
  const a = [1, 2, 3].map((v) => makePoint({ v, cls: "low", onlyA: 1 }));
  const b = [7, 8, 9].map((v) => makePoint({ v, cls: "high" }));
  const reference = [...a, ...b];

  it("computes signed delta of means and a positive divergence for separated sides", () => {
    const [row] = computeDiffRows(a, b, [{ column: "v", kind: "numeric" }], reference);
    expect(row.meanA).toBe(2);
    expect(row.meanB).toBe(8);
    expect(row.deltaMean).toBe(6);
    expect(row.divergence).toBeCloseTo(1, 6); // fully disjoint distributions
    expect(row.probsA.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 9);
  });

  it("computes categorical modes per side", () => {
    const [row] = computeDiffRows(a, b, [{ column: "cls", kind: "categorical" }], reference);
    expect(row.modeA).toBe("low");
    expect(row.modeB).toBe("high");
    expect(row.divergence).toBeCloseTo(1, 6);
  });

  it("drops columns with values on only one side", () => {
    expect(computeDiffRows(a, b, [{ column: "onlyA", kind: "numeric" }], reference)).toHaveLength(0);
  });
});

describe("sorting", () => {
  const globalData = [
    ...[0, 1].flatMap((r) =>
      [1, 2, 3].map((v) => makePoint({ steady: v, wild: v * 100 * (r + 1), cls: r ? "a" : "b" }))
    ),
  ];
  const columns = collectFeatureColumns(globalData);
  const rows = computeSummaryRows(globalData.slice(0, 3), columns, globalData);

  it("sorts summary rows by name and by variance (impurity for categorical)", () => {
    expect(sortSummaryRows(rows, "name", false).map((r) => r.column)).toEqual([
      "cls",
      "steady",
      "wild",
    ]);
    expect(sortSummaryRows(rows, "variance", true)[0].column).toBe("wild");
  });

  it("ranks diff rows by divergence by default and by |Δ mean| for value", () => {
    const a = globalData.slice(0, 3);
    const b = globalData.slice(3);
    const diffs = computeDiffRows(a, b, columns, globalData);
    const byDifference = sortDiffRows(diffs, "difference", true);
    expect(byDifference[0].divergence).toBeGreaterThanOrEqual(
      byDifference[byDifference.length - 1].divergence
    );
    const byValue = sortDiffRows(diffs, "value", true);
    const numericFirst = byValue.find((r) => r.kind === "numeric");
    expect(numericFirst!.column).toBe("wild"); // |Δ| 300 ≫ |Δ| 0
  });
});

describe("formatStatValue", () => {
  it("formats compactly across magnitudes", () => {
    expect(formatStatValue(0)).toBe("0");
    expect(formatStatValue(1234.5)).toBe("1235");
    expect(formatStatValue(0.12345)).toBe("0.123");
    expect(formatStatValue(123456)).toBe("1.2e+5");
    expect(formatStatValue(NaN)).toBe("—");
  });
});
