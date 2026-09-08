import { Dataset } from "../types/datasetTypes";
import { KnnGraph } from "../types/graphTypes";
import { DataPoint } from "./dataPreprocessing";

export class CSVLoader {
  // resolveVectors(vectors: any[], onChange: (dataset: Dataset) => void): void {
    resolveVectors(data: DataPoint[], onChange: (dataset: Dataset) => void): void {
    // For simplicity, we assume the CSV data is an array of objects.
    const dataset: Dataset = {
      data,
      knnGraph: [] as KnnGraph, // Placeholder for knnGraph if available
      datasetType: "default", // Placheholder
    };
    onChange(dataset);
  }
}
