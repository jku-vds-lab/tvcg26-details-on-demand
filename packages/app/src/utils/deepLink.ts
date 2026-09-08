// src/utils/deepLink.ts
//
// Encode/decode of app state to/from the URL hash fragment, used to deep-link
// paper-figure states. Pure module: no React, no direct window access except
// in the explicit `readDeepLinkFromLocation` / `buildDeepLinkUrl` helpers.
//
// Scheme (v=1, hash fragment as URLSearchParams):
//   #v=1&ds=<slug>&s.<key>=…&c.<key>=…&q=<query>|sel=<idList>&vb=minX,maxX,minY,maxY[&fly=<ms|1>][&demo=1|<phase list>][&spot=1]
//
// `demo` also accepts a comma list of choreography phases (`sel`, `params`,
// `fly`), e.g. `demo=fly,sel,params` — same enablement, custom order. See
// `parseDemoOrder` for the normalization rules.
//
// Settings params carry only diffs vs. the post-preset baseline (defaults +
// dataset preset), because the decode path re-applies presets on dataset load
// and layers these diffs on top.

import {
  getDatasetClusterPreset,
  getDatasetVisualPreset,
} from "../config/datasetVisualPresets";
import { findDatasetEntryByPath } from "../datasets/catalog";
import type { ClusterSettings, VisualizationSettings } from "../store";
import {
  initialClusterSettings,
  initialVisualizationSettings,
  SPLIT_THRESHOLD_REFERENCE_AREA_PX,
} from "../store";

export interface DeepLinkViewbox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface DeepLinkState {
  v: 1;
  /** Dataset slug from the catalog (`DatasetEntry.slug`). */
  datasetSlug?: string;
  /** Whitelisted `visualizationSettings` overrides (diff vs. post-preset baseline). */
  visSettings: Partial<VisualizationSettings>;
  /** Whitelisted `clusterSettings` overrides (diff vs. post-preset baseline). */
  clusterSettings: Partial<ClusterSettings>;
  /** Feature-search query to replay (preferred selection form). */
  query?: string;
  /** Explicit point-id selection (lasso states); ignored when `query` is set. */
  selectionIds?: number[];
  /** Data-space viewbox as returned by `computeViewbox`. */
  viewbox?: DeepLinkViewbox;
  /**
   * Animated fly-to duration for the viewbox phase, in ms (`fly=1` selects
   * `DEFAULT_FLY_MS`). Hand-authored only — `captureDeepLinkState` never sets
   * it, so the copy-link button never emits it.
   */
  flyMs?: number;
  /**
   * Replay the whole link as an animated demo choreography (typed query /
   * ghost lasso → parameter glide → fly). Hand-authored only, like `flyMs`.
   */
  demo?: boolean;
  /**
   * The demo phases to SHOW (animate), in show order — decoded from a comma
   * list in `demo=` (e.g. `demo=fly,sel,params`, or `demo=sel,fly` to apply
   * the parameter diffs silently). Phases not listed still execute, exactly
   * like the instant link. Only set when it differs from the full
   * `DEFAULT_DEMO_ORDER`, so plain `demo=1` links keep decoding identically.
   */
  demoOrder?: DemoPhase[];
  /**
   * Spotlight the demo: a translucent scrim covers the page with a cut-out
   * that follows whatever is currently being animated. Only meaningful
   * together with `demo`. Hand-authored only.
   */
  spotlight?: boolean;
}

/** Duration used when a link says `fly=1` instead of an explicit ms value. */
export const DEFAULT_FLY_MS = 2000;

/** The three demo choreography phases (see hooks/useDeepLink.ts). */
export type DemoPhase = "sel" | "params" | "fly";

export const DEFAULT_DEMO_ORDER: readonly DemoPhase[] = ["sel", "params", "fly"];

const DEMO_PHASES: readonly string[] = DEFAULT_DEMO_ORDER;

/**
 * Parses a `demo=` value as a comma list of the phases to SHOW (animate), in
 * show order. Returns null when the value carries no recognizable phase
 * tokens (plain `demo=1`-style enablement: every phase animated in default
 * order) or when the list is exactly the full default order.
 *
 * Phases omitted from the list still execute — silently, exactly like the
 * instant link: settings and selection replay before the show, viewbox jump
 * after it (see the phase dispatch in hooks/useDeepLink.ts). So
 * `demo=sel,fly` on a link that also carries parameter diffs shows lasso →
 * fly with the sliders landing instantly up front.
 *
 * Normalization: unknown tokens and duplicates are dropped, and when both
 * `sel` and `params` are listed, `sel` is moved directly in front of
 * `params` — the glide re-propagates from the current selection, so it must
 * never animate against a not-yet-replayed one. Enforced here (not at
 * runtime) because a cancelled demo replays the remaining phases instantly
 * in this same configured order.
 */
export function parseDemoOrder(raw: string): DemoPhase[] | null {
  const tokens = raw.split(",").map((t) => t.trim().toLowerCase());
  const order: DemoPhase[] = [];
  for (const token of tokens) {
    if (DEMO_PHASES.includes(token) && !order.includes(token as DemoPhase)) {
      order.push(token as DemoPhase);
    }
  }
  if (order.length === 0) return null;
  const selIdx = order.indexOf("sel");
  const paramsIdx = order.indexOf("params");
  if (selIdx !== -1 && paramsIdx !== -1 && paramsIdx < selIdx) {
    console.warn(
      `deepLink: demo order "${raw}" puts params before sel — reordered (params needs the replayed selection)`
    );
    order.splice(selIdx, 1);
    order.splice(order.indexOf("params"), 0, "sel");
  }
  const isFullDefault =
    order.length === DEFAULT_DEMO_ORDER.length &&
    order.every((p, i) => p === DEFAULT_DEMO_ORDER[i]);
  return isFullDefault ? null : order;
}

type ParamKind = "num" | "bool" | "str";

// Whitelists are keyed with `keyof` so a renamed settings field breaks tsc
// here instead of silently orphaning the URL param. Dataset-computed fields
// (maxEmbeddingDistance, defaultEps, tfidfLabels, colorPalette) are excluded
// on purpose: they are derived on load and must not be pinned by a link.
const VIS_PARAM_KINDS = {
  proximitySlider: "num",
  pastSlider: "num",
  futureSlider: "num",
  grayOutDoiThreshold: "num",
  annotationDoiThreshold: "num",
  insetDoiThreshold: "num",
  colorEncoding: "str",
  shapeEncoding: "str",
  clusterLabelStrategy: "str",
  annotationLabelFeature: "str",
  useViewboxForClustering: "bool",
} as const satisfies Partial<Record<keyof VisualizationSettings, ParamKind>>;

const CLUSTER_PARAM_KINDS = {
  splitThresholdFraction: "num",
  maxActiveClusters: "num",
  relationInsetBudget: "num",
  chainRescueBudget: "num",
  doiDensityWeight: "num",
  chainDoiThreshold: "num",
  gapDisclosurePx: "num",
  labelMinFraction: "num",
  stabilityWeight: "num",
  doiMassWeight: "num",
  footprintWeight: "num",
  hysteresisActivateFactor: "num",
  hysteresisDeactivateFactor: "num",
} as const satisfies Partial<Record<keyof ClusterSettings, ParamKind>>;

export type DeepLinkVisKey = keyof typeof VIS_PARAM_KINDS;
export type DeepLinkClusterKey = keyof typeof CLUSTER_PARAM_KINDS;

export const DEEP_LINK_VIS_KEYS = Object.keys(VIS_PARAM_KINDS) as DeepLinkVisKey[];
export const DEEP_LINK_CLUSTER_KEYS = Object.keys(CLUSTER_PARAM_KINDS) as DeepLinkClusterKey[];

/** Compact numeric formatting: 6 significant digits, trailing zeros trimmed. */
function fmtNum(v: number): string {
  return String(Number(v.toPrecision(6)));
}

function encodeValue(value: unknown, kind: ParamKind): string | null {
  switch (kind) {
    case "num":
      return typeof value === "number" && Number.isFinite(value) ? fmtNum(value) : null;
    case "bool":
      return typeof value === "boolean" ? (value ? "1" : "0") : null;
    case "str":
      // `null` (e.g. annotationLabelFeature) round-trips as the empty string.
      if (value === null) return "";
      return typeof value === "string" ? value : null;
  }
}

function decodeValue(raw: string, kind: ParamKind, key: string): unknown {
  switch (kind) {
    case "num": {
      const n = Number(raw);
      return Number.isFinite(n) && raw.trim() !== "" ? n : undefined;
    }
    case "bool":
      if (raw === "1" || raw === "true") return true;
      if (raw === "0" || raw === "false") return false;
      return undefined;
    case "str":
      // Empty string decodes to null only for the one nullable whitelist key.
      if (raw === "" && key === "annotationLabelFeature") return null;
      return raw;
  }
}

const ID_TOKEN_RE = /^[0-9a-z]+$/;

/**
 * Compact id-list codec: sort ascending, deduplicate, delta-encode, base36,
 * join with ".". Only non-negative integers are representable.
 */
export function encodeIdList(ids: number[]): string {
  const sorted = Array.from(new Set(ids.filter(id => Number.isInteger(id) && id >= 0))).sort(
    (a, b) => a - b
  );
  const tokens: string[] = [];
  let prev = 0;
  for (let i = 0; i < sorted.length; i++) {
    tokens.push((sorted[i] - (i === 0 ? 0 : prev)).toString(36));
    prev = sorted[i];
  }
  return tokens.join(".");
}

/** Inverse of `encodeIdList`. Returns null on any malformed token. */
export function decodeIdList(encoded: string): number[] | null {
  if (!encoded) return null;
  const tokens = encoded.split(".");
  const ids: number[] = [];
  let acc = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!ID_TOKEN_RE.test(tokens[i])) return null;
    const delta = parseInt(tokens[i], 36);
    if (!Number.isFinite(delta) || delta < 0) return null;
    acc = i === 0 ? delta : acc + delta;
    ids.push(acc);
  }
  return ids;
}

/** Serializes a deep-link state to the hash-fragment payload (no leading "#"). */
export function encodeDeepLink(state: DeepLinkState): string {
  const params = new URLSearchParams();
  params.set("v", "1");
  if (state.datasetSlug) params.set("ds", state.datasetSlug);

  for (const key of DEEP_LINK_VIS_KEYS) {
    const value = state.visSettings[key];
    if (value === undefined) continue;
    const encoded = encodeValue(value, VIS_PARAM_KINDS[key]);
    if (encoded !== null) params.set(`s.${key}`, encoded);
  }
  for (const key of DEEP_LINK_CLUSTER_KEYS) {
    const value = state.clusterSettings[key];
    if (value === undefined) continue;
    const encoded = encodeValue(value, CLUSTER_PARAM_KINDS[key]);
    if (encoded !== null) params.set(`c.${key}`, encoded);
  }

  if (state.query) {
    params.set("q", state.query);
  } else if (state.selectionIds && state.selectionIds.length > 0) {
    params.set("sel", encodeIdList(state.selectionIds));
  }

  if (state.viewbox) {
    const { minX, maxX, minY, maxY } = state.viewbox;
    params.set("vb", [minX, maxX, minY, maxY].map(fmtNum).join(","));
  }

  if (state.flyMs !== undefined) params.set("fly", fmtNum(state.flyMs));
  if (state.demo) {
    const custom =
      state.demoOrder && !state.demoOrder.every((p, i) => p === DEFAULT_DEMO_ORDER[i]);
    params.set("demo", custom ? state.demoOrder!.join(",") : "1");
  }
  if (state.spotlight) params.set("spot", "1");

  return params.toString();
}

/**
 * Parses a hash fragment (with or without leading "#") into a deep-link state.
 * Never throws: returns null for absent/unknown-version payloads, and silently
 * drops individual malformed or non-whitelisted params.
 */
export function decodeDeepLink(hash: string): DeepLinkState | null {
  try {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    if (!raw) return null;
    const params = new URLSearchParams(raw);
    if (params.get("v") !== "1") return null;

    const state: DeepLinkState = { v: 1, visSettings: {}, clusterSettings: {} };

    const ds = params.get("ds");
    if (ds) state.datasetSlug = ds;

    for (const [key, rawValue] of params.entries()) {
      if (key.startsWith("s.")) {
        const settingKey = key.slice(2) as DeepLinkVisKey;
        const kind = VIS_PARAM_KINDS[settingKey];
        if (!kind) continue;
        const value = decodeValue(rawValue, kind, settingKey);
        if (value !== undefined) {
          (state.visSettings as Record<string, unknown>)[settingKey] = value;
        }
      } else if (key.startsWith("c.")) {
        const settingKey = key.slice(2) as DeepLinkClusterKey;
        // Legacy param (pre-viewport-relative threshold): published links
        // encode `c.splitThresholdPx` as an absolute px² area.  Convert to
        // the fraction using the calibration reference area (34 500 px² ↔ 3%,
        // see SPLIT_THRESHOLD_REFERENCE_AREA_PX), so old links keep decoding
        // with their tuned look. An explicit new `c.splitThresholdFraction`
        // param wins over the legacy one.
        if ((settingKey as string) === "splitThresholdPx") {
          const px = decodeValue(rawValue, "num", settingKey) as number | undefined;
          if (px !== undefined && state.clusterSettings.splitThresholdFraction === undefined) {
            state.clusterSettings.splitThresholdFraction =
              px / SPLIT_THRESHOLD_REFERENCE_AREA_PX;
          }
          continue;
        }
        const kind = CLUSTER_PARAM_KINDS[settingKey];
        if (!kind) continue;
        const value = decodeValue(rawValue, kind, settingKey);
        if (value !== undefined) {
          (state.clusterSettings as Record<string, unknown>)[settingKey] = value;
        }
      }
    }

    const query = params.get("q");
    if (query) {
      state.query = query;
    } else {
      const sel = params.get("sel");
      if (sel) {
        const ids = decodeIdList(sel);
        if (ids && ids.length > 0) state.selectionIds = ids;
      }
    }

    const fly = params.get("fly");
    if (fly !== null) {
      const n = Number(fly);
      if (Number.isFinite(n) && n > 0) {
        state.flyMs = n === 1 ? DEFAULT_FLY_MS : n;
      }
    }

    // Lenient on purpose: authors reach for demo=5000 like fly=<ms>, and a
    // silently-dropped param reads as "the feature doesn't work". Anything
    // except an explicit negative enables the demo. A comma list of phase
    // tokens additionally selects a custom order (old deployed bundles read
    // such a value as plain demo=1 — backward compatible by construction).
    const demo = params.get("demo");
    if (demo !== null && demo !== "" && demo !== "0" && demo !== "false") {
      state.demo = true;
      const order = parseDemoOrder(demo);
      if (order) state.demoOrder = order;
    }
    const spot = params.get("spot");
    if (spot !== null && spot !== "" && spot !== "0" && spot !== "false") state.spotlight = true;

    const vb = params.get("vb");
    if (vb) {
      const parts = vb.split(",").map(Number);
      if (
        parts.length === 4 &&
        parts.every(Number.isFinite) &&
        parts[0] < parts[1] &&
        parts[2] < parts[3]
      ) {
        state.viewbox = { minX: parts[0], maxX: parts[1], minY: parts[2], maxY: parts[3] };
      }
    }

    return state;
  } catch {
    return null;
  }
}

/** Inputs for `captureDeepLinkState`, decoupled from the Redux store shape. */
export interface DeepLinkCaptureInput {
  visualizationSettings: VisualizationSettings;
  clusterSettings: ClusterSettings;
  datasetType: string;
  datasetPath: string;
  featureSearchQuery: string;
  selectedNodeIds: number[];
  /** Total point count; a selection covering all points is treated as "no selection". */
  totalNodeCount: number;
  viewbox?: DeepLinkViewbox;
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) > 1e-9;
  return a !== b;
}

/**
 * Captures the current app state as a deep-link state, diffing whitelisted
 * settings against the post-preset baseline (the exact inverse of the decode
 * path, which re-applies presets on load before layering diffs on top).
 * Returns null when the current dataset is not a catalog entry.
 */
export function captureDeepLinkState(input: DeepLinkCaptureInput): DeepLinkState | null {
  const entry = findDatasetEntryByPath(input.datasetPath);
  if (!entry) return null;

  const baselineVis: VisualizationSettings = {
    ...initialVisualizationSettings,
    ...getDatasetVisualPreset({ datasetType: input.datasetType, datasetPath: input.datasetPath }),
  };
  const baselineCluster: ClusterSettings = {
    ...initialClusterSettings,
    ...getDatasetClusterPreset({ datasetType: input.datasetType }),
  };

  const state: DeepLinkState = {
    v: 1,
    datasetSlug: entry.slug,
    visSettings: {},
    clusterSettings: {},
  };

  for (const key of DEEP_LINK_VIS_KEYS) {
    const current = input.visualizationSettings[key];
    if (valuesDiffer(current, baselineVis[key])) {
      (state.visSettings as Record<string, unknown>)[key] = current;
    }
  }
  for (const key of DEEP_LINK_CLUSTER_KEYS) {
    const current = input.clusterSettings[key];
    if (valuesDiffer(current, baselineCluster[key])) {
      (state.clusterSettings as Record<string, unknown>)[key] = current;
    }
  }

  if (input.featureSearchQuery.trim()) {
    state.query = input.featureSearchQuery.trim();
  } else if (
    input.selectedNodeIds.length > 0 &&
    input.selectedNodeIds.length !== input.totalNodeCount
  ) {
    state.selectionIds = input.selectedNodeIds;
  }

  if (input.viewbox) state.viewbox = input.viewbox;

  return state;
}

/** Builds a full shareable URL for a deep-link state. */
export function buildDeepLinkUrl(
  state: DeepLinkState,
  loc: { origin: string; pathname: string; search: string } = window.location
): string {
  return `${loc.origin}${loc.pathname}${loc.search}#${encodeDeepLink(state)}`;
}

/** Reads and decodes the deep link from the current page URL, if any. */
export function readDeepLinkFromLocation(): DeepLinkState | null {
  if (typeof window === "undefined") return null;
  return decodeDeepLink(window.location.hash);
}
