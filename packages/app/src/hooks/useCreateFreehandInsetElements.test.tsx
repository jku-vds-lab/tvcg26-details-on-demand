import { beforeEach, describe, expect, it } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { DataProvider, useDataRef } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { setPositions } from "src/layout/layoutStore";
import {
    addFreehandInset,
    replaceFreehandInsets,
    setFreehandMode,
} from "src/slices/freehandSlice";
import store, {
    setInsetClusteringResults,
    updateInsetActiveClusters,
} from "src/store";
import { useCreateFreehandInsetElements } from "./useCreateFreehandInsetElements";

const mkPoint = (id: number, x: number, y: number): DataPoint => ({
  x,
  y,
  line: 0,
  algo: "a",
  id,
  action: "",
  DoI: 1,
  doiGroup: "gray",
  nextEdgeCenter: { x, y },
});

const NODES: DataPoint[] = [
  mkPoint(1, 0, 0),
  mkPoint(2, 1, 0),
  mkPoint(3, 0, 1),
  mkPoint(4, 1, 1),
  mkPoint(5, 2, 2),
];

const SeedNodes = ({ children }: { children: ReactNode }) => {
  const dataRef = useDataRef();
  dataRef.current = NODES;
  return <>{children}</>;
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>
    <DataProvider>
      <SeedNodes>{children}</SeedNodes>
    </DataProvider>
  </Provider>
);

const memberIdsOf = (item: { element: { samples: DataPoint[] } }) =>
  item.element.samples.map((s) => s.id).sort((a, b) => a - b);

describe("useCreateFreehandInsetElements", () => {
  beforeEach(() => {
    setPositions(new Map());
    act(() => {
      // Clears freehand insets (they are mode-scoped).
      store.dispatch(setFreehandMode(false));
    });
  });

  it("creates exactly one inset whose membership equals the lassoed points", () => {
    const { result } = renderHook(() => useCreateFreehandInsetElements(), { wrapper });
    expect(result.current.visibleClusterItems).toHaveLength(0);

    act(() => {
      store.dispatch(setFreehandMode(true));
      store.dispatch(replaceFreehandInsets([1, 3, 4]));
    });

    const items = result.current.visibleClusterItems;
    expect(items).toHaveLength(1);
    expect(memberIdsOf(items[0])).toEqual([1, 3, 4]);
    expect(items[0].element.id).toContain("::freehand");
    // Node-kind insets get a hull like any other inset.
    expect(items[0].hull).not.toBeNull();
  });

  it("Ctrl+lasso adds a second separate inset (no union)", () => {
    const { result } = renderHook(() => useCreateFreehandInsetElements(), { wrapper });

    act(() => {
      store.dispatch(setFreehandMode(true));
      store.dispatch(replaceFreehandInsets([1, 2]));
      store.dispatch(addFreehandInset([5]));
    });

    const items = result.current.visibleClusterItems;
    expect(items).toHaveLength(2);
    expect(memberIdsOf(items[0])).toEqual([1, 2]);
    expect(memberIdsOf(items[1])).toEqual([5]);
    expect(items[0].element.id).not.toBe(items[1].element.id);
  });

  it("survives zoom-cut activation updates that would cull clustered insets", () => {
    const { result } = renderHook(() => useCreateFreehandInsetElements(), { wrapper });

    act(() => {
      store.dispatch(setFreehandMode(true));
      store.dispatch(replaceFreehandInsets([2, 3]));
    });
    expect(result.current.visibleClusterItems).toHaveLength(1);
    const elementId = result.current.visibleClusterItems[0].element.id;

    // A zoom cut replaces the active-cluster set (here: with nothing active).
    // Clustered insets are filtered against this list; freehand insets must not be.
    act(() => {
      store.dispatch(
        setInsetClusteringResults({ activeClusters: [], hierarchyId: 123 })
      );
      store.dispatch(updateInsetActiveClusters([]));
    });

    const items = result.current.visibleClusterItems;
    expect(items).toHaveLength(1);
    expect(items[0].element.id).toBe(elementId);
    expect(memberIdsOf(items[0])).toEqual([2, 3]);
  });

  it("drops unknown member ids instead of failing", () => {
    const { result } = renderHook(() => useCreateFreehandInsetElements(), { wrapper });

    act(() => {
      store.dispatch(setFreehandMode(true));
      store.dispatch(replaceFreehandInsets([4, 999]));
    });

    const items = result.current.visibleClusterItems;
    expect(items).toHaveLength(1);
    expect(memberIdsOf(items[0])).toEqual([4]);
  });
});
