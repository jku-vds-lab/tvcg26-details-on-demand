import { describe, expect, it } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { attachPointColumns } from "../dataPreprocessing/pointColumns";
import { applyFreehandDoiBoost } from "./freehandDoi";

const makeNodes = (dois: number[]): DataPoint[] =>
  dois.map((doi, i) => ({ id: i, DoI: doi } as unknown as DataPoint));

// Column-backed canonical fixture: ids deliberately offset from indices so an
// id/index confusion would surface. Mirrors makePoints in pointColumns.test.ts.
const makeColumnBackedNodes = (dois: number[]): DataPoint[] => {
  const nodes = dois.map((doi, i) => ({
    x: i,
    y: i,
    line: 0,
    id: 100 + i,
    DoI: doi,
  })) as unknown as DataPoint[];
  attachPointColumns(nodes);
  return nodes;
};

describe("applyFreehandDoiBoost", () => {
  it("boosts members to DoI 1 and never touches the rest of the field", () => {
    const nodes = makeNodes([0.7, 0.2, 0.05, 0]);
    applyFreehandDoiBoost(nodes, new Set([2]));
    expect(nodes.map((n) => n.DoI)).toEqual([0.7, 0.2, 1, 0]);
  });

  it("leaves a uniform no-selection field untouched apart from members", () => {
    const nodes = makeNodes([1, 1, 1, 1]);
    applyFreehandDoiBoost(nodes, new Set([1, 3]));
    expect(nodes.map((n) => n.DoI)).toEqual([1, 1, 1, 1]);
  });

  it("does nothing without members", () => {
    const nodes = makeNodes([0.7, 0.2, 0]);
    applyFreehandDoiBoost(nodes, new Set());
    expect(nodes.map((n) => n.DoI)).toEqual([0.7, 0.2, 0]);
  });

  it("columnar (O(selection)) path matches the object scan on the same field", () => {
    const dois = [0.7, 0.2, 0.05, 0, 0.9];
    // ids are 100..104; select two of them.
    const members = new Set([102, 104]);

    const columnar = makeColumnBackedNodes(dois);
    applyFreehandDoiBoost(columnar, members);

    const fallback = makeNodes(dois).map((n, i) => {
      (n as unknown as { id: number }).id = 100 + i;
      return n;
    });
    applyFreehandDoiBoost(fallback, members);

    expect(columnar.map((n) => n.DoI)).toEqual([0.7, 0.2, 1, 0, 1]);
    expect(columnar.map((n) => n.DoI)).toEqual(fallback.map((n) => n.DoI));
  });

  it("columnar path ignores ids not present in the dataset", () => {
    const columnar = makeColumnBackedNodes([0.3, 0.4, 0.5]);
    applyFreehandDoiBoost(columnar, new Set([101, 9999]));
    expect(columnar.map((n) => n.DoI)).toEqual([0.3, 1, 0.5]);
  });

  it("columnar path is a no-op for an empty selection", () => {
    const columnar = makeColumnBackedNodes([0.3, 0.4, 0.5]);
    applyFreehandDoiBoost(columnar, new Set());
    expect(columnar.map((n) => n.DoI)).toEqual([0.3, 0.4, 0.5]);
  });
});
