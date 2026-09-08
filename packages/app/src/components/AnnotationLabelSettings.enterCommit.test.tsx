/**
 * Issue #352: the Visual Encoding "Label feature" picker commits a typed
 * name on Enter / blur just like the labeling panel's field, so the two
 * stay in sync: exact column, else best match, else free text, empty = null.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { Provider } from "react-redux";
import store, { setAnnotationLabelFeature, setAvailableFeatureKeys, setDatasetMetadata } from "../store";
import AnnotationLabelSettings from "./AnnotationLabelSettings";

const feature = () => store.getState().visualizationSettings.annotationLabelFeature;

function renderPicker(): HTMLInputElement {
  render(
    <Provider store={store}>
      <AnnotationLabelSettings defaultExpanded />
    </Provider>,
  );
  return screen.getByLabelText("Label feature") as HTMLInputElement;
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

beforeEach(() => {
  act(() => {
    store.dispatch(setDatasetMetadata({ datasetType: "rubik", datasetPath: "" }));
    store.dispatch(setAvailableFeatureKeys(["algo", "label", "opening", "phase"]));
    store.dispatch(setAnnotationLabelFeature(null));
  });
});

afterEach(() => {
  act(() => {
    store.dispatch(setAnnotationLabelFeature(null));
    store.dispatch(setAvailableFeatureKeys([]));
    store.dispatch(setDatasetMetadata({ datasetType: "default", datasetPath: "" }));
  });
});

describe("AnnotationLabelSettings – displayed value", () => {
  it("shows the resolved dataset default when no override is set", () => {
    const input = renderPicker();
    expect(input.value).toBe("phase");
    act(() => {
      store.dispatch(setAnnotationLabelFeature("algo"));
    });
    expect(input.value).toBe("algo");
  });
});

describe("AnnotationLabelSettings – Enter / blur commit", () => {
  it("commits an exactly typed column on Enter", () => {
    const input = renderPicker();
    type(input, "opening");
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(feature()).toBe("opening");
    expect(input.value).toBe("opening");
  });

  it("commits the highlighted prefix match on Enter", () => {
    const input = renderPicker();
    type(input, "ope");
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(feature()).toBe("opening");
  });

  it("commits an arbitrary name on Enter", () => {
    const input = renderPicker();
    type(input, " my_column ");
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(feature()).toBe("my_column");
  });

  it("commits the best match on blur", () => {
    const input = renderPicker();
    type(input, "lab");
    act(() => {
      fireEvent.blur(input);
    });
    expect(feature()).toBe("label");
    expect(input.value).toBe("label");
  });

  it("clearing the field returns to the dataset default", () => {
    const input = renderPicker();
    act(() => {
      store.dispatch(setAnnotationLabelFeature("algo"));
    });
    expect(input.value).toBe("algo");
    type(input, "");
    expect(input.value).toBe("");
    act(() => {
      fireEvent.blur(input);
    });
    expect(feature()).toBeNull();
    // Back to the resolved default, not an empty box.
    expect(input.value).toBe("phase");
  });
});
