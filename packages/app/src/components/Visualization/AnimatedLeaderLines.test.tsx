/**
 * components/Visualization/AnimatedLeaderLines.test.tsx
 *
 * Issue #345 regression: leader geometry is baked at render time, and the
 * component's only other re-render trigger is an annealer position change.
 * It must therefore (1) pass its explicit cssScale prop into
 * LeaderLineConnector.compute (never rely on the hull's stored
 * currentCssScale, which lags the settled zoom by one commit), and (2)
 * re-render when ONLY cssScale changes — the memo comparator must include
 * it, otherwise leaders stay anchored on a hull padded for an earlier zoom
 * level until the next annealer tick (which may never come), the
 * off-screen leader-line bug.
 */

import { describe, expect, it, jest, afterEach } from "@jest/globals";

// Mock rbush (ESM, pulled in via dataPreprocessing) to avoid transform issues.
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
import { render } from "@testing-library/react";
import * as d3 from "d3";
import React from "react";
import { Provider } from "react-redux";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { ClusterConvexHull } from "src/models/ClusterConvexHull";
import { VisualElement, VisualElementType, makeElementId } from "src/models/VisualElement";
import { LeaderLineConnector } from "src/services/leaderLineConnector";
import store, { initialClusterSettings, updateClusterSettings } from "src/store";
import { AnimatedLeaderLines } from "./AnimatedLeaderLines";

const makePoint = (x: number, y: number): DataPoint =>
  ({
    x,
    y,
    line: 0,
    algo: "test",
    id: 0,
    action: "none",
    DoI: 1,
    nextEdgeCenter: { x, y },
  } as unknown as DataPoint);

// Identity scales: data coords == screen coords.
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);
const scales = { xScale, yScale };

describe("AnimatedLeaderLines — explicit cssScale (issue #345)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the cssScale prop to LeaderLineConnector.compute and recomputes when only cssScale changes", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("hull-inset-345c", [makePoint(50, 50)]);
    const el = new VisualElement(
      makeElementId("node", VisualElementType.Annotation, "test-345"),
      "node",
      VisualElementType.Annotation,
      1,
      0,
      "dummy",
      [makePoint(79, 50), makePoint(81, 50)]
    );
    el.center = { x: 80, y: 50 };
    const items = [{ element: el, hull }]; // stable identity: exercises the memo comparator

    const spy = jest.spyOn(LeaderLineConnector, "compute");

    const ui = (cssScale: number) => (
      <Provider store={store}>
        <AnimatedLeaderLines
          items={items}
          scales={scales}
          canvasWidth={100}
          canvasHeight={100}
          cssScale={cssScale}
          spotlightUids={null}
        />
      </Provider>
    );

    const { rerender } = render(ui(0.25));
    expect(spy).toHaveBeenCalled();
    // 6th arg is the explicit cssScale — the prop, not hull.currentCssScale (still 1).
    expect(spy.mock.calls[spy.mock.calls.length - 1][5]).toBe(0.25);

    const callsAfterMount = spy.mock.calls.length;
    rerender(ui(0.5)); // same items identity — only cssScale changed
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);
    expect(spy.mock.calls[spy.mock.calls.length - 1][5]).toBe(0.5);
  });
});
