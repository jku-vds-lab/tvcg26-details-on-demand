import { describe, expect, it } from "@jest/globals";
import { renderHook } from "@testing-library/react";
import {
  useRehydrateHdbscan,
  useRehydrateMidpointHdbscan,
} from "./useFullSelectionHdbscanInstance";

// Minimal two-leaf hierarchy: enough structure for reuid/indexLeafRanges.
const makeTreeJson = () => ({
  hierarchyTree: {
    uid: "root",
    distance: 1,
    size: 2,
    stability: 1,
    leftChild: { uid: "l", distance: 0, size: 1, stability: 1 },
    rightChild: { uid: "r", distance: 0, size: 1, stability: 1 },
  },
});

describe.each([
  ["useRehydrateHdbscan", useRehydrateHdbscan],
  ["useRehydrateMidpointHdbscan", useRehydrateMidpointHdbscan],
])("%s", (_name, useHook) => {
  it("clears the previous tree when the input goes null", () => {
    const { result, rerender } = renderHook(({ json }: { json: unknown }) => useHook(json), {
      initialProps: { json: makeTreeJson() as unknown },
    });
    expect(result.current?.hierarchyTree).toBeDefined();

    // After an in-app re-projection the precomputed hierarchy is dropped;
    // the hook must not keep serving the stale tree.
    rerender({ json: null });
    expect(result.current).toBeUndefined();
  });

  it("stays undefined when input starts null", () => {
    const { result } = renderHook(() => useHook(null));
    expect(result.current).toBeUndefined();
  });
});
