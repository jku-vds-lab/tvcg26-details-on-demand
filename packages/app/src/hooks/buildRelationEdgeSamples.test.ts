import { describe, expect, it, jest } from "@jest/globals";
import type { ConsolidatedRelation } from "src/clustering/clusterRelations";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

// dataPreprocessing transitively imports rbush (ESM, untransformed under
// ts-jest); the builder only needs createEmptyDataPoint at runtime.
jest.mock("src/dataPreprocessing/dataPreprocessing", () => ({
  createEmptyDataPoint: () => ({ x: 0, y: 0, id: -1 }),
}));

import { buildRelationEdgeSamples } from "./useCreateRelationInsetElements";

function point(id: number): DataPoint {
  return { x: id, y: id, id } as unknown as DataPoint;
}

function relation(overrides: Partial<ConsolidatedRelation>): ConsolidatedRelation {
  return {
    uidA: "a",
    uidB: "b",
    forwardSupport: 1,
    backwardSupport: 0,
    forwardScore: 1,
    backwardScore: 0,
    score: 1,
    startSamples: [point(1)],
    endSamples: [point(2)],
    midSamples: [{ x: 0, y: 0 }],
    actionHistogram: {},
    sizeA: 1,
    sizeB: 1,
    ...overrides,
  } as ConsolidatedRelation;
}

const clusterA = [point(10), point(11)];
const clusterB = [point(20), point(21), point(22)];
const lookup = (uid: string) => (uid === "a" ? clusterA : uid === "b" ? clusterB : undefined);

describe("buildRelationEdgeSamples", () => {
  it("keeps the transition endpoints on every sample", () => {
    const samples = buildRelationEdgeSamples(relation({}), lookup);
    expect(samples).toHaveLength(1);
    expect(samples[0].edgeStart?.id).toBe(1);
    expect(samples[0].edgeEnd?.id).toBe(2);
  });

  it("attaches the start cluster as uidA when the forward direction dominates", () => {
    const samples = buildRelationEdgeSamples(
      relation({ forwardScore: 2, backwardScore: 1 }),
      lookup
    );
    expect(samples[0].edgeClusterStart).toBe(clusterA);
    expect(samples[0].edgeClusterEnd).toBe(clusterB);
  });

  it("flips the clusters when the backward direction dominates", () => {
    const samples = buildRelationEdgeSamples(
      relation({ forwardScore: 1, backwardScore: 2 }),
      lookup
    );
    expect(samples[0].edgeClusterStart).toBe(clusterB);
    expect(samples[0].edgeClusterEnd).toBe(clusterA);
  });

  it("leaves memberships undefined without a resolver", () => {
    const samples = buildRelationEdgeSamples(relation({}));
    expect(samples[0].edgeClusterStart).toBeUndefined();
    expect(samples[0].edgeClusterEnd).toBeUndefined();
  });
});
