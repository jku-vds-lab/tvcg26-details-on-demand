export type DoiThresholds = {
  hidden: number;
  labeled: number;
  inset: number;
};

const DEFAULT_DOI_COLORS = ["#f8b195", "#f67280", "#c06c84", "#6c5b7b", "#355c7d"] as const;

type RGB = [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function sanitizeThresholds(t: DoiThresholds): DoiThresholds {
  const hidden = clamp01(t.hidden);
  const labeled = Math.max(hidden, clamp01(t.labeled));
  const inset = Math.max(labeled, clamp01(t.inset));
  return { hidden, labeled, inset };
}

function hexToRgb(hex: string): RGB {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const six = normalized.length === 3
    ? normalized
        .split("")
        .map((c) => c + c)
        .join("")
    : normalized;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(six);
  if (!match) return [127, 127, 127];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function rgbToHex([r, g, b]: RGB): string {
  const toHex = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const clamped = clamp01(t);
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

function lerpColor(aHex: string, bHex: string, t: number): string {
  return rgbToHex(mixRgb(hexToRgb(aHex), hexToRgb(bHex), t));
}

export function getDoiPaletteStops(palette: string[]): {
  preLabel: string;
  labels: string;
  between: string;
  insets: string;
  max: string;
} {
  const [preLabel, labels, between, insets, max] =
    palette.length >= 5
      ? [
          palette[0],
          palette[1],
          palette[2],
          palette[3],
          palette[4],
        ]
      : [
          DEFAULT_DOI_COLORS[0],
          palette[0] ?? DEFAULT_DOI_COLORS[1],
          palette[1] ?? DEFAULT_DOI_COLORS[2],
          palette[2] ?? DEFAULT_DOI_COLORS[3],
          palette[3] ?? DEFAULT_DOI_COLORS[4],
        ];

  return { preLabel, labels, between, insets, max };
}

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

export function sampleDoiColorAt(
  doiRaw: number,
  thresholdsRaw: DoiThresholds,
  palette: string[]
): string {
  const doi = clamp01(doiRaw);
  const thresholds = sanitizeThresholds(thresholdsRaw);
  const stops = getDoiPaletteStops(palette);

  const tHidden = thresholds.hidden;
  const tLabel = thresholds.labeled;
  const tInset = thresholds.inset;

  if (doi <= tHidden) {
    return stops.preLabel;
  }

  if (doi < tLabel) {
    const denom = Math.max(tLabel - tHidden, 1e-6);
    // Keep sub-label points warm and smooth, then jump at the threshold.
    const preEdge = lerpColor(stops.preLabel, stops.labels, 0.28);
    return lerpColor(stops.preLabel, preEdge, smoothstep01((doi - tHidden) / denom));
  }

  if (doi < tInset) {
    const denom = Math.max(tInset - tLabel, 1e-6);
    // Smooth within label-eligible range, without fading into inset color.
    return lerpColor(stops.labels, stops.between, smoothstep01((doi - tLabel) / denom));
  }

  const denom = Math.max(1 - tInset, 1e-6);
  return lerpColor(stops.insets, stops.max, smoothstep01((doi - tInset) / denom));
}
