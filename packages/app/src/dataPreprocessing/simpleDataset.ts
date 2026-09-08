// packages/app/src/dataPreprocessing/simpleDataset.ts
//
// Simple-format loading path (issues #217/#218): turns a projected tabular
// dataset (x/y columns, arbitrary feature columns, optional trajectory /
// order / action columns) into an object shaped exactly like the bespoke
// JSON produced offline by preprocess_dataset_generate_knng.py — data
// records, kNN graph, spline segments, trajectory midpoints, and both
// HDBSCAN hierarchies. Everything here is pure and synchronous so it can
// run inside simplePreprocess.worker.ts and directly in jest.

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import type {
  PrecomputedSegment,
  PrecomputedTrajectoryMidpoint,
} from "../types/datasetTypes";
import { buildHdbscanHierarchy } from "./hdbscanHierarchy";
import { computeKnnGraph } from "./knnGraph";
import { SAMPLES_PER_EDGE } from "./splineColumns";
import { computeSplineGeometry } from "./splineGeometry";

/** Neighborhood size of the in-app kNN graph (self-inclusive, sklearn-style). */
export const SIMPLE_KNN_K = 5;

/**
 * Core-distance neighbor count, mirroring the minSamples of the runtime
 * slow path in hdbscanClustering.ts (minClusterSize is irrelevant here —
 * buildHdbscanHierarchy keeps the full single-linkage tree, which is what
 * minClusterSize: 1 produced).
 */
const HDBSCAN_MIN_SAMPLES = 1;

export interface SimpleColumnMapping {
  /** Column with the projected x coordinate (required). */
  x: string;
  /** Column with the projected y coordinate (required). */
  y: string;
  /** Between-trajectory index column; omitted ⇒ no trajectories (scatter only). */
  trajectory?: string;
  /** Within-trajectory order column; omitted ⇒ input row order is kept. */
  order?: string;
  /** Action label column (annotates edges/midpoints). */
  action?: string;
  /** Class/label column: copied into each record's `label` field (like the
   *  action copy) so the standard label chain shows it without a trip to the
   *  vis-encoding tab (#305). The source column stays a feature column. */
  label?: string;
}

export interface SimpleDatasetOptions {
  datasetType?: string;
  /** Neighborhood size for the kNN graph. Default SIMPLE_KNN_K. */
  k?: number;
  samplesPerEdge?: number;
}

export type SimplePreprocessPhase =
  | "normalize"
  | "knn"
  | "geometry"
  | "clusterPoints"
  | "clusterMidpoints";

/** One DataPoint-shaped record (features live top-level, like all datasets). */
export type SimpleDataRecord = Record<string, unknown> & {
  x: number;
  y: number;
  line: number;
  id: number;
};

export interface SimpleDatasetObject {
  data: SimpleDataRecord[];
  knnGraph: number[][];
  hdbscan?: { hierarchyTree: ClusterTreeNode };
  midpointHdbscan?: { hierarchyTree: ClusterTreeNode };
  segments: PrecomputedSegment[];
  trajectoryMidpoints: PrecomputedTrajectoryMidpoint[];
  datasetType: string;
  /** Rows dropped because x/y were missing or non-numeric. */
  droppedRowCount: number;
}

// Fields the pipeline computes itself; same-named CSV columns are ignored
// (except the ones the mapping explicitly consumes).
const RESERVED_FIELDS = new Set(["x", "y", "line", "id", "nextEdgeCenter"]);

const toNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
};

/** Coerce a CSV cell for feature storage: numeric strings become numbers. */
const coerceFeatureValue = (value: unknown): string | number | boolean | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const s = String(value);
  if (s.trim() === "") return undefined;
  const n = Number(s);
  if (Number.isFinite(n) && s.trim() !== "") return n;
  return s;
};

export interface NormalizedSimpleRows {
  points: SimpleDataRecord[];
  droppedRowCount: number;
}

/**
 * Coerce raw parsed rows into DataPoint-shaped records: numeric x/y (rows
 * with non-finite coordinates are dropped), dense numeric `line` ids from
 * the trajectory column (first-appearance order), a stable sort by
 * (line, order) when an order column is mapped, and all remaining columns
 * passed through as top-level features (numeric strings coerced).
 */
export function normalizeSimpleRows(
  rows: readonly Record<string, unknown>[],
  mapping: SimpleColumnMapping
): NormalizedSimpleRows {
  const lineIdByKey = new Map<string, number>();
  interface Staged {
    record: Record<string, unknown>;
    line: number;
    order: number;
  }
  const staged: Staged[] = [];
  let dropped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const x = toNumber(row[mapping.x]);
    const y = toNumber(row[mapping.y]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      dropped++;
      continue;
    }

    let line: number;
    if (mapping.trajectory !== undefined) {
      const key = String(row[mapping.trajectory]);
      let id = lineIdByKey.get(key);
      if (id === undefined) {
        id = lineIdByKey.size;
        lineIdByKey.set(key, id);
      }
      line = id;
    } else {
      // No trajectory column: every point is its own single-point line.
      line = staged.length;
    }

    const order =
      mapping.order !== undefined ? toNumber(row[mapping.order]) : staged.length;

    const record: Record<string, unknown> = {};
    for (const key in row) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
      // The x/y source columns stay as features (unless their names collide
      // with computed fields): for datasets projected onto two of their own
      // feature columns (e.g. iris petal dims), those columns must still
      // show up in feature search and the tabular summary insets.
      if (RESERVED_FIELDS.has(key)) continue;
      const value = coerceFeatureValue(row[key]);
      if (value !== undefined) record[key] = value;
    }
    if (mapping.action !== undefined && row[mapping.action] !== undefined) {
      record.action = String(row[mapping.action]);
    }
    if (mapping.label !== undefined && row[mapping.label] !== undefined) {
      // Same convention bespoke default-type datasets use: the standard label
      // chain reads the `label` field (DEFAULT_LABEL_FEATURE), so the copy
      // makes cluster labels show the mapped column with no settings change.
      record.label = String(row[mapping.label]);
    }
    record.x = x;
    record.y = y;

    staged.push({ record, line, order: Number.isFinite(order) ? order : staged.length });
  }

  staged.sort((a, b) => a.line - b.line || a.order - b.order);

  const points: SimpleDataRecord[] = staged.map((s, idx) => {
    s.record.line = s.line;
    s.record.id = idx;
    return s.record as SimpleDataRecord;
  });

  return { points, droppedRowCount: dropped };
}

/**
 * Run the full simple-format preprocessing synchronously (heavy — call from
 * a worker for real datasets). Mirrors process_dataset() in
 * preprocess_dataset_generate_knng.py. `onPhase` fires once per phase entry;
 * `onProgress` streams 0..1 fractions within the two clustering phases (the
 * dominant cost at scale).
 */
export function buildSimpleDatasetObject(
  rows: readonly Record<string, unknown>[],
  mapping: SimpleColumnMapping,
  options: SimpleDatasetOptions = {},
  onPhase?: (phase: SimplePreprocessPhase) => void,
  onProgress?: (phase: SimplePreprocessPhase, fraction: number) => void
): SimpleDatasetObject {
  onPhase?.("normalize");
  const { points, droppedRowCount } = normalizeSimpleRows(rows, mapping);

  onPhase?.("knn");
  const knnGraph = computeKnnGraph(points, options.k ?? SIMPLE_KNN_K);

  onPhase?.("geometry");
  const geometry = computeSplineGeometry(
    points as unknown as { x: number; y: number; line: number; action?: string }[],
    options.samplesPerEdge ?? SAMPLES_PER_EDGE
  );
  geometry.nextEdgeCenter.forEach((center, startIndex) => {
    points[startIndex].nextEdgeCenter = center;
  });

  onPhase?.("clusterPoints");
  let hdbscan: SimpleDatasetObject["hdbscan"];
  if (points.length >= 2) {
    const tree = buildHdbscanHierarchy(points, {
      minSamples: HDBSCAN_MIN_SAMPLES,
      onProgress: onProgress && ((f) => onProgress("clusterPoints", f)),
    });
    if (tree) hdbscan = { hierarchyTree: tree };
  }

  onPhase?.("clusterMidpoints");
  let midpointHdbscan: SimpleDatasetObject["midpointHdbscan"];
  if (geometry.trajectoryMidpoints.length >= 2) {
    const tree = buildHdbscanHierarchy(
      geometry.trajectoryMidpoints.map((m) => m.midPoint),
      {
        minSamples: HDBSCAN_MIN_SAMPLES,
        onProgress: onProgress && ((f) => onProgress("clusterMidpoints", f)),
      }
    );
    if (tree) midpointHdbscan = { hierarchyTree: tree };
  }

  return {
    data: points,
    knnGraph,
    hdbscan,
    midpointHdbscan,
    segments: geometry.segments,
    trajectoryMidpoints: geometry.trajectoryMidpoints,
    datasetType: (options.datasetType ?? "default").toLowerCase(),
    droppedRowCount,
  };
}

// ---------------------------------------------------------------------------
// Column-mapping inference (wizard defaults / predefined CSV entries)
// ---------------------------------------------------------------------------

const X_CANDIDATES = ["x", "umap_x", "proj_x", "x0", "dim_0", "dim0"];
const Y_CANDIDATES = ["y", "umap_y", "proj_y", "y0", "dim_1", "dim1"];
const TRAJECTORY_CANDIDATES = ["line", "trajectory", "traj", "episode", "game", "track", "run"];
const ORDER_CANDIDATES = ["step", "order", "t", "time", "frame", "tick"];
const ACTION_CANDIDATES = ["action"];
const LABEL_CANDIDATES = ["label", "class", "target", "category", "species", "variety"];

function matchHeader(headers: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) return headers[idx];
  }
  return undefined;
}

/**
 * Best-effort column-role defaults from CSV headers. `x`/`y` may come back
 * undefined — callers must require them before building the dataset.
 */
export function inferSimpleColumnMapping(
  headers: readonly string[]
): Partial<SimpleColumnMapping> {
  return {
    x: matchHeader(headers, X_CANDIDATES),
    y: matchHeader(headers, Y_CANDIDATES),
    trajectory: matchHeader(headers, TRAJECTORY_CANDIDATES),
    order: matchHeader(headers, ORDER_CANDIDATES),
    action: matchHeader(headers, ACTION_CANDIDATES),
    label: matchHeader(headers, LABEL_CANDIDATES),
  };
}
