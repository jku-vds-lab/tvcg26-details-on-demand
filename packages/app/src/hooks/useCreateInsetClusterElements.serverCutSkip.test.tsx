// Issue #315 plan G0: when the cut-driven grouping bails (persistent
// clustering one tick behind the dispatched hierarchyId) on a SERVER-CUT
// dataset, the hook must keep its previous items instead of running the
// legacy O(dataset) groupBy fallback (the measured drag-release spike:
// fallback groups key numerically, server hulls key by uid → client
// computeHull over full memberships). Legacy datasets keep the fallback.

import { describe, expect, it, jest } from "@jest/globals";

// Mock rbush (ESM) to avoid transform issues in Jest — repo convention.
jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { isServerCutActive } from "src/clustering/hdbscanClustering";
import store, { setInsetClusteringResults } from "src/store";
import { useCreateInsetClusterElements } from "./useCreateInsetClusterElements";

// cutDrivenGroups resolves the persistent clustering through these getters;
// returning null forces the "swap in flight" branch the fix targets.
jest.mock("src/clustering/hdbscanClustering", () => ({
  isServerCutActive: jest.fn(() => false),
  getNodeClusteringContext: jest.fn(() => null),
  getMidpointClusteringContext: jest.fn(() => null),
}));

const serverCutActiveMock = isServerCutActive as jest.MockedFunction<typeof isServerCutActive>;

const mkPoint = (id: number, x: number, y: number): DataPoint => ({
  x,
  y,
  line: 0,
  algo: "a",
  id,
  action: "",
  DoI: 1,
  doiGroup: "inset",
  insetClusterId: "0xa",
  nextEdgeCenter: { x, y },
});

const NODES: DataPoint[] = [mkPoint(1, 0, 0), mkPoint(2, 1, 0), mkPoint(3, 0, 1)];

const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

describe("useCreateInsetClusterElements server-cut fallback skip (G0)", () => {
  it("keeps previous items during the one-tick race, falls back otherwise", () => {
    serverCutActiveMock.mockReturnValue(false);
    const { result } = renderHook(() => useCreateInsetClusterElements(NODES), { wrapper });

    // Legacy fallback (no server cut, no context): groupBy built the items.
    const initialIds = result.current.clusters.map((c) => c.element.id);
    expect(initialIds.some((id) => id.includes("0xa"))).toBe(true);

    // Server-cut race tick: cut-driven grouping is null while a new
    // hierarchyId is already dispatched → the effect must skip entirely
    // (same ids, no ::h7 rebuild from the fallback).
    serverCutActiveMock.mockReturnValue(true);
    act(() => {
      store.dispatch(
        setInsetClusteringResults({ activeClusters: [], hierarchyId: 7 })
      );
    });
    expect(result.current.clusters.map((c) => c.element.id)).toEqual(initialIds);

    // Same tick shape on a legacy dataset: the fallback runs and rebuilds
    // against the new hierarchy suffix.
    serverCutActiveMock.mockReturnValue(false);
    act(() => {
      store.dispatch(
        setInsetClusteringResults({ activeClusters: [], hierarchyId: 8 })
      );
    });
    const rebuiltIds = result.current.clusters.map((c) => c.element.id);
    expect(rebuiltIds).not.toEqual(initialIds);
    expect(rebuiltIds.some((id) => id.includes("::h8"))).toBe(true);
  });
});
