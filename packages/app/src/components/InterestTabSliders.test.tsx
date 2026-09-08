/**
 * InterestTabSliders.test.tsx — the falloff radio now hangs off the Proximity
 * slider's inline unfold arrow (issue #315, CS 2026-07-24). Since the client
 * field lane (issue #315 field parity) it appears on EVERY dataset —
 * provider-less builds compute the distance field locally. The arrow is
 * collapsed by default and reveals the three shapes; picking one re-runs the
 * propagation commit with the current slider settings (the Proximity-release
 * path, via onSliderChangeCommitted).
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react";
import { setFalloffShape } from "../doiPropagation/serverPropagation";
import InterestTabSliders from "./InterestTabSliders";

// The feature-search child pulls worker/search machinery — stub it out.
jest.mock("./FeatureSearchInput", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

/** Provider advertising the field engine → the falloff unfold appears. */
function withField() {
  scaling.resolveCutProvider.mockReturnValue({ selectPropagateField: jest.fn() });
}
/** Client-complete dataset → no unfold arrow, no falloff row. */
function withoutField() {
  scaling.resolveCutProvider.mockReturnValue(null);
}

function renderSliders(overrides: Record<string, unknown> = {}) {
  return render(
    <InterestTabSliders
      initialProximity={0.5}
      initialPast={0.5}
      initialFuture={0.5}
      initialDoiThresholds={[0.05, 0.7, 0.9]}
      onSliderChange={jest.fn() as never}
      featureSearchDeps={{} as never}
      hideFeatureSearch
      {...overrides}
    />
  );
}

beforeEach(() => {
  setFalloffShape("log"); // module store persists across tests — reset it
  scaling.resolveCutProvider.mockReturnValue(null);
});

describe("InterestTabSliders falloff unfold (issue #315)", () => {
  it("collapses the falloff options behind the Proximity unfold arrow by default", () => {
    withField();
    const { getByLabelText } = renderSliders();
    const arrow = getByLabelText("Proximity details");
    expect(arrow.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals the three falloff options when the arrow is unfolded", () => {
    withField();
    const { getByLabelText, getByRole } = renderSliders();
    fireEvent.click(getByLabelText("Proximity details"));
    expect(getByLabelText("Proximity details").getAttribute("aria-expanded")).toBe("true");
    for (const name of [/Logarithmic/, /Plateau/, /Linear/]) {
      expect(getByRole("button", { name })).toBeTruthy();
    }
  });

  it("fires the commit handler with current settings when Linear is picked", () => {
    withField();
    const onSliderChangeCommitted = jest.fn();
    const { getByLabelText, getByRole } = renderSliders({ onSliderChangeCommitted });
    fireEvent.click(getByLabelText("Proximity details"));

    fireEvent.click(getByRole("button", { name: /Linear/ }));

    expect(onSliderChangeCommitted).toHaveBeenCalledTimes(1);
    expect(onSliderChangeCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ proximitySlider: 0.5 })
    );
  });

  it("shows the Proximity unfold arrow on client-complete datasets too", () => {
    // Issue #315 field parity: provider-less builds compute the distance
    // field locally (runLocalFieldPropagation), so the falloff disclosure is
    // universal — the previous no-provider suppression is retired.
    withoutField();
    const { getByLabelText, getByRole } = renderSliders();
    fireEvent.click(getByLabelText("Proximity details"));
    for (const name of [/Logarithmic/, /Plateau/, /Linear/]) {
      expect(getByRole("button", { name })).toBeTruthy();
    }
  });
});
