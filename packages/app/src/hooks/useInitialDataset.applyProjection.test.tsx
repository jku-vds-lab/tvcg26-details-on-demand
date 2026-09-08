import { describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import store from "src/store";
import type { KnnGraph } from "src/types/graphTypes";
import { useInitialDataset } from "./useInitialDataset";

// Keep computeDefaultsAsync inert: a worker that never answers means no
// stray async dispatches outside act().
jest.mock("../workers/makeMetricsWorker", () => ({
  makeMetricsWorker: () => ({
    onmessage: null,
    onerror: null,
    postMessage: () => {},
    terminate: () => {},
  }),
}));

// These pull in workerFactories (import.meta — not compilable under ts-jest);
// the test never loads a dataset from disk, so stubs suffice.
jest.mock("../dataPreprocessing/DatasetLoader", () => ({
  loadDatasetAuto: () => Promise.reject(new Error("not used in this test")),
}));
jest.mock("../dataPreprocessing/loadSimpleDataset", () => ({
  loadSimpleDataset: () => Promise.reject(new Error("not used in this test")),
}));

const mkPoint = (id: number, x: number, y: number): DataPoint => ({
  x,
  y,
  line: 0,
  algo: "a",
  id,
  action: "",
  DoI: 0.5,
  doiGroup: "annotation",
  selected: true,
  annotationClusterId: 7,
  insetClusterId: 8,
  nextEdgeCenter: { x: 0.5, y: 0.5 },
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>{children}</Provider>
);

const setup = () => {
  const points = [mkPoint(1, 10, 10), mkPoint(2, 20, 20), mkPoint(3, 30, 30)];
  const propKnn: KnnGraph = [
    [0, 1, 2],
    [1, 0, 2],
    [2, 1, 0],
  ];
  const hook = renderHook(() => useInitialDataset(points, propKnn), { wrapper });
  return { points, propKnn, hook };
};

describe("useInitialDataset applyProjection / restoreOriginalProjection", () => {
  it("applies coords in place, returns a new array reference, and clears derived per-point state", () => {
    const { points, hook } = setup();
    expect(hook.result.current.internalData).toBe(points);
    expect(hook.result.current.canRestoreProjection).toBe(false);

    const newKnn: KnnGraph = [
      [0, 2, 1],
      [1, 2, 0],
      [2, 0, 1],
    ];
    act(() => {
      hook.result.current.applyProjection(new Float32Array([1, 2, 3, 4, 5, 6]), newKnn);
    });

    const applied = hook.result.current.internalData;
    expect(applied).not.toBe(points); // new array reference…
    expect(applied?.[0]).toBe(points[0]); // …but the same point objects

    expect(points[0].x).toBe(1);
    expect(points[0].y).toBe(2);
    expect(points[2].x).toBe(5);
    expect(points[2].y).toBe(6);

    for (const p of points) {
      expect(p.nextEdgeCenter).toEqual({ x: 0, y: 0 });
      expect(p.selected).toBe(false);
      expect(p.DoI).toBe(1);
      expect(p.doiGroup).toBeUndefined();
      expect(p.annotationClusterId).toBeUndefined();
      expect(p.insetClusterId).toBeUndefined();
    }

    expect(hook.result.current.internalKnnGraph).toBe(newKnn);
    expect(hook.result.current.internalHdbscan).toBeNull();
    expect(hook.result.current.internalMidpointHdbscan).toBeNull();
    expect(hook.result.current.canRestoreProjection).toBe(true);
  });

  it("ignores coords whose length does not match the point count", () => {
    const { points, hook } = setup();
    act(() => {
      hook.result.current.applyProjection(new Float32Array([1, 2]), []);
    });
    expect(points[0].x).toBe(10);
    expect(hook.result.current.canRestoreProjection).toBe(false);
  });

  it("restores the original coords and kNN graph; the stash survives a second apply", () => {
    const { points, propKnn, hook } = setup();

    act(() => {
      hook.result.current.applyProjection(new Float32Array([1, 2, 3, 4, 5, 6]), []);
    });
    act(() => {
      hook.result.current.applyProjection(new Float32Array([7, 8, 9, 10, 11, 12]), []);
    });
    expect(points[0].x).toBe(7);

    act(() => {
      hook.result.current.restoreOriginalProjection();
    });

    expect(points[0].x).toBe(10);
    expect(points[0].y).toBe(10);
    expect(points[1].x).toBe(20);
    expect(points[2].y).toBe(30);
    // The pre-projection kNN graph reference is restored.
    expect(hook.result.current.internalKnnGraph).toBe(propKnn);
    // Restore keeps the stash so the user can project again and still return.
    expect(hook.result.current.canRestoreProjection).toBe(true);
  });
});
