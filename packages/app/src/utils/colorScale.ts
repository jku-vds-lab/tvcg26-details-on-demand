import store from "../store";
import { recordDiscoveredKey, resetDiscovery } from "./colorDiscoveryStore";
import { compareCategoryValue } from "./featureKind";

type FeatureStats = {
  variableType?: "categorical" | "sequential" | "diverging" | "boolean" | "unknown";
  min?: number;
  max?: number;
  hasNegative?: boolean;
  hasPositive?: boolean;
  uniqueCount?: number;
  categories?: { value: string; count: number }[];
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
};

const interpolateHex = (a: string, b: string, t: number): string => {
  const ca = hexToRgb(a) ?? { r: 0, g: 0, b: 0 };
  const cb = hexToRgb(b) ?? { r: 0, g: 0, b: 0 };
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bch = Math.round(ca.b + (cb.b - ca.b) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bch
    .toString(16)
    .padStart(2, "0")}`;
};

const samplePalette = (palette: string[], t: number): string => {
  if (palette.length === 0) return "#000000";
  if (palette.length === 1) return palette[0];
  const clamped = Math.max(0, Math.min(1, t));
  // Explicitly guard the upper bound so floating-point imprecision can never
  // cause t=1 to be binned into an interpolation segment that wraps back to
  // palette[0] (which is the minimum color for sequential palettes).
  if (clamped >= 1) return palette[palette.length - 1];
  const x = clamped * (palette.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const left = palette[i];
  const right = palette[i + 1];
  return interpolateHex(left, right, f);
};

const makeFeatureSignature = (): string => {
  const state = store.getState();
  const key = state.visualizationSettings.colorEncoding;
  const s = state.datasetFeatures.statsByKey[key] as FeatureStats | undefined;
  if (!s) return `${key}|none`;
  return [
    key,
    s.variableType ?? "unknown",
    s.min ?? "na",
    s.max ?? "na",
    s.hasNegative ? 1 : 0,
    s.hasPositive ? 1 : 0,
    // The category set drives the prebuilt key → palette-slot mapping, so a
    // category change with identical type/min/max must rebuild too — the
    // dataset-switch case where both datasets carry a categorical column of
    // the same name (2026-08-05 "algo" bug: rubik → chess never rebuilt).
    s.categories ? s.categories.map((c) => c.value).join(",") : "nocats",
  ].join("|");
};

/**
 * Factory function to create a new color scale instance from a given palette.
 * It returns a function that maps a key (number or string) to a color.
 */
export function createColorScale(palette: string[]): (key: string | number) => string {
  const state = store.getState();
  const encoding = state.visualizationSettings.colorEncoding;
  const stats = state.datasetFeatures.statsByKey[encoding] as FeatureStats | undefined;
  const supportsNumericDomain =
    !!stats &&
    (stats.variableType === "sequential" || stats.variableType === "diverging") &&
    Number.isFinite(stats.min) &&
    Number.isFinite(stats.max) &&
    (stats.max ?? 0) > (stats.min ?? 0);

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  const mapping: Record<string, number> = {};
  let nextIndex = 0;
  const rawCats = stats?.categories;
  if (rawCats && rawCats.length > 0) {
    const sorted = [...rawCats].sort((a, b) => compareCategoryValue(a.value, b.value));
    for (const cat of sorted) {
      mapping[cat.value] = nextIndex;
      nextIndex = (nextIndex + 1) % palette.length;
    }
  }
  return (key: string | number): string => {
    if (typeof key === "number" && Number.isFinite(key)) {
      if (supportsNumericDomain && stats) {
        const min = stats.min as number;
        const max = stats.max as number;
        if (stats.variableType === "diverging" && (stats.hasNegative || stats.hasPositive)) {
          const neg = min < 0 ? min : 0;
          const pos = max > 0 ? max : 0;
          if (key <= 0 && neg < 0) {
            return samplePalette(palette, 0.5 * (1 - clamp01(key / neg)));
          }
          if (key > 0 && pos > 0) {
            return samplePalette(palette, 0.5 + 0.5 * clamp01(key / pos));
          }
          return samplePalette(palette, 0.5);
        }
        return samplePalette(palette, (key - min) / (max - min));
      }
      const strKey = String(Math.trunc(key));
      if (!(strKey in mapping)) {
        mapping[strKey] = nextIndex;
        nextIndex = (nextIndex + 1) % palette.length;
        recordDiscoveredKey(strKey);
      }
      return palette[mapping[strKey]];
    }
    if (!(key in mapping)) {
      mapping[key] = nextIndex;
      nextIndex = (nextIndex + 1) % palette.length;
      recordDiscoveredKey(String(key));
    }
    return palette[mapping[key]];
  };
}

/**
 * Allocation-free numeric color sampler (issue #315 color-by freeze): the
 * per-point string pipeline (samplePalette → hex build → regex parse) cost
 * ~0.6 s per 1M-point rebuild, and the hex round-trip exists only because
 * the scale API speaks CSS colors. For encodings with a numeric domain the
 * renderer writes normalized RGB straight into its Float32Array through
 * this ramp instead. writeRgb01 MUST stay value-identical to
 * `encodeColorToVec3(colorScale(key))` — per channel:
 * `Math.round(lerp)/255` — which `colorScale.numericRamp.test.ts` pins.
 */
export interface NumericColorRamp {
  /** Write the color of finite numeric `key` into out[base..base+2] (0..1). */
  writeRgb01(key: number, out: Float32Array, base: number): void;
}

/**
 * The ramp for `encoding`, or null when the current stats give it no numeric
 * domain (categorical/boolean/unknown, missing stats, min ≥ max) — callers
 * then keep the string scale. Mirrors createColorScale's
 * `supportsNumericDomain` branch exactly, including the diverging split.
 */
export function resolveNumericColorRamp(encoding: string): NumericColorRamp | null {
  const state = store.getState();
  const stats = state.datasetFeatures.statsByKey[encoding] as FeatureStats | undefined;
  if (
    !stats ||
    (stats.variableType !== "sequential" && stats.variableType !== "diverging") ||
    !Number.isFinite(stats.min) ||
    !Number.isFinite(stats.max) ||
    (stats.max ?? 0) <= (stats.min ?? 0)
  ) {
    return null;
  }
  const palette = state.visualizationSettings.colorPalette;
  const rgb = palette.map((hex) => hexToRgb(hex) ?? { r: 0, g: 0, b: 0 });
  const min = stats.min as number;
  const max = stats.max as number;
  const diverging = stats.variableType === "diverging" && (stats.hasNegative || stats.hasPositive);
  const neg = min < 0 ? min : 0;
  const pos = max > 0 ? max : 0;
  const segments = rgb.length - 1;

  const writeSample = (t: number, out: Float32Array, base: number): void => {
    if (rgb.length === 0) {
      out[base] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      return;
    }
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    if (rgb.length === 1 || clamped >= 1) {
      const c = rgb[rgb.length - 1];
      out[base] = c.r / 255;
      out[base + 1] = c.g / 255;
      out[base + 2] = c.b / 255;
      return;
    }
    const x = clamped * segments;
    const i = Math.floor(x);
    const f = x - i;
    const a = rgb[i];
    const b = rgb[i + 1];
    // Math.round per channel mirrors interpolateHex's byte quantization, so
    // the ramp is bit-equal to the string pipeline after /255.
    out[base] = Math.round(a.r + (b.r - a.r) * f) / 255;
    out[base + 1] = Math.round(a.g + (b.g - a.g) * f) / 255;
    out[base + 2] = Math.round(a.b + (b.b - a.b) * f) / 255;
  };

  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

  return {
    writeRgb01(key: number, out: Float32Array, base: number): void {
      let t: number;
      if (diverging) {
        if (key <= 0 && neg < 0) t = 0.5 * (1 - clamp01(key / neg));
        else if (key > 0 && pos > 0) t = 0.5 + 0.5 * clamp01(key / pos);
        else t = 0.5;
      } else {
        t = (key - min) / (max - min);
      }
      writeSample(t, out, base);
    },
  };
}

// Rebuild listeners (issue #315 dataset-switch recolor): whenever the scale
// instance is replaced, the category → palette-slot MAPPING may have changed —
// stats landing for the current encoding re-sorts it — and every cached color
// buffer built with the old instance is stale. The renderer subscribes and
// recolors; palette/encoding switches also reach it through the settings diff,
// which is fine (the dirty flags are idempotent).
const scaleRebuildListeners = new Set<() => void>();
let scaleVersion = 0;

const notifyScaleRebuild = (): void => {
  scaleVersion++;
  for (const listener of scaleRebuildListeners) listener();
};

/** Subscribe to color-scale rebuilds; returns the unsubscribe function. */
export function onColorScaleRebuild(listener: () => void): () => void {
  scaleRebuildListeners.add(listener);
  return () => {
    scaleRebuildListeners.delete(listener);
  };
}

/** useSyncExternalStore adapter over scale rebuilds, for components whose
 * render output reads `colorScale(key)` (the legend swatches). */
export const colorScaleStore = {
  subscribe: (cb: () => void): (() => void) => onColorScaleRebuild(cb),
  getSnapshot: (): number => scaleVersion,
} as const;

// Module-level variable holding the current color scale instance.
let currentColorScale = createColorScale(store.getState().visualizationSettings.colorPalette);
let lastPaletteSignature = JSON.stringify(store.getState().visualizationSettings.colorPalette);
let lastColorEncoding = store.getState().visualizationSettings.colorEncoding;
let lastFeatureSignature = makeFeatureSignature();

store.subscribe(() => {
  const { visualizationSettings } = store.getState();
  const paletteSignature = JSON.stringify(visualizationSettings.colorPalette);
  const featureSignature = makeFeatureSignature();
  const hardReset =
    paletteSignature !== lastPaletteSignature ||
    visualizationSettings.colorEncoding !== lastColorEncoding;
  if (!hardReset && featureSignature === lastFeatureSignature) return;

  lastPaletteSignature = paletteSignature;
  lastColorEncoding = visualizationSettings.colorEncoding;
  lastFeatureSignature = featureSignature;

  if (hardReset) {
    // Palette/encoding switches also mark the renderer's color+count passes
    // dirty, so discovery re-derives itself right after this wipe.
    resetColorScale(visualizationSettings.colorPalette);
  } else {
    // Feature-signature-only change: the progressive stats scan refined
    // min/max/type of the SAME encoding on the SAME dataset (or the encoding
    // key survived a dataset switch and the NEW dataset's stats just landed).
    // Rebuild the scale so numeric domains and the category mapping pick up
    // the new stats; keep discovered keys and full-dataset counts — wiping
    // here permanently drops legend rows for category values that only occur
    // past the stats scan cap.
    currentColorScale = createColorScale(visualizationSettings.colorPalette);
    // The rebuilt mapping can disagree with every color buffer built before
    // it (the 2026-08-05 dataset-switch bug: chess GPU colors keyed under the
    // previous dataset's "algo" mapping while the legend showed the new one).
    notifyScaleRebuild();
  }
});

/**
 * Returns a color for the given key using the current color scale instance.
 */
export function colorScale(key: string | number): string {
  return currentColorScale(key);
}

/**
 * Resets the current color scale instance using the provided palette.
 * Call this function whenever a new dataset is loaded to ensure the color mapping
 * starts fresh. This does not affect the internal caching in the WebGL renderer,
 * since that cache is local to its update function and is reallocated on dataset load.
 */
export function resetColorScale(palette: string[]): void {
  resetDiscovery();
  currentColorScale = createColorScale(palette);
  notifyScaleRebuild();
}
