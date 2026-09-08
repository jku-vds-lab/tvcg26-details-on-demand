import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import {
  attachSegmentPointState,
  columnsFromPrecomputedSegments,
} from "../dataPreprocessing/splineColumns";
import { Dataset } from "../types/datasetTypes";
import type { KnnGraph } from "../types/graphTypes";
import { loadDataset } from "./DataLoader";

// Phase callback: emits normalized progress for parse/prepare
export type PhaseProgress =
  | { phase: "parse"; q: number }
  | { phase: "prepare"; q: number };

/** Expected shape of a parsed bespoke JSON bundle (unvalidated JSON boundary). */
interface ParsedDatasetObject {
  data: DataPoint[];
  knnGraph: KnnGraph;
  hdbscan?: Dataset["hdbscan"] | null;
  midpointHdbscan?: Dataset["midpointHdbscan"] | null;
  datasetType?: unknown;
  segments?: Dataset["segments"];
  trajectoryMidpoints?: Dataset["trajectoryMidpoints"];
}

export class JSONLoader {
  async resolveContent(
    text: string,
    onDataset: (dataset: Dataset) => void,
    onPhase: (p: PhaseProgress) => void = () => {}
  ): Promise<void> {
    try {
      onPhase({ phase: "parse", q: 0 });
      const obj = JSON.parse(text, (_key, value) => {
        if (value === "Infinity") return Infinity;
        if (value === "-Infinity") return -Infinity;
        return value;
      });
      onPhase({ phase: "parse", q: 1 });
      onPhase({ phase: "prepare", q: 0 });
      const dataset = await this.buildDatasetFromObject(obj, onPhase);
      onPhase({ phase: "prepare", q: 1 });
      onDataset(dataset);
    } catch (error) {
      console.error("Error parsing JSON:", error);
    }
  }

  async resolveParsed(
    obj: unknown,
    onDataset: (dataset: Dataset) => void,
    onPhase: (p: PhaseProgress) => void = () => {}
  ): Promise<void> {
    onPhase({ phase: "parse", q: 1 });
    onPhase({ phase: "prepare", q: 0 });
    const dataset = await this.buildDatasetFromObject(obj, onPhase);
    onPhase({ phase: "prepare", q: 1 });
    onDataset(dataset);
  }

  private async buildDatasetFromObject(
    rawObj: unknown,
    _onPhase: (p: PhaseProgress) => void
  ): Promise<Dataset> {
    const obj = rawObj as ParsedDatasetObject;
    // First, build the standard dataset using existing pipeline
    const ds = await loadDataset(obj.data, obj.knnGraph, obj.hdbscan, obj.midpointHdbscan);

    // Pass through datasetType if present
    if (obj.datasetType && typeof obj.datasetType === "string") {
      ds.datasetType = obj.datasetType;
    }

    // If the JSON already contains precomputed geometry, surface it on the dataset
    if (obj.segments) {
      ds.segments = obj.segments;
    }
    if (obj.trajectoryMidpoints) {
      ds.trajectoryMidpoints = obj.trajectoryMidpoints;
    }

    // Convert embedded precomputed segments to the resident columnar form
    // (phase B1) and write the derived per-point state (nextEdgeCenter).
    if (obj.segments?.length) {
      try {
        const cols = columnsFromPrecomputedSegments(obj.segments, ds.data);
        await attachSegmentPointState(ds.data, cols);
        ds.segmentColumns = cols;
      } catch (e) {
        // Non-fatal: without columns the app falls back to on-the-fly spline compute.
        console.warn("Geometry conversion failed; will use fallback spline compute:", e);
      }
    }

    return ds;
  }
}
