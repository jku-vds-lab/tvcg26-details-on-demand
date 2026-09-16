// src/store.ts

import { configureStore, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { enableMapSet } from "immer";
import type { ClusterTreeNode } from "./clustering/ExtendedHDBSCAN";
import datasetFeaturesReducer from "./slices/datasetFeatures";
import freehandReducer from "./slices/freehandSlice";
import labelingReducer from "./slices/labelingSlice";
import progressReducer from "./slices/progressSlice";

// Labeling state uses Map/Set collections.
enableMapSet();

//
// 1) Visualization Settings Slice
//

export interface VisualizationSettings {
  nodeRadius: number;
  nodeOutlineWidth: number;
  /** When true, node outlines are drawn white instead of the default black. */
  nodeOutlineWhite: boolean;
  edgeWidth: number;
  arrowScale: number;
  nodeSelectionRadius: number;
  grayOutDoiThreshold: number;
  annotationDoiThreshold: number;
  insetDoiThreshold: number;
  numLODLevels: number;
  lodScaleBase: number;
  alphaEmbedding: number;
  factorTopology: number;
  colorPalette: string[];
  maxEmbeddingDistance: number;
  proximitySlider: number;
  pastSlider: number;
  futureSlider: number;
  defaultEps: number;
  nodeSelectionBorderWidth: number;
  tileResolution: number;
  shapeEncoding: string;
  colorEncoding: string;
  colorMapRotationOffset: number;
  uiAccentColor: string;
  sidePanelBgColor: string;
  canvasBgColor: string;
  minimumOpacityClamping: number;
  maximumOpacityClamping: number;
  useViewboxForClustering: boolean;
  minZoom: number;
  maxZoom: number;
  annotationLabelScale: number;
  /** Override which feature column is shown as cluster annotation text. null = use dataset default. */
  annotationLabelFeature: string | null;
  /** Edge insets use the same math as nodes: scale = clamp(N^exp, [min,max]) */
  edgeInsetMinScale: number;
  edgeInsetMaxScale: number;
  edgeScaleExponent: number;

  /** INSET OPTIMIZATION */
  optimizationWeightDistance: number;
  optimizationWeightMentalMap: number;
  optimizationWeightL: number;
  optimizationWeightSourceOverlap: number;
  optimizationWeightDS: number;
  optimizationWeightOI: number;
  optimizationWeightDI: number;
  optimizationWeightDataOcclusion: number;
  hardInsetOverlapPenalty: number;
  hardLeaderCrossingPenalty: number;
  hardScatterOverlapPenalty: number;
  hardForeignContourOverlapPenalty: number;
  contourTargetRadiusMultiplier: number;

  /** ANNEALING SETTINGS */
  insetOptimizationIterations: number;
  insetOptimizationCoolingRate: number;
  insetOptimizationJitterStrength: number;

  /** Positioning strategy for annotations/insets. */
  clusterPositioningMode: "annealing" | "cartographic";
  /** Label aggregation strategy for cluster annotations. */
  clusterLabelStrategy: "majority-vote" | "tfidf";
  /** Corpus scope used when computing TF-IDF labels. */
  tfidfCorpusScope: "visible" | "doi-active" | "full-dataset";
  /** Delimiter used to split tag strings when computing TF-IDF. */
  annotationTagDelimiter: string;
  /** Pre-computed TF-IDF labels keyed by cluster element ID. Updated by useTfIdfClusterLabels hook. */
  tfidfLabels: Record<string, string>;
}

export const initialVisualizationSettings: VisualizationSettings = {
  nodeRadius: 5,
  nodeOutlineWidth: 0.5,
  nodeOutlineWhite: false,
  edgeWidth: 1,
  arrowScale: 6,
  nodeSelectionRadius: 10,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
  numLODLevels: 3,
  lodScaleBase: 2,
  alphaEmbedding: 0.2,
  factorTopology: 0.25,
  colorPalette: [
    "#1b9e77",
    "#d95f02",
    "#7570b3",
    "#e7298a",
    "#66a61e",
    "#e6ab02",
    "#a6761d",
    "#666666",
  ],
  maxEmbeddingDistance: 0,
  proximitySlider: 0.1,
  // Effective chain weights (converged model): the store holds the actual
  // per-hop weight w; the Backward/Forward thumbs are REACH-LINEAR
  // (sliderUtils.chainReachSliderToWeight — linear in the fraction of a
  // typical trajectory visibly reached; log, cubic and identity mappings
  // all rejected by feel, CS 2026-08-17). 0.421875 = 0.75³ keeps the
  // default converged look exactly where the v7 instrument had it.
  pastSlider: 0.421875,
  futureSlider: 0.421875,
  defaultEps: 0,
  nodeSelectionBorderWidth: 1,
  tileResolution: 300,
  shapeEncoding: "circle",
  colorEncoding: "algo",
  colorMapRotationOffset: 0,
  uiAccentColor: "#007dad",
  sidePanelBgColor: "#ffffff",
  canvasBgColor: "#ffffff",
  minimumOpacityClamping: 0.05,
  maximumOpacityClamping: 1.0,
  useViewboxForClustering: false,
  minZoom: 0.5,
  maxZoom: 1000,
  annotationLabelScale: 1.0,
  annotationLabelFeature: null,
  edgeInsetMinScale: 1.0,
  edgeInsetMaxScale: 1.0,
  edgeScaleExponent: 0.5,

  // Active by default: Distance 5, OI 2 and the three hard penalties at 5000
  // (inset overlap, leader crossing, foreign contour); every other weight is 0.
  optimizationWeightDistance: 5.0,
  optimizationWeightMentalMap: 0,
  optimizationWeightL: 0,
  optimizationWeightSourceOverlap: 0,
  optimizationWeightDS: 0,
  optimizationWeightOI: 2.0,
  optimizationWeightDI: 0,
  optimizationWeightDataOcclusion: 0,
  hardInsetOverlapPenalty: 5000,
  hardLeaderCrossingPenalty: 5000,
  hardScatterOverlapPenalty: 0,
  hardForeignContourOverlapPenalty: 5000,
  contourTargetRadiusMultiplier: 0.5,

  insetOptimizationIterations: 1200,
  insetOptimizationCoolingRate: 0.92,
  insetOptimizationJitterStrength: 24,
  clusterPositioningMode: "annealing",
  clusterLabelStrategy: "majority-vote",
  tfidfCorpusScope: "visible",
  annotationTagDelimiter: ",",
  tfidfLabels: {},
};

const visualizationSettingsSlice = createSlice({
  name: "visualizationSettings",
  initialState: initialVisualizationSettings,
  reducers: {
    updateSettings(state, action: PayloadAction<Partial<VisualizationSettings>>) {
      return { ...state, ...action.payload };
    },
    /** Clear a color encoding the freshly loaded dataset does not have
     * (issue #315 color-by UX): visual presets prefill per dataset TYPE
     * ("default" → "algo"), but a dataset may lack that column (synth1m) —
     * the panel then shows a selected feature that colors nothing and every
     * palette click is a silent no-op. Dispatched once per load with the
     * micro-scan's key set; "DoI" is a runtime column and always valid. */
    clearMissingColorEncoding(state, action: PayloadAction<string[]>) {
      const encoding = state.colorEncoding;
      if (!encoding || encoding === "DoI") return;
      if (action.payload.includes(encoding)) return;
      state.colorEncoding = "";
    },
    setAnnotationLabelScale(state, action: PayloadAction<number>) {
      const v = Math.max(0.5, Math.min(2, action.payload));
      state.annotationLabelScale = v;
    },
    setAnnotationLabelFeature(state, action: PayloadAction<string | null>) {
      state.annotationLabelFeature = action.payload;
    },
    setClusterLabelStrategy(state, action: PayloadAction<"majority-vote" | "tfidf">) {
      state.clusterLabelStrategy = action.payload;
    },
    setTfIdfCorpusScope(state, action: PayloadAction<"visible" | "doi-active" | "full-dataset">) {
      state.tfidfCorpusScope = action.payload;
    },
    setAnnotationTagDelimiter(state, action: PayloadAction<string>) {
      state.annotationTagDelimiter = action.payload;
    },
    setTfIdfLabels(state, action: PayloadAction<Record<string, string>>) {
      const incoming = action.payload;
      const current = state.tfidfLabels;
      const inKeys = Object.keys(incoming);
      // No-op when content is identical — prevents spurious re-renders.
      if (
        inKeys.length === Object.keys(current).length &&
        inKeys.every((k) => current[k] === incoming[k])
      ) return;
      state.tfidfLabels = incoming;
    },
  },
});
export const {
  updateSettings,
  clearMissingColorEncoding,
  setAnnotationLabelScale,
  setAnnotationLabelFeature,
  setClusterLabelStrategy,
  setTfIdfCorpusScope,
  setAnnotationTagDelimiter,
  setTfIdfLabels,
} = visualizationSettingsSlice.actions;

//
// 2) Selection Slice
//

interface SelectionState {
  selectedNodeIds: number[];
}
const initialSelectionState: SelectionState = { selectedNodeIds: [] };

const selectionSlice = createSlice({
  name: "selection",
  initialState: initialSelectionState,
  reducers: {
    toggleNodeSelection(state, action: PayloadAction<number>) {
      const nodeId = action.payload;
      const idx = state.selectedNodeIds.indexOf(nodeId);
      if (idx === -1) state.selectedNodeIds.push(nodeId);
      else state.selectedNodeIds.splice(idx, 1);
    },
    setSelectedNodes(state, action: PayloadAction<number[]>) {
      state.selectedNodeIds = action.payload;
    },
  },
});
export const { toggleNodeSelection, setSelectedNodes } = selectionSlice.actions;

//
// 3) Dataset Metadata Slice
//

export interface DatasetMetadata {
  datasetType: string;
  datasetPath: string;
  /** rows × cols of the `"image"` type's pixel grid (the widget's `image_shape`);
   * null = the dataset type's preset (mnist: 28×28). */
  imageShape?: [number, number] | null;
}
const initialDatasetMetadata: DatasetMetadata = { datasetType: "default", datasetPath: "", imageShape: null };

const datasetSlice = createSlice({
  name: "dataset",
  initialState: initialDatasetMetadata,
  reducers: {
    setDatasetMetadata(state, action: PayloadAction<Partial<DatasetMetadata>>) {
      return { ...state, ...action.payload };
    },
  },
});
export const { setDatasetMetadata } = datasetSlice.actions;

//
// 4) Cluster Settings Slice
//

export interface ClusterSettings {
  /**
   * The cluster budget: a hard TOTAL cap on active node clusters —
   * chain-rescue slots are reserved from within it (see chainRescueBudget).
   * Edge (diff) insets have their own independent cap (relationInsetBudget);
   * the #261 combined-scope A/B experiment concluded the node pass starves
   * salient diffs, so the two budgets stay separate.
   */
  maxActiveClusters: number;
  sizeThreshold: number;
  maxSizeThreshold: number;
  contourThickness: number;
  contourGray: number;
  contourStippling: number;
  contourOutlineThickness: number;
  hullPaddingFactor: number;
  hullPaddingPx: number;
  hullSplineAlpha: number;
  leaderOutlineThickness: number;
  leaderThickness: number;
  leaderGray: number;
  leaderDashLength: number;
  leaderDashGap: number;
  /** When true, leader lines cast a drop shadow (coloured line + arrowhead only; halo excluded). */
  leaderShadow: boolean;
  /** Blur radius for the leader-line drop shadow (data-space px at zoom=1). */
  leaderShadowIntensity: number;
  insetMinScale: number;
  insetMaxScale: number;
  scaleExponent: number;
  duration: number;
  ease: string;
  /** When true, size thresholds are relative to ALL nodes, not just the DOI-filtered group. */
  useGlobalCountingNodes: boolean;
  /**
   * The edge-inset budget: max number of cluster-conditioned edge-difference
   * relation insets shown (top-N by score, floating and on-spline jointly).
   * 0 hides the whole edge pipeline (relation insets, edge annotation labels,
   * hover diffs) — it replaced the former showEdgeAnnotations toggle.
   */
  relationInsetBudget: number;
  /** On-hover scale multiplier for node insets and diff insets (framer-motion whileHover). */
  insetHoverScale: number;
  /**
   * Emphasis scale for the D2 spotlight: how much endpoint nodes and their trajectory
   * edges grow when a diff inset is hovered. e.g. 0.75 → nodes grow by +75%.
   * Animated in sync with the inset glyph duration/ease via framer-motion animate().
   */
  spotlightEmphasisScale: number;

  // ── Relation-leader styling (independent from node-inset Leader Lines) ───────────────────────
  /** Base line thickness for relation leaders (data-space px at zoom=1). */
  relationLeaderThickness: number;
  /** Luminance for relation leader colour, 0=black, 1=white. */
  relationLeaderGray: number;
  /** Total halo/outline width for relation leaders (data-space px at zoom=1). */
  relationLeaderOutlineThickness: number;
  /** Dash segment length for relation leaders (0 = solid). */
  relationLeaderDashLength: number;
  /** Dash gap length for relation leaders (0 = no gap). */
  relationLeaderDashGap: number;
  /** When true, line width also encodes directional strength (lerp minWidth→baseWidth). */
  relationLeaderWidthEncodesStrength: boolean;
  /** Minimum arrowhead size in data-space px at zoom=1 (shown even at strength=0). */
  relationArrowMinSize: number;
  /** Maximum arrowhead size in data-space px at zoom=1 (at full normalised strength). */
  relationArrowMaxSize: number;
  /** Minimum line width when width-encoding is on (data-space px at zoom=1). */
  relationLeaderMinWidth: number;
  /** When true, relation leader lines cast a drop shadow. */
  relationLeaderShadow: boolean;
  /** Blur radius for the relation leader-line drop shadow (data-space px at zoom=1). */
  relationLeaderShadowIntensity: number;

  // ── Semantic-zoom pipeline (footprint-based, replaces relative-count thresholds) ──────────
  /**
   * Fraction of the current view (canvas) area above which a cluster is large
   * enough on screen to split into its children in the hierarchy cut.  Higher →
   * coarser clustering at any given zoom.  Resolved to a pixel² threshold at
   * the point of use from the live canvas size, so the same setting discloses
   * the same relative amount of structure on a laptop and a large monitor.
   * @default 0.03 — empirically calibrated (CS, 2026-07) to reproduce the old
   *          absolute 34 500 px² default on the canvas the legacy value was
   *          tuned on (see SPLIT_THRESHOLD_REFERENCE_AREA_PX)
   */
  splitThresholdFraction: number;
  /**
   * Minimum size fraction relative to the resolved split threshold a cluster
   * must occupy before it is eligible for annotation.  Using the split
   * threshold (not viewport area directly) as the reference means it scales
   * along with `splitThresholdFraction` automatically — no second viewport
   * factor is applied.  e.g. 0.1 = at least 10% of the split threshold in
   * screen pixels.
   * @default 0.1
   */
  labelMinFraction: number;
  /**
   * Saliency score weight for HDBSCAN cluster stability (normalised, [0,1]).
   * Used only as a ranking term—never as a hard eligibility filter.
   * @default 0.3
   */
  stabilityWeight: number;
  /**
   * Saliency score weight for DoI mass (sum of point interests).
   * @default 0.5
   */
  doiMassWeight: number;
  /**
   * Saliency score weight for screen-space footprint (clamped to [0,1] vs viewport).
   * @default 0.2
   */
  footprintWeight: number;
  /**
   * Saliency score weight for DoI *density* (mean member DoI, absolute [0,1]).
   * Drives chain rescue: small clusters fully on a selected trajectory can
   * outrank larger background clusters.  Inert when DoI is uniform (no selection).
   * @default 0.4
   */
  doiDensityWeight: number;
  /**
   * Minimum DoI density for a cluster below the min-area gate to remain
   * annotation-eligible anyway (chain rescue).  Mirrors insetDoiThreshold's
   * default so rescued clusters classify as inset-active downstream.
   * @default 0.9
   */
  chainDoiThreshold: number;
  /**
   * Screen-px gap between a node's projected child bboxes at/above which the
   * node splits in the zoom cut even below splitThresholdPx (gap disclosure —
   * lets small chain clusters enter the cut at coarse zoom).  Only applied
   * while a selection / DoI focus is active; 0 disables.
   * @default 48
   */
  gapDisclosurePx: number;
  /**
   * Active-cluster slots reserved WITHIN maxActiveClusters for chain-rescued
   * fragments (rescued fragments otherwise starve in saturated views — they
   * rank last on every classic saliency term).  Reserved slots displace the
   * lowest-ranked base clusters; unused slots return to the base pool.
   * 0 disables the reserve (fragments then activate only via budget-fill).
   * @default 4
   */
  chainRescueBudget: number;
  /**
   * Hysteresis: multiplier on the K-th-rank saliency score above which a *new*
   * cluster activates.  Must be ≥ 1 (typical 1.05–1.20).
   * @default 1.1
   */
  hysteresisActivateFactor: number;
  /**
   * Hysteresis: multiplier on the K-th-rank saliency score below which an
   * *active* cluster deactivates.  Must be < hysteresisActivateFactor.
   * @default 0.85
   */
  hysteresisDeactivateFactor: number;
}

/**
 * Reference view area (px²) that anchors `splitThresholdFraction`: the default
 * fraction reproduces the historical absolute 34 500 px² split threshold
 * exactly on a canvas of this area.  Defined as 34 500 / 0.03 = 1 150 000 px²
 * — CS compared the cuts side-by-side on the setup the legacy default was
 * tuned on and calibrated the equivalent fraction to 3.0%.  Also used by the
 * deep-link decoder to convert legacy absolute `c.splitThresholdPx` params
 * (published paper links) into the fraction, so the legacy default converts
 * to exactly the new default.
 */
export const SPLIT_THRESHOLD_REFERENCE_AREA_PX = 34500 / 0.03;

export const initialClusterSettings: ClusterSettings = {
  maxActiveClusters: 12,
  sizeThreshold: 0.01,
  maxSizeThreshold: 1.0,
  contourThickness: 5,
  contourGray: 0.6666667,
  contourStippling: 0,
  contourOutlineThickness: 10,
  hullPaddingPx: 12,
  hullPaddingFactor: 0.1,
  hullSplineAlpha: 0.5,
  leaderOutlineThickness: 6,
  leaderThickness: 2,
  leaderGray: 0.3333333,
  leaderDashLength: 8,
  leaderDashGap: 3,
  leaderShadow: true,
  leaderShadowIntensity: 6,
  insetMinScale: 1,
  insetMaxScale: 2,
  scaleExponent: 0.5,
  duration: 0.25,
  ease: "circOut",
  useGlobalCountingNodes: true,
  relationInsetBudget: 0,
  insetHoverScale: 1.5,
  spotlightEmphasisScale: 2.0,

  // Relation-leader settings (default mirrors node-leader values)
  relationLeaderThickness: 2,
  relationLeaderGray: 0.3333333,
  relationLeaderOutlineThickness: 6,
  relationLeaderDashLength: 8,
  relationLeaderDashGap: 3,
  relationLeaderWidthEncodesStrength: false,
  relationArrowMinSize: 13,
  relationArrowMaxSize: 25,
  relationLeaderMinWidth: 1,
  relationLeaderShadow: true,
  relationLeaderShadowIntensity: 6,

  // Semantic-zoom defaults
  splitThresholdFraction: 34500 / SPLIT_THRESHOLD_REFERENCE_AREA_PX,
  labelMinFraction: 0.01,
  stabilityWeight: 0.3,
  doiMassWeight: 0.5,
  footprintWeight: 0.2,
  doiDensityWeight: 0.4,
  chainDoiThreshold: 0.9,
  gapDisclosurePx: 48,
  chainRescueBudget: 4,
  hysteresisActivateFactor: 1.1,
  hysteresisDeactivateFactor: 0.85,
};

const clusterSettingsSlice = createSlice({
  name: "clusterSettings",
  initialState: initialClusterSettings,
  reducers: {
    updateClusterSettings(state, action: PayloadAction<Partial<ClusterSettings>>) {
      return { ...state, ...action.payload };
    },
  },
});
export const { updateClusterSettings } = clusterSettingsSlice.actions;

//
// 5) UI Slice
//

interface UiState {
  featureSearchQuery: string;
  /** Server-loss warning (issue #315 R3a, §8.8d): non-null shows the
   * persistent "server unavailable" banner. Mechanisms that would silently
   * run in a weaker local mode (no-knn propagation, unreachable deferred
   * columns) set it instead — degradation must be LOUD. */
  serverLossWarning: string | null;
}
const initialUiState: UiState = { featureSearchQuery: "", serverLossWarning: null };

const uiSlice = createSlice({
  name: "ui",
  initialState: initialUiState,
  reducers: {
    setFeatureSearchQuery(state, action: PayloadAction<string>) {
      state.featureSearchQuery = action.payload;
    },
    clearFeatureSearchQuery(state) {
      state.featureSearchQuery = "";
    },
    setServerLossWarning(state, action: PayloadAction<string | null>) {
      state.serverLossWarning = action.payload;
    },
  },
});
export const { setFeatureSearchQuery, clearFeatureSearchQuery, setServerLossWarning } = uiSlice.actions;

//
// 6) Clustering Slice
//

export interface ClusteringResults {
  // Per-point labels deliberately do NOT live here (issue #315 I2): they were
  // readerless in Redux, and slicing + Immer-freezing a 1M-element array twice
  // per pass cost ~0.3 s on the boot critical path. Per-point membership is
  // carried by the point fields (annotationClusterId/insetClusterId) and the
  // cut-driven groups.
  activeClusters: ClusterTreeNode[];
  hierarchyId: number;
}

/**
 * Strip recursive `leftChild`/`rightChild` tree links before placing cluster nodes
 * into Immer-managed Redux state.  Immer recursively finalizes every nested property;
 * for a degenerate HDBSCAN tree (e.g. 10 k points) that traversal can be ~10 k frames
 * deep, overflowing the JS call stack.  The tree links are only used by ClusteringService
 * during computation and are never read back from the store.
 */
function flattenCluster(c: ClusterTreeNode): ClusterTreeNode {
   
  const { leftChild: _l, rightChild: _r, ...rest } =
    c as ClusterTreeNode & { leftChild?: unknown; rightChild?: unknown };
  return rest as ClusterTreeNode;
}

export interface ClusteringState {
  annotationClusterVersion: number;
  insetClusterVersion: number;
  edgeAnnotationClusterVersion: number;
  edgeInsetClusterVersion: number;
  annotationTreeCutVersion: number;
  insetTreeCutVersion: number;
  edgeAnnotationTreeCutVersion: number;
  edgeInsetTreeCutVersion: number;
  annotationClusteringResults: ClusteringResults | null;
  insetClusteringResults: ClusteringResults | null;
  edgeAnnotationClusteringResults: ClusteringResults | null;
  edgeInsetClusteringResults: ClusteringResults | null;
  /**
   * Live composition of the active node clusters for the settings-panel
   * readout: `base` won a regular slot, `chain` came in via the chain-rescue
   * reserve (chainRescueBudget, reserved within maxActiveClusters — so
   * base + chain ≤ maxActiveClusters). Node clusters only — the
   * edge/midpoint pipeline is not counted.
   */
  activeClusterStats: { base: number; chain: number };
  isClustering: boolean;
}

const initialClusteringState: ClusteringState = {
  annotationClusterVersion: 0,
  insetClusterVersion: 0,
  edgeAnnotationClusterVersion: 0,
  edgeInsetClusterVersion: 0,
  annotationTreeCutVersion: 0,
  insetTreeCutVersion: 0,
  edgeAnnotationTreeCutVersion: 0,
  edgeInsetTreeCutVersion: 0,
  annotationClusteringResults: null,
  insetClusteringResults: null,
  edgeAnnotationClusteringResults: null,
  edgeInsetClusteringResults: null,
  activeClusterStats: { base: 0, chain: 0 },
  isClustering: false,
};

const clusteringSlice = createSlice({
  name: "clustering",
  initialState: initialClusteringState,
  reducers: {
    incrementAnnotationTreeCutVersion(state) {
      state.annotationTreeCutVersion += 1;
    },
    incrementInsetTreeCutVersion(state) {
      state.insetTreeCutVersion += 1;
    },
    incrementEdgeAnnotationTreeCutVersion(state) {
      state.edgeAnnotationTreeCutVersion += 1;
    },
    incrementEdgeInsetTreeCutVersion(state) {
      state.edgeInsetTreeCutVersion += 1;
    },

    // Full replacement (new hierarchy or full recompute)
    setAnnotationClusteringResults(state, action: PayloadAction<ClusteringResults>) {
      const r = action.payload;
      state.annotationClusteringResults = {
        activeClusters: r.activeClusters.map(flattenCluster),
        hierarchyId: r.hierarchyId,
      };
      state.annotationClusterVersion += 1;
    },
    setInsetClusteringResults(state, action: PayloadAction<ClusteringResults>) {
      const r = action.payload;
      state.insetClusteringResults = {
        activeClusters: r.activeClusters.map(flattenCluster),
        hierarchyId: r.hierarchyId,
      };
      state.insetClusterVersion += 1;
    },
    setEdgeAnnotationClusteringResults(state, action: PayloadAction<ClusteringResults>) {
      const r = action.payload;
      state.edgeAnnotationClusteringResults = {
        activeClusters: r.activeClusters.map(flattenCluster),
        hierarchyId: r.hierarchyId,
      };
      state.edgeAnnotationClusterVersion += 1;
    },
    setEdgeInsetClusteringResults(state, action: PayloadAction<ClusteringResults>) {
      const r = action.payload;
      state.edgeInsetClusteringResults = {
        activeClusters: r.activeClusters.map(flattenCluster),
        hierarchyId: r.hierarchyId,
      };
      state.edgeInsetClusterVersion += 1;
    },

    // Lightweight updates when only the active set changes on zoom/pan
    updateAnnotationActiveClusters(state, action: PayloadAction<ClusterTreeNode[]>) {
      const curr = state.annotationClusteringResults;
      if (!curr) return;
      state.annotationClusteringResults = {
        activeClusters: action.payload.map(flattenCluster),
        hierarchyId: curr.hierarchyId,
      };
      state.annotationClusterVersion += 1;
    },
    updateInsetActiveClusters(state, action: PayloadAction<ClusterTreeNode[]>) {
      const curr = state.insetClusteringResults;
      if (!curr) return;
      state.insetClusteringResults = {
        activeClusters: action.payload.map(flattenCluster),
        hierarchyId: curr.hierarchyId,
      };
      state.insetClusterVersion += 1;
    },
    updateEdgeAnnotationActiveClusters(state, action: PayloadAction<ClusterTreeNode[]>) {
      const curr = state.edgeAnnotationClusteringResults;
      if (!curr) return;
      state.edgeAnnotationClusteringResults = {
        activeClusters: action.payload.map(flattenCluster),
        hierarchyId: curr.hierarchyId,
      };
      state.edgeAnnotationClusterVersion += 1;
    },
    updateEdgeInsetActiveClusters(state, action: PayloadAction<ClusterTreeNode[]>) {
      const curr = state.edgeInsetClusteringResults;
      if (!curr) return;
      state.edgeInsetClusteringResults = {
        activeClusters: action.payload.map(flattenCluster),
        hierarchyId: curr.hierarchyId,
      };
      state.edgeInsetClusterVersion += 1;
    },

    setActiveClusterStats(state, action: PayloadAction<{ base: number; chain: number }>) {
      state.activeClusterStats = action.payload;
    },

    setIsClustering(state, action: PayloadAction<boolean>) {
      state.isClustering = action.payload;
    },
  },
});

export const {
  incrementAnnotationTreeCutVersion,
  incrementInsetTreeCutVersion,
  incrementEdgeAnnotationTreeCutVersion,
  incrementEdgeInsetTreeCutVersion,
  setAnnotationClusteringResults,
  setInsetClusteringResults,
  setEdgeAnnotationClusteringResults,
  setEdgeInsetClusteringResults,
  updateAnnotationActiveClusters,    // ← export new actions
  updateInsetActiveClusters,         // ← export new actions
  updateEdgeAnnotationActiveClusters,
  updateEdgeInsetActiveClusters,
  setActiveClusterStats,
  setIsClustering,
} = clusteringSlice.actions;

//
// 7) Configure Store
//

const store = configureStore({
  reducer: {
    visualizationSettings: visualizationSettingsSlice.reducer,
    selection: selectionSlice.reducer,
    dataset: datasetSlice.reducer,
    clusterSettings: clusterSettingsSlice.reducer,
    ui: uiSlice.reducer,
    clustering: clusteringSlice.reducer,
    datasetFeatures: datasetFeaturesReducer,
    progress: progressReducer,
    labeling: labelingReducer,
    freehand: freehandReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: [
          "labeling.selectedIds",
          "labeling.assignments",
          "labeling.existingLabels",
        ],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export default store;
export { clearFeatureMetadata, setAvailableFeatureKeys, setFeatureMetadata, setFeatureMetadataProvisional, setFeatureTypeOverride } from "./slices/datasetFeatures";

