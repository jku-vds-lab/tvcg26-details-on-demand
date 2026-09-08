import colorbrewer from "colorbrewer";

export type SliderMark = { value: number; label: string };
export type SliderConfig = {
  min: number;
  max: number;
  step: number;
  marks: readonly SliderMark[];
};

export const UI_SPACING = {
  PANEL_SECTION_MB: 3,
} as const;

export const CLUSTER_SETTINGS_PANEL_UI = {
  MAX_ACTIVE_CLUSTERS: {
    THROTTLE_MS: 200,
    SLIDER: {
      min: 0,
      max: 30,
      step: 1,
      marks: [
        { value: 0, label: 'off' },
        { value: 30, label: '30' },
      ],
    } satisfies SliderConfig,
  },

  CLUSTER_SIZE_THRESHOLD: {
    min: 0,
    max: 1,
    step: 0.01,
    marks: [
      { value: 0, label: '0%' },
      { value: 1, label: '100%' },
    ],
  } satisfies SliderConfig,

  CONTOURS: {
    THICKNESS: {
      min: 0,
      max: 10,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 10, label: '10' },
      ],
    } satisfies SliderConfig,

    SHADE: {
      min: 0,
      max: 1,
      step: 0.01,
      marks: [
        { value: 0, label: 'B' },
        { value: 1, label: 'W' },
      ],
    } satisfies SliderConfig,

    STIPPLING: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,

    OUTLINE_THICKNESS: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 10, label: '10' },
      ],
    } satisfies SliderConfig,

    OFFSET_FACTOR: {
      min: 0,
      max: 1,
      step: 0.01,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    OFFSET_PX: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,
  },

  LEADER_LINES: {
    OUTLINE_THICKNESS: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,

    THICKNESS: {
      min: 0,
      max: 10,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 10, label: '10' },
      ],
    } satisfies SliderConfig,

    SHADE: {
      min: 0,
      max: 1,
      step: 0.01,
      marks: [
        { value: 0, label: 'B' },
        { value: 1, label: 'W' },
      ],
    } satisfies SliderConfig,

    DASH_LENGTH: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,

    DASH_GAP: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,
    SHADOW_INTENSITY: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,
  },

  EDGE_ANNOTATIONS: {
    BUDGET: {
      min: 0,
      max: 30,
      step: 1,
      marks: [
        { value: 0, label: 'off' },
        { value: 30, label: '30' },
      ],
    } satisfies SliderConfig,
    HOVER_SCALE: {
      min: 1,
      max: 2,
      step: 0.05,
      marks: [
        { value: 1, label: '1×' },
        { value: 2, label: '2×' },
      ],
    } satisfies SliderConfig,
    SPOTLIGHT_EMPHASIS: {
      min: 0,
      max: 2,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 2, label: '2×' },
      ],
    } satisfies SliderConfig,
  },

  RELATION_LEADERS: {
    ARROW_SIZE_RANGE: {
      min: 0,
      max: 40,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 40, label: '40' },
      ],
    } satisfies SliderConfig,
    LEADER_MIN_WIDTH: {
      min: 0,
      max: 10,
      step: 0.5,
      marks: [
        { value: 0, label: '0' },
        { value: 10, label: '10' },
      ],
    } satisfies SliderConfig,
    SHADOW_INTENSITY: {
      min: 0,
      max: 20,
      step: 1,
      marks: [
        { value: 0, label: '0' },
        { value: 20, label: '20' },
      ],
    } satisfies SliderConfig,
  },

  CLUSTER_SCALING: {
    NODE_INSET_SIZE_RANGE: {
      min: 0.5,
      max: 5,
      step: 0.05,
      marks: [
        { value: 0.5, label: '0.5' },
        { value: 5, label: '5' },
      ],
    } satisfies SliderConfig,

    NODE_SCALE_EXPONENT: {
      min: 0.1,
      max: 1,
      step: 0.01,
      marks: [
        { value: 0.1, label: '0.1' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    EDGE_INSET_SIZE_RANGE: {
      min: 0.5,
      max: 5,
      step: 0.05,
      marks: [
        { value: 0.5, label: '0.5' },
        { value: 5, label: '5' },
      ],
    } satisfies SliderConfig,

    EDGE_SCALE_EXPONENT: {
      min: 0.1,
      max: 1,
      step: 0.01,
      marks: [
        { value: 0.1, label: '0.1' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,
  },

  ANIMATIONS: {
    DURATION_SECONDS: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,
  },

  // ── Semantic-zoom (footprint-based hierarchy cut) ────────────────────────
  SEMANTIC_ZOOM: {
    // Fraction of the view area; 9% ≈ the old 100k px² slider max on the
    // calibration canvas (100 000 / 1 150 000 ≈ 0.087).
    SPLIT_THRESHOLD_FRACTION: {
      min: 0,
      max: 0.09,
      step: 0.0005,
      marks: [
        { value: 0,    label: '0' },
        { value: 0.09, label: '9%' },
      ],
    } satisfies SliderConfig,

    LABEL_MIN_THRESHOLD_PX: {
      min: 0,
      max: 2,
      step: 0.01,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1×' },
        { value: 2, label: '2×' },
      ],
    } satisfies SliderConfig,

    STABILITY_WEIGHT: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    DOI_MASS_WEIGHT: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    FOOTPRINT_WEIGHT: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    DOI_DENSITY_WEIGHT: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    CHAIN_DOI_THRESHOLD: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,

    GAP_DISCLOSURE_PX: {
      min: 0,
      max: 200,
      step: 4,
      marks: [
        { value: 0, label: 'off' },
        { value: 200, label: '200' },
      ],
    } satisfies SliderConfig,

    CHAIN_RESCUE_BUDGET: {
      min: 0,
      max: 10,
      step: 1,
      marks: [
        { value: 0, label: 'off' },
        { value: 10, label: '10' },
      ],
    } satisfies SliderConfig,

    HYSTERESIS_ACTIVATE: {
      min: 1.0,
      max: 2.0,
      step: 0.05,
      marks: [
        { value: 1.0, label: '1' },
        { value: 2.0, label: '2' },
      ],
    } satisfies SliderConfig,

    HYSTERESIS_DEACTIVATE: {
      min: 0,
      max: 1,
      step: 0.05,
      marks: [
        { value: 0, label: '0' },
        { value: 1, label: '1' },
      ],
    } satisfies SliderConfig,
  },
} as const;

// Debouncing
export const DEBOUNCE_DURATION = 50;

// DBSCAN parameters
export const DBSCAN_EPS = 1.0;
export const DBSCAN_MIN_POINTS = 1;
export const DBSCAN_MIN_POINTS_FOR_TOP_K = 0;

// Rendering
const colors = colorbrewer.Dark2["8"];
const stringColorMap = new Map<string, number>(); // Store assigned indices
let nextColorIndex = 0;

/**
 * Custom color scale that ensures:
 * - First string received -> color index 0
 * - Second string -> color index 1
 * - Keeps numeric logic unchanged
 */
export const colorScale = (key: string | number): string => {
  if (typeof key === "number") {
    return colors[key % colors.length]; // Numeric values remain modular
  }

  if (!stringColorMap.has(key)) {
    stringColorMap.set(key, nextColorIndex);
    nextColorIndex = (nextColorIndex + 1) % colors.length; // Wrap around if exceeding available colors
  }

  return colors[stringColorMap.get(key)!];
};

export const MAX_NUM_FADED_CLUSTERS = 10;
export const MAX_NUM_CLUSTERS = 10;
export const MAX_NUM_SUMMARY_VISUALIZATIONS = 3;

// Summary Vis
export const SUMMARY_VIS_SCALE_FACTOR = 1;

// Zoom
export const ZOOM_SCALE_EXTENT_MIN = 0.5;
export const ZOOM_SCALE_EXTENT_MAX = 500;

/**
 * Returns the translation extents used by D3's zoom,
 * ensuring the user can't pan infinitely away from the data.
 */
export function getTranslateExtent(width: number, height: number): [[number, number], [number, number]] {
  // We'll allow panning up to 2x the width/height in each direction
  return [
    [-width * 2, -height * 2],
    [width * 2, height * 2],
  ];
}

// Rendering thresholds and opacities
export const NODE_DOI_RENDER_THRESHOLD = 0.05;    // Node will be drawn individually if DoI >= this constant
export const EDGE_DOI_RENDER_THRESHOLD = 0.05;    // Edge will be drawn individually if DoI >= this constant
export const MIN_BACKGROUND_OPACITY    = 0.05;    // Opacity used in precomputed background
export const MIN_DOI_OPACITY_CLAMP     = 0.05;    // The floor for interactive drawing if DoI is nonzero

// New constants for LOD multi-resolution tiles
export const NUM_LOD_LEVELS = 3; // Adaptable number of LOD levels
export const LOD_SCALE_BASE = 2;  // Each LOD level corresponds to a LOD_SCALE_BASEx increase in resolution

// --- New Constants for Node Rendering and Click Selection ---
// The base node radius used for interactive rendering.
export const NODE_RADIUS = 5;
// The click selection radius (in the same logical units as NODE_RADIUS). It should be at least equal
// to or slightly larger than NODE_RADIUS.
export const NODE_SELECTION_RADIUS = 6;
