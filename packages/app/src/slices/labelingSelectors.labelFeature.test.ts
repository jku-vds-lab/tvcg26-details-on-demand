/**
 * Issue #352: the labeling panel, the Visual Encoding tab and the inset
 * renderers share ONE label column — `annotationLabelFeature` when set,
 * else the dataset-type default.
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import store, { setAnnotationLabelFeature, setDatasetMetadata } from "../store";
import { getDefaultLabelFeature, selectLabelFeatureName } from "./labelingSelectors";

const resolved = () => selectLabelFeatureName(store.getState());

beforeEach(() => {
  store.dispatch(setAnnotationLabelFeature(null));
  store.dispatch(setDatasetMetadata({ datasetType: "default", datasetPath: "" }));
});

describe("getDefaultLabelFeature", () => {
  it("matches the renderer defaults per dataset type", () => {
    expect(getDefaultLabelFeature("chess")).toBe("algo");
    expect(getDefaultLabelFeature("mnist")).toBe("digit");
    expect(getDefaultLabelFeature("rubik")).toBe("phase");
    expect(getDefaultLabelFeature("cctv")).toBe("label");
    expect(getDefaultLabelFeature("gymnasium")).toBe("label");
    expect(getDefaultLabelFeature("default")).toBe("label");
  });
});

describe("selectLabelFeatureName", () => {
  it("resolves the dataset default when no override is set", () => {
    store.dispatch(setDatasetMetadata({ datasetType: "chess" }));
    expect(resolved()).toBe("algo");
    store.dispatch(setDatasetMetadata({ datasetType: "mnist" }));
    expect(resolved()).toBe("digit");
    store.dispatch(setDatasetMetadata({ datasetType: "default" }));
    expect(resolved()).toBe("label");
  });

  it("picks up a Visual Encoding override on the labeling side", () => {
    store.dispatch(setDatasetMetadata({ datasetType: "chess" }));
    store.dispatch(setAnnotationLabelFeature("opening"));
    expect(resolved()).toBe("opening");
    expect(store.getState().visualizationSettings.annotationLabelFeature).toBe("opening");
  });

  it("falls back to the new dataset default once the override is reset on a switch", () => {
    store.dispatch(setDatasetMetadata({ datasetType: "chess" }));
    store.dispatch(setAnnotationLabelFeature("opening"));
    // useInitialDataset re-applies the visual preset (annotationLabelFeature: null) on every switch.
    store.dispatch(setAnnotationLabelFeature(null));
    store.dispatch(setDatasetMetadata({ datasetType: "mnist" }));
    expect(resolved()).toBe("digit");
  });
});
