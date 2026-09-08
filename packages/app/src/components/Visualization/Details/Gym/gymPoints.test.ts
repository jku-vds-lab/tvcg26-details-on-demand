import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { extractRenderPoints } from "./gymPoints";

function point(overrides: Record<string, unknown>): DataPoint {
  return { x: 0, y: 0, line: 0, ...overrides } as unknown as DataPoint;
}

describe("extractRenderPoints", () => {
  it("reads step from the record itself (multipart datasets)", () => {
    expect(extractRenderPoints([point({ line: 2, step: 7 })])).toEqual([[2, 7]]);
  });

  it("falls back to the features bag and coerces strings", () => {
    expect(
      extractRenderPoints([
        point({ line: 1, features: { step: 3 } }),
        point({ line: 1, step: "12" }),
      ])
    ).toEqual([
      [1, 3],
      [1, 12],
    ]);
  });

  it("skips samples without a resolvable step or line", () => {
    expect(
      extractRenderPoints([
        point({ line: 1 }), // no step anywhere
        point({ line: 1, step: "not-a-number" }),
        point({ line: Number.NaN, step: 4 }),
        point({ line: 0, step: 0 }), // valid zero values survive
      ])
    ).toEqual([[0, 0]]);
  });
});
