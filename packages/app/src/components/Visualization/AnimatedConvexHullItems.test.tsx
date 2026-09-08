/**
 * components/Visualization/AnimatedConvexHullItems.test.tsx
 *
 * Issue #265 regression: a hull created by reconcileClusterItems mounts with
 * the constructor-default currentCssScale (1); the corrective setCssScale
 * effect only runs after the commit that already baked the hull path, so at
 * zoom k the padding rendered k× oversized until the next zoom/pan re-render.
 * The component must therefore bake the path from its explicit cssScale prop
 * on the very first render, never from the hull's stored field.
 */

import { describe, expect, it, jest } from "@jest/globals";

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
import { createEmptyDataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { ClusterConvexHull } from "src/models/ClusterConvexHull";
import store, { initialClusterSettings, updateClusterSettings } from "src/store";
import { AnimatedConvexHullItems } from "./AnimatedConvexHullItems";

function mkPoint(id: number, x: number, y: number): DataPoint {
  return {
    ...createEmptyDataPoint(),
    id,
    x,
    y,
    DoI: 1,
    doiGroup: "inset" as const,
  };
}

// Identity scales: data coords == screen coords.
const xScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);
const yScale = d3.scaleLinear().domain([0, 100]).range([0, 100]);
const scales = { xScale, yScale };

/** Distance of the path's `M` start point (an on-curve hull anchor) from (cx, cy). */
function mStartRadius(d: string, cx: number, cy: number): number {
  const m = /^M\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)/.exec(d);
  expect(m).not.toBeNull();
  return Math.hypot(parseFloat(m![1]) - cx, parseFloat(m![2]) - cy);
}

describe("AnimatedConvexHullItems — explicit cssScale (issue #265)", () => {
  it("bakes the first-mount path from the cssScale prop, not the hull's stored field", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("hull-inset-1", [mkPoint(1, 50, 50)]);
    // Bug precondition: the setCssScale effect has not run yet.
    expect(hull.currentCssScale).toBe(1);

    const { container } = render(
      <Provider store={store}>
        <AnimatedConvexHullItems
          hulls={[hull]}
          scales={scales}
          canvasWidth={100}
          canvasHeight={100}
          cssScale={0.25}
          spotlightUids={null}
        />
      </Provider>
    );

    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    // Singleton circle radius must be paddingPx × cssScale prop = 3, not
    // paddingPx × currentCssScale = 12 (the stuck-oversized bug).
    expect(mStartRadius(path!.getAttribute("d")!, 50, 50)).toBeCloseTo(3, 3);
  });

  it("recomputes the path when only cssScale changes (same hulls array identity)", () => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings, hullPaddingPx: 12 }));
    const hull = new ClusterConvexHull("hull-inset-2", [mkPoint(1, 50, 50)]);
    const hulls = [hull]; // stable identity: exercises the memo dep + React.memo comparator

    const ui = (cssScale: number) => (
      <Provider store={store}>
        <AnimatedConvexHullItems
          hulls={hulls}
          scales={scales}
          canvasWidth={100}
          canvasHeight={100}
          cssScale={cssScale}
          spotlightUids={null}
        />
      </Provider>
    );

    const { container, rerender } = render(ui(0.25));
    expect(mStartRadius(container.querySelector("path")!.getAttribute("d")!, 50, 50)).toBeCloseTo(3, 3);

    rerender(ui(0.5));
    expect(mStartRadius(container.querySelector("path")!.getAttribute("d")!, 50, 50)).toBeCloseTo(6, 3);
  });
});
