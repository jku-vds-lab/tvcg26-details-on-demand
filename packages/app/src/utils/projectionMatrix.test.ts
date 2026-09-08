import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import {
  buildProjectionMatrix,
  ONE_HOT_MAX_CATEGORIES,
  PIXELS_FEATURE_KEY,
  standardizeInPlace,
} from "./projectionMatrix";

const makePoint = (overrides: Record<string, unknown>): DataPoint =>
  ({ x: 0, y: 0, id: 0, line: 0, ...overrides } as unknown as DataPoint);

describe("buildProjectionMatrix", () => {
  it("reads top-level keys and the features bag as numeric columns", () => {
    const points = [
      makePoint({ a: 1, features: { b: 10 } }),
      makePoint({ a: 2, features: { b: 20 } }),
    ];
    const { matrix, nRows, nCols, imputedCells, encodings } = buildProjectionMatrix(points, [
      "a",
      "b",
    ]);
    expect(nRows).toBe(2);
    expect(nCols).toBe(2);
    expect(Array.from(matrix)).toEqual([1, 10, 2, 20]);
    expect(imputedCells).toBe(0);
    expect(encodings).toEqual([
      { key: "a", kind: "numeric", columns: 1 },
      { key: "b", kind: "numeric", columns: 1 },
    ]);
  });

  it("treats numeric strings (CSV-loaded columns) as numeric, with trimming", () => {
    const points = [makePoint({ a: " 1.5 ", b: true }), makePoint({ a: "2.5", b: false })];
    const { matrix, encodings } = buildProjectionMatrix(points, ["a", "b"]);
    expect(Array.from(matrix)).toEqual([1.5, 1, 2.5, 0]);
    expect(encodings.every((e) => e.kind === "numeric")).toBe(true);
  });

  it("imputes missing numeric cells with the column mean", () => {
    const points = [makePoint({ a: 1 }), makePoint({ a: 3 }), makePoint({})];
    const { matrix, imputedCells } = buildProjectionMatrix(points, ["a"]);
    expect(Array.from(matrix)).toEqual([1, 3, 2]);
    expect(imputedCells).toBe(1);
  });

  it("one-hot encodes categorical features, trimming stray whitespace", () => {
    // Rubik's-style sticker colors; ' start' carries a leading space (issue #186).
    const points = [
      makePoint({ phase: " start", sticker: "R" }),
      makePoint({ phase: "start", sticker: "G" }),
      makePoint({ phase: "oll", sticker: "R" }),
    ];
    const { matrix, nCols, encodings } = buildProjectionMatrix(points, ["phase", "sticker"]);
    expect(encodings).toEqual([
      { key: "phase", kind: "onehot", columns: 2 }, // start, oll (trim merges " start"/"start")
      { key: "sticker", kind: "onehot", columns: 2 }, // R, G
    ]);
    expect(nCols).toBe(4);
    // Row sums: exactly one hot per feature block.
    for (let r = 0; r < 3; r++) {
      const row = Array.from(matrix.slice(r * 4, r * 4 + 4));
      expect(row.slice(0, 2).reduce((a, b) => a + b)).toBe(1);
      expect(row.slice(2).reduce((a, b) => a + b)).toBe(1);
    }
    // Rows 0 and 1 share the trimmed "start" category column.
    expect(Array.from(matrix.slice(0, 2))).toEqual(Array.from(matrix.slice(4, 6)));
  });

  it("caps one-hot categories at the most frequent ONE_HOT_MAX_CATEGORIES", () => {
    const points: DataPoint[] = [];
    // 60 distinct categories; "common" appears 5 times.
    for (let i = 0; i < 5; i++) points.push(makePoint({ c: "common" }));
    for (let i = 0; i < 60; i++) points.push(makePoint({ c: `rare-${i}` }));
    const { nCols, encodings, matrix } = buildProjectionMatrix(points, ["c"]);
    expect(encodings[0].columns).toBe(ONE_HOT_MAX_CATEGORIES);
    expect(nCols).toBe(ONE_HOT_MAX_CATEGORIES);
    // "common" is the most frequent → all five rows share a hot column.
    const firstRow = Array.from(matrix.slice(0, nCols));
    expect(firstRow.reduce((a, b) => a + b)).toBe(1);
  });

  it("expands the pixels key to one column per pixel", () => {
    const points = [
      makePoint({ pixels: new Uint8Array([0, 128, 255]) }),
      makePoint({ pixels: new Uint8Array([10, 20, 30]) }),
      makePoint({}), // missing pixels → zeros
    ];
    const { matrix, nCols, encodings } = buildProjectionMatrix(points, [PIXELS_FEATURE_KEY]);
    expect(encodings).toEqual([{ key: PIXELS_FEATURE_KEY, kind: "pixels", columns: 3 }]);
    expect(nCols).toBe(3);
    expect(Array.from(matrix)).toEqual([0, 128, 255, 10, 20, 30, 0, 0, 0]);
  });

  it("skips features with no present values", () => {
    const points = [makePoint({ a: 1 }), makePoint({ a: 2 })];
    const { nCols, encodings } = buildProjectionMatrix(points, ["ghost", "a"]);
    expect(nCols).toBe(1);
    expect(encodings).toEqual([{ key: "a", kind: "numeric", columns: 1 }]);
  });

  it("mixes numeric, categorical, and pixel features in column order", () => {
    const points = [
      makePoint({ n: 1, cat: "x", pixels: new Uint8Array([7]) }),
      makePoint({ n: 2, cat: "y", pixels: new Uint8Array([9]) }),
    ];
    const { nCols, encodings } = buildProjectionMatrix(points, ["n", "cat", PIXELS_FEATURE_KEY]);
    expect(nCols).toBe(4); // 1 numeric + 2 one-hot + 1 pixel
    expect(encodings.map((e) => e.kind)).toEqual(["numeric", "onehot", "pixels"]);
  });
});

describe("standardizeInPlace", () => {
  it("z-scores columns to zero mean and unit variance", () => {
    const matrix = new Float32Array([0, 4, 10, 8]);
    const { constantColumns } = standardizeInPlace(matrix, 2, 2);
    expect(constantColumns).toEqual([]);
    expect(Array.from(matrix)).toEqual([-1, -1, 1, 1]);
  });

  it("zeroes constant columns and reports their indices", () => {
    const matrix = new Float32Array([5, 1, 5, 2, 5, 3]);
    const { constantColumns } = standardizeInPlace(matrix, 3, 2);
    expect(constantColumns).toEqual([0]);
    expect(matrix[0]).toBe(0);
    expect(matrix[2]).toBe(0);
    expect(matrix[4]).toBe(0);
  });

  it("handles empty input", () => {
    const { constantColumns } = standardizeInPlace(new Float32Array(0), 0, 3);
    expect(constantColumns).toEqual([]);
  });
});
