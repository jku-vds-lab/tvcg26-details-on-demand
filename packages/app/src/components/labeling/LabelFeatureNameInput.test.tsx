/**
 * Issue #352: the feature-name field must be clearable while typing; the
 * store is only updated on blur / Enter, so an empty draft never snaps back.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react";
import React from "react";
import { LabelFeatureNameInput } from "./LabelFeatureNameInput";

function renderInput(value = "algo") {
  const onCommit = jest.fn();
  const utils = render(
    <LabelFeatureNameInput value={value} placeholder="algo" onCommit={onCommit} />,
  );
  const input = utils.container.querySelector("#label-feature-name") as HTMLInputElement;
  return { ...utils, input, onCommit };
}

describe("LabelFeatureNameInput", () => {
  it("shows the resolved value and lets the user empty the field", () => {
    const { input, onCommit } = renderInput();
    expect(input.value).toBe("algo");

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "dig" } });
    expect(input.value).toBe("dig");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits the trimmed draft on blur", () => {
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: " digit " } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("digit");
  });

  it("commits an empty draft on Enter (back to the dataset default)", () => {
    const { input, onCommit } = renderInput();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("");
    // Draft is dropped after the commit: the field follows the prop again.
    expect(input.value).toBe("algo");
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("follows the prop when the store changes elsewhere", () => {
    const { input, rerender, onCommit } = renderInput();
    rerender(<LabelFeatureNameInput value="digit" placeholder="algo" onCommit={onCommit} />);
    expect(input.value).toBe("digit");
  });
});
