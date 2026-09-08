// Mock rbush (ESM, pulled in via loadSimpleDataset → JSONLoader →
// dataPreprocessing) to avoid transform issues in Jest — same convention as
// simpleDataset.test.ts. The cap check never touches geometry.
jest.mock("rbush", () => ({ __esModule: true, default: class {} }));

// The worker factory module holds the only import.meta in the graph — jest
// (ts-jest, TS1343) cannot parse it, so it is always mocked in suites that
// import loadSimpleDataset (same convention as makeJsonWorker).
jest.mock("../workers/makeSimplePreprocessWorker", () => ({
  makeSimplePreprocessWorker: jest.fn(),
}));

import {
  DatasetTooLargeError,
  loadSimpleDataset,
  SIMPLE_MAX_ROWS,
} from "./loadSimpleDataset";
import { makeSimplePreprocessWorker } from "../workers/makeSimplePreprocessWorker";

describe("loadSimpleDataset row cap", () => {
  it("rejects oversized datasets before spawning the worker", async () => {
    // Sparse array: only .length matters for the cap check.
    const rows = new Array(SIMPLE_MAX_ROWS + 1) as Record<string, unknown>[];
    await expect(loadSimpleDataset(rows, { x: "x", y: "y" })).rejects.toThrow(
      DatasetTooLargeError
    );
    await expect(loadSimpleDataset(rows, { x: "x", y: "y" })).rejects.toThrow(
      /100,000/
    );
    expect(makeSimplePreprocessWorker).not.toHaveBeenCalled();
  });
});
