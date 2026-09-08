import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";
import { relationEmphasisField } from "./relationEmphasisField";

function makePoint(id: number): EdgeAugmentedPoint {
  // Minimal object — only fields used by relationEmphasisField.
  return { id } as unknown as EdgeAugmentedPoint;
}

function makeSample(
  startId: number,
  endId: number,
): EdgeAugmentedPoint {
  const start = makePoint(startId);
  const end = makePoint(endId);
  return {
    ...makePoint(startId),
    edgeStart: start,
    edgeEnd: end,
  } as unknown as EdgeAugmentedPoint;
}

describe("relationEmphasisField", () => {
  it("sets endpoint indices to 1.0 and all others to 0.0", () => {
    const indexById = new Map([[10, 0], [20, 1], [30, 2]]);
    const samples = [makeSample(10, 20)];
    const field = relationEmphasisField(samples, indexById, 3);

    expect(field[0]).toBeCloseTo(1.0); // edgeStart.id = 10
    expect(field[1]).toBeCloseTo(1.0); // edgeEnd.id = 20
    expect(field[2]).toBeCloseTo(0.0); // unrelated
  });

  it("uses edgeStart.id and edgeEnd.id — NOT sample.id", () => {
    // sample.id == edgeStart.id by convention; we want to make sure both endpoints are set
    const indexById = new Map([[1, 0], [2, 1]]);
    const start = makePoint(1);
    const end = makePoint(2);
    const sample: EdgeAugmentedPoint = {
      id: 999, // deliberately different from edgeStart.id to verify we use edgeStart.id
      edgeStart: start,
      edgeEnd: end,
    } as unknown as EdgeAugmentedPoint;

    const field = relationEmphasisField([sample], indexById, 2);
    expect(field[0]).toBeCloseTo(1.0); // index of edgeStart.id = 1
    expect(field[1]).toBeCloseTo(1.0); // index of edgeEnd.id = 2
  });

  it("silently skips unknown ids (not in indexById)", () => {
    const indexById = new Map([[10, 0]]);
    const samples = [makeSample(10, 999)]; // 999 not in map
    const field = relationEmphasisField(samples, indexById, 2);
    expect(field[0]).toBeCloseTo(1.0);
    expect(field[1]).toBeCloseTo(0.0);
  });

  it("handles samples with undefined edgeStart / edgeEnd gracefully", () => {
    const indexById = new Map([[1, 0]]);
    const sample = { id: 1 } as unknown as EdgeAugmentedPoint; // no edgeStart/edgeEnd
    const field = relationEmphasisField([sample], indexById, 1);
    expect(field[0]).toBeCloseTo(0.0); // nothing set
  });

  it("returns all-zeros for empty samples", () => {
    const indexById = new Map([[1, 0]]);
    const field = relationEmphasisField([], indexById, 3);
    for (let i = 0; i < field.length; i++) expect(field[i]).toBeCloseTo(0.0);
  });

  it("returns a Float32Array of the correct length", () => {
    const indexById = new Map<number, number>();
    const field = relationEmphasisField([], indexById, 7);
    expect(field).toBeInstanceOf(Float32Array);
    expect(field.length).toBe(7);
  });
});
