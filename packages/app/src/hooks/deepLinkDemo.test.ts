import { describe, expect, it } from "@jest/globals";
import {
  DEMO_SLIDER_KEYS,
  pickParameterTab,
  splitVisDiffs,
  WORKFLOW_TAB_CLUSTER_KEYS,
} from "./deepLinkDemo";
import { initialClusterSettings, initialVisualizationSettings } from "../store";

describe("splitVisDiffs", () => {
  it("routes the six slider keys to sliderDiffs and the rest to discreteDiffs", () => {
    const { sliderDiffs, discreteDiffs } = splitVisDiffs({
      proximitySlider: 0.4,
      insetDoiThreshold: 0.7,
      colorEncoding: "line",
      useViewboxForClustering: true,
    });
    expect(sliderDiffs).toEqual({ proximitySlider: 0.4, insetDoiThreshold: 0.7 });
    expect(discreteDiffs).toEqual({ colorEncoding: "line", useViewboxForClustering: true });
  });

  it("returns empty splits for empty diffs", () => {
    expect(splitVisDiffs({})).toEqual({ sliderDiffs: {}, discreteDiffs: {} });
  });

  it("keeps every slider key a real visualization setting", () => {
    for (const key of DEMO_SLIDER_KEYS) {
      expect(key in initialVisualizationSettings).toBe(true);
    }
  });
});

describe("pickParameterTab", () => {
  it("prefers the Workflow tab whenever propagation sliders move", () => {
    expect(pickParameterTab({ proximitySlider: 0.4 }, { doiDensityWeight: 2 })).toBe(0);
  });

  it("stays on the Workflow tab for workflow-exposed cluster budgets", () => {
    expect(pickParameterTab({}, { maxActiveClusters: 4, relationInsetBudget: 4 })).toBe(0);
  });

  it("uses the Advanced tab when any cluster diff is advanced-only", () => {
    expect(pickParameterTab({}, { maxActiveClusters: 4, doiDensityWeight: 2 })).toBe(3);
  });

  it("falls back to Visual encodings for discrete-only diffs", () => {
    expect(pickParameterTab({}, {})).toBe(2);
  });

  it("keeps every workflow-tab key a real cluster setting", () => {
    for (const key of WORKFLOW_TAB_CLUSTER_KEYS) {
      expect(key in initialClusterSettings).toBe(true);
    }
  });
});
