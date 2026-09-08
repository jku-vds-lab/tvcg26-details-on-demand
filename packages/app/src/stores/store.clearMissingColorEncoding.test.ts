/**
 * clearMissingColorEncoding (issue #315 color-by UX): visual presets prefill
 * the color encoding per dataset TYPE, but a dataset may lack that column
 * ("algo" on synth1m) — the load-time validation clears it so the panel
 * never shows a selected feature that colors nothing. Dispatched once per
 * load with the micro-scan's key set.
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import store, {
  clearMissingColorEncoding,
  initialVisualizationSettings,
  updateSettings,
} from "../store";

const encoding = () => store.getState().visualizationSettings.colorEncoding;

beforeEach(() => {
  store.dispatch(updateSettings(initialVisualizationSettings));
});

describe("clearMissingColorEncoding", () => {
  it("clears an encoding the dataset does not have", () => {
    store.dispatch(updateSettings({ colorEncoding: "algo" }));
    store.dispatch(clearMissingColorEncoding(["line", "id", "reward", "step"]));
    expect(encoding()).toBe("");
  });

  it("keeps an encoding the dataset has", () => {
    store.dispatch(updateSettings({ colorEncoding: "algo" }));
    store.dispatch(clearMissingColorEncoding(["algo", "reward"]));
    expect(encoding()).toBe("algo");
  });

  it("never touches DoI (runtime column) or an already-empty encoding", () => {
    store.dispatch(updateSettings({ colorEncoding: "DoI" }));
    store.dispatch(clearMissingColorEncoding(["reward"]));
    expect(encoding()).toBe("DoI");

    store.dispatch(updateSettings({ colorEncoding: "" }));
    store.dispatch(clearMissingColorEncoding(["reward"]));
    expect(encoding()).toBe("");
  });
});
