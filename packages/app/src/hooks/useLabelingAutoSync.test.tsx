/**
 * Issue #352: a change of the resolved label column (from either input)
 * re-imports the assignments AND rewrites the per-row `__assignedLabel`
 * overrides, which the renderers prefer over the column. The first run on a
 * set of rows only imports — fresh rows carry no overrides to rewrite.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react";

// Mock rbush (ESM) to avoid transform issues in Jest; the hook only needs
// the module graph (lazyRows) to load.
jest.mock("rbush", () => ({
  __esModule: true,
  default: class RBushMock {
    private items: unknown[] = [];
    load(arr: unknown[]) { this.items.push(...arr); }
    clear() { this.items.length = 0; }
    all() { return this.items; }
    insert(item: unknown) { this.items.push(item); }
    search() { return this.items; }
  },
}));
import React from "react";
import { Provider } from "react-redux";
import { ASSIGNED_LABEL_OVERRIDE_FEATURE } from "../components/Visualization/Details/BaseInsetRenderer";
import { DataProvider, useDataRef } from "../contexts/DataContext";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { clearAllAssignments, importLabels } from "../slices/labelingSlice";
import store, { setAnnotationLabelFeature, setDatasetMetadata } from "../store";
import { syncAssignmentsIntoVisualizationImpl } from "./useLabeling";
import { useLabelingAutoSync } from "./useLabelingAutoSync";

const makePoint = (id: number, label: string, phase: string): DataPoint =>
  ({ id, x: 0, y: 0, line: 0, label, phase, features: { [ASSIGNED_LABEL_OVERRIDE_FEATURE]: "stale" } }) as unknown as DataPoint;

function Harness({ points }: { points: DataPoint[] }) {
  useDataRef().current = points;
  useLabelingAutoSync();
  return null;
}

const assignments = () => Object.fromEntries(store.getState().labeling.assignments);
const overrideOf = (p: DataPoint) => p.features?.[ASSIGNED_LABEL_OVERRIDE_FEATURE];

beforeEach(() => {
  act(() => {
    store.dispatch(setDatasetMetadata({ datasetType: "default", datasetPath: "" }));
    store.dispatch(setAnnotationLabelFeature(null));
    store.dispatch(clearAllAssignments());
  });
});

afterEach(() => {
  act(() => {
    store.dispatch(setAnnotationLabelFeature(null));
    store.dispatch(clearAllAssignments());
  });
});

describe("useLabelingAutoSync", () => {
  it("imports from the resolved column on mount without touching row overrides", () => {
    const points = [makePoint(1, "walk", "cross"), makePoint(2, "run", "edges")];
    render(
      <Provider store={store}>
        <DataProvider>
          <Harness points={points} />
        </DataProvider>
      </Provider>,
    );
    expect(assignments()).toEqual({ "1": "walk", "2": "run" });
    expect(overrideOf(points[0])).toBe("stale");
  });

  it("re-imports and rewrites the row overrides when the column changes", () => {
    const points = [makePoint(1, "walk", "cross"), makePoint(2, "run", "edges")];
    render(
      <Provider store={store}>
        <DataProvider>
          <Harness points={points} />
        </DataProvider>
      </Provider>,
    );

    act(() => {
      store.dispatch(setAnnotationLabelFeature("phase"));
    });

    expect(assignments()).toEqual({ "1": "cross", "2": "edges" });
    expect(overrideOf(points[0])).toBe("cross");
    expect(overrideOf(points[1])).toBe("edges");
  });

  it("keeps session edits across a column round-trip (A → B → A)", () => {
    // Columnar rows carry the raw columns top-level and no features bag.
    const raw = (id: number, phase: string, algo: string): DataPoint =>
      ({ id, x: 0, y: 0, line: 0, phase, algo }) as unknown as DataPoint;
    const points = [raw(1, "cross", "cfop"), raw(2, "edges", "roux")];
    render(
      <Provider store={store}>
        <DataProvider>
          <Harness points={points} />
        </DataProvider>
      </Provider>,
    );
    act(() => {
      store.dispatch(setAnnotationLabelFeature("phase"));
    });
    expect(assignments()).toEqual({ "1": "cross", "2": "edges" });

    // Overwrite one phase label the way the panel's assign does.
    act(() => {
      store.dispatch(importLabels({ "1": "f2l" }));
      syncAssignmentsIntoVisualizationImpl(points, store.dispatch, "phase");
    });

    act(() => {
      store.dispatch(setAnnotationLabelFeature("algo"));
    });
    // B shows its raw values, untouched by A's edit.
    expect(assignments()).toEqual({ "1": "cfop", "2": "roux" });
    expect((points[0] as unknown as { algo: string }).algo).toBe("cfop");

    act(() => {
      store.dispatch(setAnnotationLabelFeature("phase"));
    });
    // Edited row shows the edit, the untouched row its raw value; the row
    // overrides the renderers read are restored to the same.
    expect(assignments()).toEqual({ "1": "f2l", "2": "edges" });
    expect(overrideOf(points[0])).toBe("f2l");
    expect(overrideOf(points[1])).toBe("edges");
    expect((points[0] as unknown as { phase: string }).phase).toBe("cross");
  });
});
