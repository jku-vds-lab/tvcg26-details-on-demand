/**
 * FalloffShapeControl.test.tsx — the field-engine falloff radio (issue #315
 * A3 field-first v2, plan §8). It is now the bare button row hosted inside the
 * Proximity slider's inline unfold (InterestTabSliders owns the disclosure).
 * Rendered on EVERY dataset since the client field lane (issue #315 field
 * parity) — provider-less builds compute the distance field locally; the
 * checked shape mirrors the serverPropagation module store; a click commits
 * the shape AND re-runs propagation via the injected onCommit (the
 * propagation-slider release path).
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react";
import {
  getFalloffShape,
  setFalloffShape,
} from "../../doiPropagation/serverPropagation";
import FalloffShapeControl from "./FalloffShapeControl";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

/** Provider advertising the field engine → the radio renders. */
function withField() {
  scaling.resolveCutProvider.mockReturnValue({ selectPropagateField: jest.fn() });
}
/** Client-complete dataset (or graph-only provider) → the radio is hidden. */
function withoutField() {
  scaling.resolveCutProvider.mockReturnValue(null);
}

const pressed = (el: HTMLElement) => el.getAttribute("aria-pressed");

beforeEach(() => {
  setFalloffShape("log"); // module store persists across tests — reset it
  scaling.resolveCutProvider.mockReturnValue(null);
});

describe("FalloffShapeControl (issue #315 §8)", () => {
  it("renders three options with Logarithmic selected by default", () => {
    withField();
    const { getByRole, queryByRole } = render(
      <FalloffShapeControl onCommit={jest.fn()} />
    );
    for (const name of [/Logarithmic/, /Plateau/, /Linear/]) {
      expect(getByRole("button", { name })).toBeTruthy();
    }
    // exp/gauss/hop are reachable programmatically but no longer surfaced.
    for (const name of [/Exponential/, /Gaussian/, /Hop-based/]) {
      expect(queryByRole("button", { name })).toBeNull();
    }
    expect(pressed(getByRole("button", { name: /Logarithmic/ }))).toBe("true");
    expect(pressed(getByRole("button", { name: /Linear/ }))).toBe("false");
  });

  it("renders WITHOUT a provider — the client field lane serves it", () => {
    // Issue #315 field parity: provider-less builds compute the distance
    // field locally (runLocalFieldPropagation), so the radio is universal.
    withoutField();
    const { getByRole } = render(<FalloffShapeControl onCommit={jest.fn()} />);
    for (const name of [/Logarithmic/, /Plateau/, /Linear/]) {
      expect(getByRole("button", { name })).toBeTruthy();
    }
    expect(pressed(getByRole("button", { name: /Logarithmic/ }))).toBe("true");
  });

  it("commits the new shape and fires the commit handler once on click", () => {
    withField();
    const onCommit = jest.fn();
    const { getByRole } = render(
      <FalloffShapeControl onCommit={onCommit} />
    );

    fireEvent.click(getByRole("button", { name: /Linear/ }));

    expect(getFalloffShape()).toBe("linear");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(pressed(getByRole("button", { name: /Linear/ }))).toBe("true");
    expect(pressed(getByRole("button", { name: /Logarithmic/ }))).toBe("false");
  });

  it("reflects an external shape change via the store subscription", () => {
    withField();
    const { getByRole } = render(
      <FalloffShapeControl onCommit={jest.fn()} />
    );

    act(() => {
      setFalloffShape("plateau");
    });

    expect(pressed(getByRole("button", { name: /Plateau/ }))).toBe("true");
    expect(pressed(getByRole("button", { name: /Logarithmic/ }))).toBe("false");
  });
});
