// src/dataPreprocessing/DataLoader.ts
import type { Dataset } from "../types/datasetTypes";
import type { KnnGraph } from "../types/graphTypes";
import { computeMaxEmbeddingDistance } from "../utils/embedding";
// Removed unused import of computeMedianNN since it was not used.
// import { computeMedianNN } from "../utils/utils";
import type { DataPoint } from "./dataPreprocessing";

export async function loadDataset(
  data: DataPoint[],
  knnGraph: KnnGraph,
  hdbscan?: Dataset["hdbscan"] | null,
  midpointHdbscan?: Dataset["midpointHdbscan"] | null
): Promise<Dataset> {
  // Compute additional metadata if needed.
  const maxEmbeddingDistance = computeMaxEmbeddingDistance(data);
  // Removed unused variable: medianNN

  // Set a default dataset type (customize as needed).
  const datasetType = "custom";

  // Return the dataset with all expected properties.
  // Use 'undefined' instead of 'null' to match the Dataset type.
  return {
    data,
    knnGraph,
    datasetType,
    maxEmbeddingDistance,
    hdbscan: hdbscan ?? undefined,
    midpointHdbscan: midpointHdbscan ?? undefined,
  };
}
