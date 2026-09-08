// subsetLeafRanges (issue #315 F2c): the wire form of a selection — half-open
// ranges over the full tree's leaf order, merged where positions are
// contiguous, order-independent of the input, throwing on desynced indices.

import { jest } from "@jest/globals";

// The module graph pulls in the worker factory (import.meta) — mock it out,
// same as hdbscanClustering.workerfit.test.ts.
jest.mock("src/workers/hdbscanWorkerProxy", () => ({
  hdbscanWorkerProxy: { fit: jest.fn(), cancel: jest.fn() },
}));

// Mock rbush (ESM) to avoid transform issues in Jest — same as
// hdbscanClustering.workerfit.test.ts.
jest.mock("rbush", () => ({
  __esModule: true,
  default: class RBushMock {
    load() {}
    clear() {}
    all() { return []; }
    insert() {}
    search() { return []; }
  },
}));

import { subsetLeafRanges } from "./hdbscanClustering";

describe("subsetLeafRanges", () => {
  // leaf position p holds dataset index: [4, 2, 0, 1, 3, 5]
  const leafOrder = [4, 2, 0, 1, 3, 5];

  it("merges contiguous leaf positions into one range", () => {
    // dataset 2,0,1 sit at positions 1,2,3 — one merged range.
    expect(subsetLeafRanges(leafOrder, [0, 1, 2])).toEqual([[1, 4]]);
  });

  it("keeps disjoint positions as separate ranges", () => {
    // dataset 4 -> pos 0, dataset 3 -> pos 4.
    expect(subsetLeafRanges(leafOrder, [3, 4])).toEqual([[0, 1], [4, 5]]);
  });

  it("is independent of the subset's input order", () => {
    expect(subsetLeafRanges(leafOrder, [2, 5, 3])).toEqual(
      subsetLeafRanges(leafOrder, [5, 3, 2])
    );
  });

  it("covers the full set as one range", () => {
    expect(subsetLeafRanges(leafOrder, [0, 1, 2, 3, 4, 5])).toEqual([[0, 6]]);
  });

  it("throws for an index outside the leaf order", () => {
    expect(() => subsetLeafRanges(leafOrder, [6])).toThrow(/not in the leaf order/);
    expect(() => subsetLeafRanges(leafOrder, [-1])).toThrow(/not in the leaf order/);
  });
});
