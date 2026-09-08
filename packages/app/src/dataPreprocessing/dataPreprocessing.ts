import rbush from "rbush";
import { NODE_DOI_RENDER_THRESHOLD } from "../utils/constants";
import { rawDoiOfPoint } from "./pointColumns";

// New types for data features.
export type DataFeatureValue = string | number | boolean | undefined;
export interface DataFeatures { [key: string]: DataFeatureValue; }

// Added new type for DOI grouping.
export type DoiGroup = "gray" | "transparent" | "annotation" | "inset";

/**
 * DataPoint represents a single node with an (x, y) position,
 * line membership, etc.
 */
export interface DataPoint {
  x: number;
  y: number;
  line: number;
  algo: string;
  id: number;
  action: string;
  selected?: boolean;
  DoI: number;
  doiGroup?: DoiGroup;
  annotationClusterId?: number | string;
  insetClusterId?: number | string;
  features?: DataFeatures;
  /** Position halfway along the next-edge spline segment */
  nextEdgeCenter: { x: number; y: number };
  /**
   * Canonical pixel payload for image datasets (CCTV/MNIST), extracted from
   * the inlined "1x1".."WxH" JSON keys by the parse worker (see pixelGrid.ts
   * for the buffer order). Absent on non-image and legacy-loaded datasets.
   */
  pixels?: Uint8Array | Float32Array;
  pixelsWidth?: number;
  pixelsHeight?: number;
}

export function createEmptyDataPoint(): DataPoint {
  return {
    x: 0,
    y: 0,
    line: 0,
    algo: "",
    id: 0,
    action: "",
    selected: false,
    DoI: 0,
    nextEdgeCenter: { x: 0, y: 0 },
  };
}

/**
 * SplineSegment represents a small segment of a Catmull-Rom or similar spline.
 *
 * @deprecated Runtime geometry is columnar since issue #315 phase B1
 * (SegmentColumns in ./splineColumns). This object shape survives only as the
 * type surface of the unused imagePrecomputation module.
 */
export interface SplineSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  data: {
    nextDataPoint: DataPoint;
    lastDataPoint: DataPoint;
    doi: number;
    startPercentage: number;
    endPercentage: number;
    segmentId: number;
    splineMidPoint: { x: number; y: number };
    isArrowSegment?: boolean;
  };
}

// ---------- NEW: server-precomputed geometry shapes ----------
export interface PrecomputedSegment {
  x0: number; y0: number; x1: number; y1: number;
  startIndex: number; endIndex: number;
  startPercentage: number; endPercentage: number;
  splineMidPoint: { x: number; y: number };
  isArrowSegment?: boolean;
  doi?: number;
  action?: string;
}
export interface PrecomputedTrajectoryMidpoint {
  midPoint: { x: number; y: number };
  startIndex: number;
  endIndex: number;
  action?: string;
}

// Unique ID generators
const createUniqueIdGenerator = () => { let currentId = 0; return () => currentId++; };
let nextNodeId = 0;
const generateTrajectoryMidpointId = createUniqueIdGenerator();

/**
 * Initialize data points by adding default fields and a unique id.
 * PERFORMANCE-CRITICAL: preserve server-provided nextEdgeCenter if present.
 */
export function initializePoints(data: DataPoint[]): DataPoint[] {
  return data.map((d) => ({
    ...d,
    id: d.id !== undefined ? d.id : nextNodeId++,
    selected: false,
    DoI: d.DoI ?? 1,
    nextEdgeCenter: d.nextEdgeCenter ?? { x: 0, y: 0 }, // <-- PRESERVE if provided
  }));
}

/** Create an R-Tree from an array of data points (ALL). */
export function createRTree(data: DataPoint[]): rbush<RTreeItem<DataPoint>> {
  const tree = new rbush<RTreeItem<DataPoint>>();
  const items: RTreeItem<DataPoint>[] = data.map((d) => ({
    minX: d.x, minY: d.y, maxX: d.x, maxY: d.y, data: d,
  }));
  tree.load(items);
  return tree;
}

export interface RTreeItem<T> {
  minX: number; minY: number; maxX: number; maxY: number; data: T;
}

export function buildAllPointRTree(initializedData: DataPoint[]): rbush<RTreeItem<DataPoint>> {
  const allPointTree = new rbush<RTreeItem<DataPoint>>();
  const padding = 0.5;
  allPointTree.load(
    initializedData.map((p) => ({
      minX: p.x - padding, minY: p.y - padding,
      maxX: p.x + padding, maxY: p.y + padding,
      data: p,
    }))
  );
  return allPointTree;
}

/** Group data points by their "line" property. */
export function groupPointsByLine(data: DataPoint[]): DataPoint[][] {
  const lines = new Map<number, DataPoint[]>();
  data.forEach((point) => {
    const { line } = point;
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line)!.push(point);
  });
  return Array.from(lines.values());
}

export interface TrajectoryMidpoint {
  id: number;
  midPoint: { x: number; y: number };
  startPoint: DataPoint;
  endPoint: DataPoint;
  action: string;
  DoI: number;
  clusterId?: string;
}

/** Build an R-Tree for the midpoints of each trajectory. (Precomputed or fallback) */
export function buildTrajectoryMidpointRTree(
  dataArray: DataPoint[],
  precomputed?: PrecomputedTrajectoryMidpoint[] | null
): { tree: rbush<RTreeItem<TrajectoryMidpoint>>; midpoints: TrajectoryMidpoint[] } {
  const tree = new rbush<RTreeItem<TrajectoryMidpoint>>();
  let trajectoryMidpoints: TrajectoryMidpoint[];

  if (precomputed?.length) {
    trajectoryMidpoints = precomputed.map((m) => {
      const startPoint = dataArray[m.startIndex];
      const endPoint = dataArray[m.endIndex];
      return {
        id: generateTrajectoryMidpointId(),
        midPoint: { x: m.midPoint.x, y: m.midPoint.y },
        startPoint,
        endPoint,
        action: m.action ?? startPoint.action,
        DoI: 0.5 * ((startPoint.DoI ?? 0) + (endPoint.DoI ?? 0)),
      };
    });
  } else {
    // legacy: recompute from lines + nextEdgeCenter (which may be populated by server)
    const dataPerLineArray = groupPointsByLine(dataArray);
    trajectoryMidpoints = [];
    dataPerLineArray.forEach((trajectory) => {
      for (let i = 0; i < trajectory.length - 1; i++) {
        const startPoint = trajectory[i];
        const endPoint = trajectory[i + 1];
        const mid = startPoint.nextEdgeCenter ?? {
          x: (startPoint.x + endPoint.x) / 2, y: (startPoint.y + endPoint.y) / 2,
        };
        trajectoryMidpoints.push({
          id: generateTrajectoryMidpointId(),
          midPoint: mid,
          startPoint,
          endPoint,
          action: startPoint.action,
          DoI: 0.5 * ((startPoint.DoI ?? 0) + (endPoint.DoI ?? 0)),
        });
      }
    });
  }

  tree.load(trajectoryMidpoints.map((m) => ({
    minX: m.midPoint.x, minY: m.midPoint.y, maxX: m.midPoint.x, maxY: m.midPoint.y, data: m,
  })));

  return { tree, midpoints: trajectoryMidpoints };
}

/** Raw DoI read that bypasses the DoI accessor (issue #315: the getter costs
 * ~97 ms per ~4M reads at 1M points). The column linkage moved to symbol
 * keys (issue #315 B2), so the read lives in pointColumns. */
const rawPointDoi = rawDoiOfPoint;

/** Update the DoI value for each trajectory midpoint. */
export function updateTrajectoryMidpointDoIs(midpoints: TrajectoryMidpoint[]): void {
  for (let i = 0, len = midpoints.length; i < len; i++) {
    const mp = midpoints[i];
    mp.DoI = 0.5 * (rawPointDoi(mp.startPoint) + rawPointDoi(mp.endPoint));
  }
}

/** High-DOI filters unchanged */
export function buildHighDoiPointRTree(data: DataPoint[]): rbush<RTreeItem<DataPoint>> {
  const tree = new rbush<RTreeItem<DataPoint>>();
  const above = data.filter((d) => (d.DoI ?? 0) >= NODE_DOI_RENDER_THRESHOLD);
  tree.load(above.map((d) => ({ minX: d.x, minY: d.y, maxX: d.x, maxY: d.y, data: d })));
  return tree;
}
