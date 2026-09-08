/**
 * Issue #352: the majority-vote label cache is keyed by samples identity +
 * column, and the labeling write-back invalidates it. Without either, a
 * cluster whose membership did not change keeps its old annotation text
 * after a column change or a label assignment until the next re-cluster.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import { render } from "@testing-library/react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import store, { setAnnotationLabelFeature } from "src/store";
import { ASSIGNED_LABEL_OVERRIDE_FEATURE, invalidateGroupLabelCache } from "./BaseInsetRenderer";
import { DefaultDatasetRenderer } from "./DefaultDatasetRenderer";

const makeSample = (id: number): DataPoint =>
  ({
    x: 0,
    y: 0,
    line: 0,
    id,
    action: "F",
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    label: "walk",
    phase: "cross",
    features: {},
  }) as unknown as DataPoint;

const textOf = (jsx: JSX.Element): string => {
  const { container } = render(jsx);
  return container.querySelector("text")?.textContent ?? "";
};

afterEach(() => {
  store.dispatch(setAnnotationLabelFeature(null));
});

describe("group label cache", () => {
  it("keys the vote by the label column", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [makeSample(1), makeSample(2), makeSample(3)];

    expect(textOf(renderer.renderGroupNodeAnnotation(samples))).toContain("walk");
    store.dispatch(setAnnotationLabelFeature("phase"));
    expect(textOf(renderer.renderGroupNodeAnnotation(samples))).toContain("cross");
  });

  it("re-resolves the assigned-label overrides once invalidated", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [makeSample(1), makeSample(2), makeSample(3)];
    expect(textOf(renderer.renderGroupNodeAnnotation(samples))).toContain("walk");

    // The write-back mutates the rows in place; the samples array is the same.
    samples.forEach((s) => {
      s.features![ASSIGNED_LABEL_OVERRIDE_FEATURE] = "run";
    });
    expect(textOf(renderer.renderGroupNodeAnnotation(samples))).toContain("walk");

    invalidateGroupLabelCache();
    expect(textOf(renderer.renderGroupNodeAnnotation(samples))).toContain("run");
  });
});
