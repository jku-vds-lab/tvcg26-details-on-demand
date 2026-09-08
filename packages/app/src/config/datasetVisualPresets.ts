import type { ClusterSettings, VisualizationSettings } from "../store";

type PresetInput = {
  datasetType?: string;
  datasetPath?: string;
};

const SET2_8 = [
  "#66c2a5",
  "#fc8d62",
  "#8da0cb",
  "#e78ac3",
  "#a6d854",
  "#ffd92f",
  "#e5c494",
  "#b3b3b3",
];

const SET3_10 = [
  "#8dd3c7",
  "#ffffb3",
  "#bebada",
  "#fb8072",
  "#80b1d3",
  "#fdb462",
  "#b3de69",
  "#fccde5",
  "#d9d9d9",
  "#bc80bd",
];

function rotatePalette(colors: string[], offset: number): string[] {
  if (colors.length <= 1) return [...colors];
  const normalized = ((offset % colors.length) + colors.length) % colors.length;
  if (normalized === 0) return [...colors];
  return [...colors.slice(normalized), ...colors.slice(0, normalized)];
}

export function getDatasetVisualPreset({ datasetType, datasetPath }: PresetInput): Partial<VisualizationSettings> {
  const normalizedType = (datasetType ?? "").toLowerCase();
  const normalizedPath = (datasetPath ?? "").toLowerCase();

  const patch: Partial<VisualizationSettings> = {
    // Keep the base defaults explicit so switching datasets does not leave stale values behind.
    nodeRadius: 5,
    edgeWidth: 1,
    arrowScale: 6,
    maximumOpacityClamping: 1,
    colorMapRotationOffset: 0,
    clusterLabelStrategy: "majority-vote",
    tfidfCorpusScope: "visible",
    annotationTagDelimiter: ",",
    annotationLabelFeature: null,
  };

  if (normalizedType === "rubik") {
    patch.colorEncoding = "algo";
    patch.colorMapRotationOffset = 1;
    patch.colorPalette = rotatePalette(SET2_8, 1);
  } else if (normalizedType === "chess") {
    patch.colorEncoding = "algo";
    patch.colorMapRotationOffset = 0;
    patch.colorPalette = rotatePalette(SET2_8, 0);
  } else if (normalizedType === "mnist" || normalizedType === "image") {
    patch.colorEncoding = "label";
    patch.colorMapRotationOffset = 0;
    patch.colorPalette = rotatePalette(SET3_10, 0);
  } else if (normalizedType === "cctv" || normalizedType === "edinburgh") {
    patch.colorEncoding = "line";
    patch.colorMapRotationOffset = 0;
    patch.colorPalette = rotatePalette(SET3_10, 0);
    patch.clusterLabelStrategy = "tfidf";
    patch.tfidfCorpusScope = "visible";
    patch.annotationTagDelimiter = ",";
  } else if (normalizedType === "default") {
    patch.colorEncoding = "algo";
    patch.colorMapRotationOffset = 1;
    patch.colorPalette = rotatePalette(SET2_8, 1);
  }

  // The oversized default-type marks are tuned for the tiny predefined toy
  // datasets (cube/dev examples with few, widely spaced points). User data —
  // uploads ("upload:…" source paths) and the anywidget bootstrap (no path) —
  // keeps the base sizes; the old blanket rule made widget datasets render
  // with giant nodes/edges/arrows. The synthetic scaling smoke tests
  // (data/synth*, issue #315) are default-typed too but hundreds of
  // thousands of points — nodes get density-shrunk at render time, while
  // edges/arrows kept the toy sizes and rendered weirdly huge.
  if (
    normalizedType === "default" &&
    normalizedPath !== "" &&
    !normalizedPath.startsWith("upload:") &&
    !normalizedPath.startsWith("data/synth")
  ) {
    patch.nodeRadius = 25;
    patch.edgeWidth = 10;
    patch.arrowScale = 20;
  }

  if (normalizedPath.includes("100x2-origins_splines_stability")) {
    patch.maximumOpacityClamping = 0.25;
  } else if (normalizedPath.includes("10x2-origins_splines_stability")) {
    patch.maximumOpacityClamping = 0.7;
  } else if (normalizedPath.includes("all_chess_openings")) {
    patch.maximumOpacityClamping = 0.25;
  }

  return patch;
}

export function getDatasetClusterPreset({ datasetType }: Pick<PresetInput, "datasetType">): Partial<ClusterSettings> {
  const normalizedType = (datasetType ?? "").toLowerCase();
  if (normalizedType === "mnist" || normalizedType === "image") {
    return { maxActiveClusters: 11 };
  }
  return { maxActiveClusters: 7 };
}
