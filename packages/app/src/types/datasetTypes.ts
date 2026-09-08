import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { SegmentColumns } from "../dataPreprocessing/splineColumns";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import type { BackendManifest } from "../scaling.types";
import type { KnnGraph } from "./graphTypes";

/** Server-precomputed spline segment (index-based) */
export interface PrecomputedSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** index into Dataset.data for the start node */
  startIndex: number;
  /** index into Dataset.data for the end node */
  endIndex: number;
  startPercentage: number;
  endPercentage: number;
  splineMidPoint: { x: number; y: number };
  isArrowSegment?: boolean;
  /** Optional: precomputed DOI for the edge segment */
  doi?: number;
  /** Optional: action label for convenience (usually same as start node) */
  action?: string;
}

/** Server-precomputed trajectory midpoint (index-based) */
export interface PrecomputedTrajectoryMidpoint {
  midPoint: { x: number; y: number };
  /** index into Dataset.data for the start node */
  startIndex: number;
  /** index into Dataset.data for the end node */
  endIndex: number;
  /** Optional: action label for convenience (usually same as start node) */
  action?: string;
}

export interface Dataset {
  data: DataPoint[];
  knnGraph: KnnGraph;
  datasetType: string;
  sourcePath?: string;
  maxEmbeddingDistance?: number;

  // HDBSCAN trees are optional.
  hdbscan?: { hierarchyTree: ClusterTreeNode };
  midpointHdbscan?: { hierarchyTree: ClusterTreeNode };

  // NEW: optional server-precomputed geometry attached to the dataset
  segments?: PrecomputedSegment[];
  trajectoryMidpoints?: PrecomputedTrajectoryMidpoint[];

  /** Resident columnar trajectory geometry (issue #315 phase B1), built by
   * the loaders (worker derivation / precomputed-list conversion). */
  segmentColumns?: SegmentColumns;

  /** Resident typed point columns (issue #315 phase E-a / D2 step 1),
   * decoded from the manifest's binary `dataColumns` sidecar when present.
   * Source of truth for hot-path consumers as the columnar client lands;
   * DataPoint objects are materialized FROM these at load. */
  dataColumns?: import("../dataPreprocessing/columnSidecar").PointColumns;

  /** On-demand render service info (gymnasium datasets; see Gym/renderServiceClient.ts). */
  render?: { envId?: string; endpoint?: string };

  // Optional on-demand inset/tile backend (issue #315). Present only when the
  // manifest declares a `backend:` section; the fully-client-side path is used
  // when absent. Consumed via the `@scaling` seam (stubbed in public builds).
  backend?: BackendManifest;
}
