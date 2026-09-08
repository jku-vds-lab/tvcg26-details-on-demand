/**
 * Numeric color ramp (issue #315 color-by freeze): encoding changes at 1M
 * froze the tab for seconds because every point went through the string
 * pipeline (samplePalette hex build + regex re-parse) plus a String()-per-
 * point discovery scan. The ramp writes normalized RGB directly and MUST be
 * value-identical to `encodeColorToVec3(colorScale(key))` — pinned here for
 * sequential and diverging domains, plus the null cases that keep callers
 * on the string scale.
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import store, {
  clearFeatureMetadata,
  initialVisualizationSettings,
  setFeatureMetadata,
  updateSettings,
} from "../store";
import { encodeColorToVec3 } from "../gl/utils/colors";
import { createColorScale, resolveNumericColorRamp } from "./colorScale";

const BLUES_9 = [
  "#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6",
  "#4292c6", "#2171b5", "#08519c", "#08306b",
];
const RDBU_3 = ["#ef8a62", "#f7f7f7", "#67a9cf"];

function setupEncoding(
  variableType: "sequential" | "diverging" | "categorical",
  min: number,
  max: number,
  palette: string[]
) {
  store.dispatch(updateSettings({ colorEncoding: "reward", colorPalette: palette, colorMapRotationOffset: 0 }));
  store.dispatch(
    setFeatureMetadata({
      availableKeys: ["reward"],
      statsByKey: {
        reward: {
          key: "reward",
          variableType,
          uniqueCount: 100,
          totalCount: 1000,
          numericRatio: 1,
          min,
          max,
          hasNegative: min < 0,
          hasPositive: max > 0,
          confidence: "high",
        },
      },
    })
  );
}

function rampRgb(key: number): number[] {
  const ramp = resolveNumericColorRamp("reward");
  expect(ramp).not.toBeNull();
  const out = new Float32Array(3);
  ramp!.writeRgb01(key, out, 0);
  return Array.from(out);
}

function scaleRgb(key: number, palette: string[]): number[] {
  // Both paths land in a Float32Array GPU buffer — compare at that
  // quantization (the ramp writes f32 directly; the string path's f64
  // values were always narrowed on upload).
  return Array.from(
    new Float32Array(encodeColorToVec3(createColorScale(palette)(key), { r: 0, g: 0, b: 0 }))
  );
}

beforeEach(() => {
  store.dispatch(updateSettings(initialVisualizationSettings));
  store.dispatch(clearFeatureMetadata());
});

describe("resolveNumericColorRamp — parity with the string scale", () => {
  it("matches on a sequential domain across the range (incl. clamps)", () => {
    setupEncoding("sequential", 3, 97, BLUES_9);
    const probes = [3, 97, 50, 3.0001, 96.9999, 12.34, 77.7, -5, 120];
    for (const v of probes) {
      expect(rampRgb(v)).toEqual(scaleRgb(v, BLUES_9));
    }
  });

  it("matches on a diverging domain (negative, zero, positive)", () => {
    setupEncoding("diverging", -40, 60, RDBU_3);
    const probes = [-40, -13.5, 0, 0.001, 29, 60, -100, 100];
    for (const v of probes) {
      expect(rampRgb(v)).toEqual(scaleRgb(v, RDBU_3));
    }
  });

  it("matches with a single-color palette", () => {
    setupEncoding("sequential", 0, 1, ["#336699"]);
    for (const v of [0, 0.5, 1]) {
      expect(rampRgb(v)).toEqual(scaleRgb(v, ["#336699"]));
    }
  });

  it("is null for categorical stats, missing stats, and degenerate domains", () => {
    setupEncoding("categorical", 0, 5, BLUES_9);
    expect(resolveNumericColorRamp("reward")).toBeNull();

    setupEncoding("sequential", 7, 7, BLUES_9);
    expect(resolveNumericColorRamp("reward")).toBeNull();

    store.dispatch(clearFeatureMetadata());
    expect(resolveNumericColorRamp("reward")).toBeNull();
    expect(resolveNumericColorRamp("no-such-column")).toBeNull();
  });
});
