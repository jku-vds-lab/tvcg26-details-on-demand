import { describe, expect, it, jest } from "@jest/globals";
import {
  getLiveSliderSettings,
  setLiveSliderSettings,
  subscribeLiveSliderSettings,
} from "./liveSliderSettingsStore";

describe("liveSliderSettingsStore", () => {
  it("notifies subscribers on value changes and exposes the new snapshot", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeLiveSliderSettings(listener);

    const next = {
      ...getLiveSliderSettings(),
      proximitySlider: 0.42,
    };
    setLiveSliderSettings(next);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLiveSliderSettings().proximitySlider).toBe(0.42);
    // Snapshot is a copy — mutating the input must not leak in.
    next.proximitySlider = 0.99;
    expect(getLiveSliderSettings().proximitySlider).toBe(0.42);

    unsubscribe();
    setLiveSliderSettings({ ...getLiveSliderSettings(), pastSlider: 0.1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify when every value is unchanged (drag-echo no-op)", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeLiveSliderSettings(listener);

    setLiveSliderSettings({ ...getLiveSliderSettings() });

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
