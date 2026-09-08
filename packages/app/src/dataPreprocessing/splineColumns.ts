// packages/app/src/dataPreprocessing/splineColumns.ts
//
// Columnar Catmull-Rom spline derivation (issue #315, client-side geometry).
//
// Same grouping and sampling semantics as computeSplineGeometry /
// mergePointsIntoSegments (and their Python twin build_splines_and_midpoints),
// but emitting transferable typed-array columns instead of per-segment JS
// objects, so a worker can do the math and hand the result to the main thread
// as a memcpy. Consecutive segments of an edge share their endpoints, so we
// store the (samplesPerEdge + 1) curve knots per edge rather than 2×S endpoint
// pairs; percentages, chord midpoints, arrow flags and nextEdgeCenter are all
// derivable at hydration time from the knot index alone.
//
// Like catmullRom.ts, this module must stay free of rbush / DOM imports so
// worker bundles and jest graphs stay light (type-only imports are fine).

import { catmullRomPoint } from "./catmullRom";
import type { DataPoint, PrecomputedSegment } from "./dataPreprocessing";
import { isLazyRowArray } from "./lazyRows";
import { columnsOf, rawDoiReader } from "./pointColumns";

/** The one shared tessellation constant (Python: --samples-per-edge). */
export const SAMPLES_PER_EDGE = 20;

export interface SplineColumns {
  /** Curve knots, (samplesPerEdge + 1) per edge, edges concatenated. */
  curveX: Float64Array;
  curveY: Float64Array;
  /** Global point index of each edge's start / end point. */
  edgeStart: Int32Array;
  edgeEnd: Int32Array;
  samplesPerEdge: number;
}

/** Total segment count represented by a column set. */
export function splineColumnSegmentCount(cols: SplineColumns): number {
  return cols.edgeStart.length * cols.samplesPerEdge;
}

/** Group global indices by line, preserving input order (first-appearance
 * order across lines — identical to computeSplineGeometry). */
function groupIndicesByLine(line: ArrayLike<number>): Map<number, number[]> {
  const lines = new Map<number, number[]>();
  for (let i = 0; i < line.length; i++) {
    const l = line[i];
    let idxs = lines.get(l);
    if (!idxs) {
      idxs = [];
      lines.set(l, idxs);
    }
    idxs.push(i);
  }
  return lines;
}

/**
 * Edge enumeration alone — the O(n) part of computeSplineColumns without the
 * O(edges × samples) knot sampling. This is all the compact/instanced
 * pipeline needs (issue #315 phase B2): spline geometry is evaluated on
 * demand (GPU, or evalEdgeAt) from the point positions.
 */
export function computeEdgeList(line: ArrayLike<number>): {
  edgeStart: Int32Array;
  edgeEnd: Int32Array;
} {
  const lines = groupIndicesByLine(line);
  let edgeCount = 0;
  lines.forEach((idxs) => {
    if (idxs.length > 1) edgeCount += idxs.length - 1;
  });

  const edgeStart = new Int32Array(edgeCount);
  const edgeEnd = new Int32Array(edgeCount);
  let edge = 0;
  lines.forEach((idxs) => {
    for (let i = 0; i + 1 < idxs.length; i++) {
      edgeStart[edge] = idxs[i];
      edgeEnd[edge] = idxs[i + 1];
      edge++;
    }
  });
  return { edgeStart, edgeEnd };
}

/**
 * Compute spline columns for points ordered by trajectory. Points are grouped
 * by their `line` value (input order preserved within a line, first-appearance
 * order across lines — identical to computeSplineGeometry); edge indices refer
 * to positions in the input arrays.
 */
export function computeSplineColumns(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  line: ArrayLike<number>,
  samplesPerEdge = SAMPLES_PER_EDGE
): SplineColumns {
  const lines = groupIndicesByLine(line);

  let edgeCount = 0;
  lines.forEach((idxs) => {
    if (idxs.length > 1) edgeCount += idxs.length - 1;
  });

  const knotsPerEdge = samplesPerEdge + 1;
  const curveX = new Float64Array(edgeCount * knotsPerEdge);
  const curveY = new Float64Array(edgeCount * knotsPerEdge);
  const edgeStart = new Int32Array(edgeCount);
  const edgeEnd = new Int32Array(edgeCount);

  let edge = 0;
  lines.forEach((idxs) => {
    const m = idxs.length;
    if (m <= 1) return;

    for (let i = 0; i < m - 1; i++) {
      const at = (j: number): number[] => [x[idxs[j]], y[idxs[j]]];
      const p1 = at(i);
      const p2 = at(i + 1);
      const p0 = i > 0 ? at(i - 1) : p1;
      const p3 = i + 2 < m ? at(i + 2) : p2;

      edgeStart[edge] = idxs[i];
      edgeEnd[edge] = idxs[i + 1];

      const base = edge * knotsPerEdge;
      for (let s = 0; s <= samplesPerEdge; s++) {
        const pt = catmullRomPoint(s / samplesPerEdge, p0, p1, p2, p3);
        curveX[base + s] = pt[0];
        curveY[base + s] = pt[1];
      }
      edge++;
    }
  });

  return { curveX, curveY, edgeStart, edgeEnd, samplesPerEdge };
}

// ---------------------------------------------------------------------------
// Resident columnar model (issue #315 phase B1)
//
// Segments never exist as JS objects at runtime: the resident representation
// is one set of typed-array columns per dataset, immutable after load (only
// edgeDoi is rewritten in place on selection changes). Per-segment arrays are
// chosen over shared-knot storage so legacy PrecomputedSegment lists convert
// losslessly (their exact shipped percentages/flags survive).
// ---------------------------------------------------------------------------

export interface SegmentColumns {
  segmentCount: number;
  edgeCount: number;
  segX0: Float64Array;
  segY0: Float64Array;
  segX1: Float64Array;
  segY1: Float64Array;
  segStartPct: Float32Array;
  segEndPct: Float32Array;
  /** 1 on the arrow-bearing (last) sample of each edge. */
  segArrow: Uint8Array;
  /** Segment → edge index. Segments of an edge are contiguous. */
  segEdge: Int32Array;
  /** CSR: segments of edge e live at [edgeSegOffset[e], edgeSegOffset[e+1]). */
  edgeSegOffset: Int32Array;
  /** Edge → point INDEX in the canonical (dataRef-ordered) data array. */
  edgeStart: Int32Array;
  edgeEnd: Int32Array;
  /** Edge → point ID — the renderer resolves ids through its own indexById,
   * which stays correct when streaming reorders the nodes array. */
  edgeStartId: Int32Array;
  edgeEndId: Int32Array;
  /** CPU edge DoI (mean of endpoint DoIs); the annealing filter's input. */
  edgeDoi: Float32Array;
  /**
   * Non-zero ⇒ the per-segment arrays above are VIRTUAL (length 0, issue
   * #315 phase B2): every edge has exactly this many segments, whose
   * geometry is derived on demand from the canonical point positions via
   * evalEdgeAt (the same Catmull-Rom controls the instanced shader uses).
   * Consumers that need segment coordinates must go through the eval
   * helpers and pass the points array. Legacy precomputed-segment datasets
   * keep materialized arrays and leave this unset.
   */
  virtualSamplesPerEdge?: number;
  /**
   * Edge → the start point's `nextEdgeCenter` (issue #315 R1a, A3), written
   * by attachSegmentPointState when the caller opts into `centersInto:
   * "column"`. Present ⇒ the rows carry NO nextEdgeCenter for this dataset
   * and every consumer must read the column (edgeCenterAt). Absent ⇒ the
   * classic per-row write happened, unchanged.
   */
  edgeCenterX?: Float64Array;
  edgeCenterY?: Float64Array;
}

function allocSegmentColumns(segmentCount: number, edgeCount: number): SegmentColumns {
  return {
    segmentCount,
    edgeCount,
    segX0: new Float64Array(segmentCount),
    segY0: new Float64Array(segmentCount),
    segX1: new Float64Array(segmentCount),
    segY1: new Float64Array(segmentCount),
    segStartPct: new Float32Array(segmentCount),
    segEndPct: new Float32Array(segmentCount),
    segArrow: new Uint8Array(segmentCount),
    segEdge: new Int32Array(segmentCount),
    edgeSegOffset: new Int32Array(edgeCount + 1),
    edgeStart: new Int32Array(edgeCount),
    edgeEnd: new Int32Array(edgeCount),
    edgeStartId: new Int32Array(edgeCount),
    edgeEndId: new Int32Array(edgeCount),
    edgeDoi: new Float32Array(edgeCount),
  };
}

/** Shared zero-segment column set — the renderer's "no edges" value (a
 * distinct identity from any real dataset's columns, so identity-based
 * change detection keeps working). */
export const EMPTY_SEGMENT_COLUMNS: SegmentColumns = allocSegmentColumns(0, 0);

/**
 * Expand worker knot columns into the resident per-segment columns.
 * Pure typed-array writes — fast enough to run synchronously (~ms at 775k).
 */
export function expandSplineColumns(
  knots: SplineColumns,
  points: readonly Pick<DataPoint, "id">[]
): SegmentColumns {
  const S = knots.samplesPerEdge;
  const knotsPerEdge = S + 1;
  const edgeCount = knots.edgeStart.length;
  const cols = allocSegmentColumns(edgeCount * S, edgeCount);

  let seg = 0;
  for (let e = 0; e < edgeCount; e++) {
    cols.edgeSegOffset[e] = seg;
    cols.edgeStart[e] = knots.edgeStart[e];
    cols.edgeEnd[e] = knots.edgeEnd[e];
    cols.edgeStartId[e] = points[knots.edgeStart[e]].id;
    cols.edgeEndId[e] = points[knots.edgeEnd[e]].id;
    const base = e * knotsPerEdge;
    for (let s = 0; s < S; s++, seg++) {
      cols.segX0[seg] = knots.curveX[base + s];
      cols.segY0[seg] = knots.curveY[base + s];
      cols.segX1[seg] = knots.curveX[base + s + 1];
      cols.segY1[seg] = knots.curveY[base + s + 1];
      cols.segStartPct[seg] = s / S;
      cols.segEndPct[seg] = (s + 1) / S;
      cols.segArrow[seg] = s === S - 1 ? 1 : 0;
      cols.segEdge[seg] = e;
    }
  }
  cols.edgeSegOffset[edgeCount] = seg;
  return cols;
}

/**
 * Compact resident columns (issue #315 phase B2): edge-level arrays only,
 * per-segment arrays virtual. O(edges) memory instead of O(segments) — the
 * step that takes 1M-point residency from ~780 MB of segment Float64s to
 * ~30 MB of edge arrays.
 */
export function compactSegmentColumns(
  edgeStart: Int32Array,
  edgeEnd: Int32Array,
  samplesPerEdge: number,
  points: readonly Pick<DataPoint, "id">[]
): SegmentColumns {
  const E = edgeStart.length;
  const cols = allocSegmentColumns(0, E);
  cols.segmentCount = E * samplesPerEdge;
  cols.virtualSamplesPerEdge = samplesPerEdge;
  cols.edgeStart = edgeStart;
  cols.edgeEnd = edgeEnd;
  // Columnar id source (issue #315 R1a, A2): ~2M `points[i].id` reads over 1M
  // row objects become two typed-array indexings. Values are identical for
  // every dataset the column model accepts — the canonical id column holds
  // the same finite integers the rows carry (a non-finite id would land as
  // the column's -1 instead of the Int32Array's 0, and fails id validation
  // long before this).
  const pcols = columnsOf(points as readonly DataPoint[]);
  const ids = pcols?.id;
  for (let e = 0; e < E; e++) {
    cols.edgeSegOffset[e] = e * samplesPerEdge;
    cols.edgeStartId[e] = ids ? ids[edgeStart[e]] : points[edgeStart[e]].id;
    cols.edgeEndId[e] = ids ? ids[edgeEnd[e]] : points[edgeEnd[e]].id;
  }
  cols.edgeSegOffset[E] = E * samplesPerEdge;
  return cols;
}

/**
 * Canonical control-point indices (p0,p1,p2,p3) of edge e: neighbors within
 * the same trajectory, clamped to the endpoints at trajectory boundaries —
 * exactly computeSplineColumns' control choice, detected via shared
 * endpoint indices (the same rule GeometrySystem.buildEdgeControlData uses
 * for the GPU path; keep the two in sync).
 */
export function edgeControlIndices(
  cols: SegmentColumns,
  e: number
): [number, number, number, number] {
  const i1 = cols.edgeStart[e];
  const i2 = cols.edgeEnd[e];
  const i0 = e > 0 && cols.edgeEnd[e - 1] === i1 ? cols.edgeStart[e - 1] : i1;
  const i3 = e + 1 < cols.edgeCount && cols.edgeStart[e + 1] === i2 ? cols.edgeEnd[e + 1] : i2;
  return [i0, i1, i2, i3];
}

const scratchP0: number[] = [0, 0];
const scratchP1: number[] = [0, 0];
const scratchP2: number[] = [0, 0];
const scratchP3: number[] = [0, 0];

/** Spline position of edge e at parameter t ∈ [0,1], evaluated from the
 * canonical point positions (virtual-columns replacement for segX/segY). */
export function evalEdgeAt(
  cols: SegmentColumns,
  points: readonly Pick<DataPoint, "x" | "y">[],
  e: number,
  t: number
): { x: number; y: number } {
  const [i0, i1, i2, i3] = edgeControlIndices(cols, e);
  scratchP0[0] = points[i0].x; scratchP0[1] = points[i0].y;
  scratchP1[0] = points[i1].x; scratchP1[1] = points[i1].y;
  scratchP2[0] = points[i2].x; scratchP2[1] = points[i2].y;
  scratchP3[0] = points[i3].x; scratchP3[1] = points[i3].y;
  const pt = catmullRomPoint(t, scratchP0, scratchP1, scratchP2, scratchP3);
  return { x: pt[0], y: pt[1] };
}

/**
 * The three transferable arrays the spline worker consumes (issue #315 R1a,
 * A1). On the sidecar lane they are typed-array COPIES of the decoded views —
 * the exact values the rows hold, without 3N property reads over 1M row
 * objects; copies because postMessage detaches what it transfers and the x/y
 * views are adopted as the canonical point columns. Any other lane (JSON
 * chunks, CSV, uploads, reprojection) keeps the row loop.
 */
export function splineInputColumns(
  points: readonly DataPoint[],
  sidecar?: { count: number; byName: Record<string, ArrayLike<unknown> | undefined> }
): { x: Float64Array; y: Float64Array; line: Float64Array } {
  const n = points.length;
  const by = sidecar && sidecar.count === n ? sidecar.byName : undefined;
  const scX = by?.x;
  const scY = by?.y;
  const scLine = by?.line;
  if (
    scX instanceof Float64Array &&
    scY instanceof Float64Array &&
    ArrayBuffer.isView(scLine) &&
    !(scLine instanceof DataView)
  ) {
    return {
      x: new Float64Array(scX),
      y: new Float64Array(scY),
      line: new Float64Array(scLine as unknown as ArrayLike<number>),
    };
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const line = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    x[i] = p.x;
    y[i] = p.y;
    line[i] = p.line ?? Number.NaN;
  }
  return { x, y, line };
}

/** Spline position of edge e at parameter t, read from POSITION COLUMNS
 * instead of row objects (issue #315 R1a, A3). Same control choice, same
 * scratch buffers, same catmullRomPoint call as evalEdgeAt — on the sidecar
 * lane `x[i]`/`y[i]` are the exact values the rows copied out, so the results
 * are bit-identical. */
export function evalEdgeAtXY(
  cols: SegmentColumns,
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  e: number,
  t: number
): { x: number; y: number } {
  const [i0, i1, i2, i3] = edgeControlIndices(cols, e);
  scratchP0[0] = x[i0]; scratchP0[1] = y[i0];
  scratchP1[0] = x[i1]; scratchP1[1] = y[i1];
  scratchP2[0] = x[i2]; scratchP2[1] = y[i2];
  scratchP3[0] = x[i3]; scratchP3[1] = y[i3];
  const pt = catmullRomPoint(t, scratchP0, scratchP1, scratchP2, scratchP3);
  return { x: pt[0], y: pt[1] };
}

/**
 * The center of edge `e` — the value `nextEdgeCenter` used to hold. Reads the
 * edge-center column when the dataset has one (issue #315 R1a, A3), else the
 * start point's own value (shipped or written by attachSegmentPointState),
 * else the chord fallback.
 */
export function edgeCenterAt(
  cols: SegmentColumns,
  e: number,
  points: readonly Pick<DataPoint, "x" | "y">[],
  startPoint?: Pick<DataPoint, "nextEdgeCenter">
): { x: number; y: number } {
  const cx = cols.edgeCenterX;
  if (cx) return { x: cx[e], y: cols.edgeCenterY![e] };
  const own = startPoint?.nextEdgeCenter;
  if (own && (own.x !== 0 || own.y !== 0)) return own;
  return edgeFallbackCenter(cols, e, points);
}

/**
 * Convert an index-based PrecomputedSegment list (legacy single-file JSON /
 * simple-format pipeline) to resident columns, preserving the shipped
 * percentages and arrow flags verbatim. Consecutive segments sharing
 * (startIndex, endIndex) form one edge — the order both generators emit.
 */
export function columnsFromPrecomputedSegments(
  preSegments: readonly PrecomputedSegment[],
  points: readonly Pick<DataPoint, "id">[]
): SegmentColumns {
  const n = preSegments.length;
  let edgeCount = 0;
  for (let i = 0; i < n; i++) {
    if (
      i === 0 ||
      preSegments[i].startIndex !== preSegments[i - 1].startIndex ||
      preSegments[i].endIndex !== preSegments[i - 1].endIndex
    ) {
      edgeCount++;
    }
  }

  const cols = allocSegmentColumns(n, edgeCount);
  let e = -1;
  for (let i = 0; i < n; i++) {
    const s = preSegments[i];
    if (
      i === 0 ||
      s.startIndex !== preSegments[i - 1].startIndex ||
      s.endIndex !== preSegments[i - 1].endIndex
    ) {
      e++;
      cols.edgeSegOffset[e] = i;
      cols.edgeStart[e] = s.startIndex;
      cols.edgeEnd[e] = s.endIndex;
      cols.edgeStartId[e] = points[s.startIndex]?.id ?? -1;
      cols.edgeEndId[e] = points[s.endIndex]?.id ?? -1;
    }
    cols.segX0[i] = s.x0;
    cols.segY0[i] = s.y0;
    cols.segX1[i] = s.x1;
    cols.segY1[i] = s.y1;
    cols.segStartPct[i] = s.startPercentage;
    cols.segEndPct[i] = s.endPercentage;
    cols.segArrow[i] = s.isArrowSegment ? 1 : 0;
    cols.segEdge[i] = e;
  }
  cols.edgeSegOffset[edgeCount] = n;
  return cols;
}

/**
 * Full fallback derivation from points (legacy CSV datasets without shipped
 * geometry, and in-app reprojection): worker-free, main-thread. Replaces the
 * old getSpline object fallback with the same math.
 */
export function computeSegmentColumnsForPoints(points: readonly DataPoint[]): SegmentColumns {
  const n = points.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const line = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = points[i].x;
    y[i] = points[i].y;
    line[i] = points[i].line ?? Number.NaN;
  }
  return expandSplineColumns(computeSplineColumns(x, y, line), points);
}

/** Compact (virtual-segment) variant of computeSegmentColumnsForPoints —
 * O(points) work and O(edges) memory; no knot sampling at all. */
export function computeCompactColumnsForPoints(
  points: readonly DataPoint[],
  samplesPerEdge = SAMPLES_PER_EDGE
): SegmentColumns {
  const n = points.length;
  // Columnar line source on the row-lazy lane only (issue #315 R1b): there
  // the rows do not exist yet, and every row that WOULD exist is built from
  // this very column, so the values are identical by construction. Every
  // other lane keeps the row read — a row whose `line` is missing reads NaN,
  // which the column (holding attachPointColumns' -1 sentinel) cannot
  // reproduce, and NaN vs -1 changes how computeEdgeList splits trajectories.
  const cols = isLazyRowArray(points) ? columnsOf(points) : null;
  const line = new Float64Array(n);
  if (cols) line.set(cols.line);
  else for (let i = 0; i < n; i++) line[i] = points[i].line ?? Number.NaN;
  const { edgeStart, edgeEnd } = computeEdgeList(line);
  return compactSegmentColumns(edgeStart, edgeEnd, samplesPerEdge, points);
}

export interface AttachSegmentPointStateOptions {
  signal?: AbortSignal;
  /** Synthesize the PrecomputedSegment export copy (see
   * KEEP_PRECOMPUTED_EXPORT_LIMIT in DatasetLoader). */
  keepExportCopy?: boolean;
  /** Edges (nextEdgeCenter pass) / objects (export copy) processed per batch
   * before yielding. */
  batchSize?: number;
  yieldFn?: () => Promise<void>;
  onProgress?: (fraction: number) => void;
  /** Chunk the O(edges) nextEdgeCenter pass, yielding every `batchSize` edges
   * (issue #315 non-blocking ingestion). Only safe when the caller awaits full
   * completion before any consumer reads nextEdgeCenter — a partially-filled
   * pass makes downstream midpoint builds fall back to a different center.
   * Default false keeps the pass fully synchronous (no `await`). */
  sliceCenters?: boolean;
  /**
   * Write the edge centers into a COLUMN on `cols` instead of onto the rows
   * (issue #315 R1a, A3). Only for born-column-backed rows (the sidecar
   * lane): those never carry a shipped `nextEdgeCenter`, so the guard the row
   * pass needs has nothing to protect, and the pass stops touching 1M row
   * objects — it reads positions from the columns and allocates two
   * Float64Arrays instead of ~1M center objects. Consumers read the result
   * through `edgeCenterAt`. Ignored on materialized-segment (non-virtual)
   * columns, which keep the row pass.
   */
  centersInto?: "rows" | "column";
}

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Write the per-point state derived from segments — `nextEdgeCenter` via the
 * straddle rule with the shipped-value-wins guard (identical semantics to the
 * retired object hydration) — and optionally synthesize the export copy.
 */
export async function attachSegmentPointState(
  dataArray: DataPoint[],
  cols: SegmentColumns,
  options: AttachSegmentPointStateOptions = {}
): Promise<{ exportSegments?: PrecomputedSegment[] }> {
  const { signal, keepExportCopy } = options;
  const batchSize = options.batchSize ?? 24000;
  const yieldFn = options.yieldFn ?? defaultYield;

  const S = cols.virtualSamplesPerEdge ?? 0;

  // The nextEdgeCenter derivation is O(edges) with two Catmull-Rom evaluations
  // per edge (virtual columns) — a ~975k-edge pass at 1M points that blocked a
  // boot frame for hundreds of ms. Each edge is independent (it writes only its
  // own start point's nextEdgeCenter), so when `sliceCenters` is set the pass
  // chunks and yields to the event loop every `batchSize` edges; the written
  // values are bit-identical to the unsliced loop (issue #315).
  //
  // Default OFF: legacy callers that fire-and-forget this function rely on the
  // nextEdgeCenter pass finishing synchronously before a later midpoint build
  // reads it (a not-yet-set center would fall back to edgeFallbackCenter, a
  // DIFFERENT value). Only callers that AWAIT completion before any consumer
  // runs (the manifest loader) opt in. When off, the branches below take no
  // `await` at all, so the pass stays fully synchronous.
  const sliceCenters = options.sliceCenters ?? false;
  let sinceYieldCenters = 0;

  const pcols = columnsOf(dataArray);
  const centersIntoColumn = options.centersInto === "column" && S > 0 && pcols !== null;

  if (centersIntoColumn) {
    // Columnar center pass (issue #315 R1a, A3): same sMid, same two spline
    // evaluations, same averaging — only the source (position columns) and
    // the destination (edge columns) differ, so the values are bit-identical
    // to the row pass below.
    let sMid = 0;
    for (let s = 0; s < S; s++) {
      if (s / S <= 0.5 && (s + 1) / S >= 0.5) { sMid = s; break; }
    }
    const px = pcols!.x;
    const py = pcols!.y;
    const cx = new Float64Array(cols.edgeCount);
    const cy = new Float64Array(cols.edgeCount);
    for (let e = 0; e < cols.edgeCount; e++) {
      const a = evalEdgeAtXY(cols, px, py, e, sMid / S);
      const b = evalEdgeAtXY(cols, px, py, e, (sMid + 1) / S);
      cx[e] = (a.x + b.x) / 2;
      cy[e] = (a.y + b.y) / 2;
      if (sliceCenters && ++sinceYieldCenters >= batchSize) {
        sinceYieldCenters = 0;
        if (signal?.aborted) throw new DOMException("Dataset load aborted", "AbortError");
        await yieldFn();
      }
    }
    cols.edgeCenterX = cx;
    cols.edgeCenterY = cy;
  } else if (S > 0) {
    // Virtual columns: the straddling sample index is edge-independent
    // (segStartPct = s/S), so resolve it once, then evaluate the two spline
    // samples per edge — identical values to the expanded-columns loop.
    let sMid = 0;
    for (let s = 0; s < S; s++) {
      if (s / S <= 0.5 && (s + 1) / S >= 0.5) { sMid = s; break; }
    }
    for (let e = 0; e < cols.edgeCount; e++) {
      const p = dataArray[cols.edgeStart[e]];
      if (!(p.nextEdgeCenter && (p.nextEdgeCenter.x !== 0 || p.nextEdgeCenter.y !== 0))) {
        const a = evalEdgeAt(cols, dataArray, e, sMid / S);
        const b = evalEdgeAt(cols, dataArray, e, (sMid + 1) / S);
        p.nextEdgeCenter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      if (sliceCenters && ++sinceYieldCenters >= batchSize) {
        sinceYieldCenters = 0;
        if (signal?.aborted) throw new DOMException("Dataset load aborted", "AbortError");
        await yieldFn();
      }
    }
  } else {
    for (let e = 0; e < cols.edgeCount; e++) {
      const p = dataArray[cols.edgeStart[e]];
      if (!(p.nextEdgeCenter && (p.nextEdgeCenter.x !== 0 || p.nextEdgeCenter.y !== 0))) {
        const from = cols.edgeSegOffset[e];
        const to = cols.edgeSegOffset[e + 1];
        for (let s = from; s < to; s++) {
          if (cols.segStartPct[s] <= 0.5 && cols.segEndPct[s] >= 0.5) {
            p.nextEdgeCenter = {
              x: (cols.segX0[s] + cols.segX1[s]) / 2,
              y: (cols.segY0[s] + cols.segY1[s]) / 2,
            };
            break;
          }
        }
      }
      if (sliceCenters && ++sinceYieldCenters >= batchSize) {
        sinceYieldCenters = 0;
        if (signal?.aborted) throw new DOMException("Dataset load aborted", "AbortError");
        await yieldFn();
      }
    }
  }

  if (!keepExportCopy) return {};

  const exportSegments: PrecomputedSegment[] = [];
  let sinceYield = 0;
  for (let e = 0; e < cols.edgeCount; e++) {
    if (signal?.aborted) throw new DOMException("Dataset load aborted", "AbortError");
    const startIndex = cols.edgeStart[e];
    const endIndex = cols.edgeEnd[e];
    const action = dataArray[startIndex]?.action;
    const from = cols.edgeSegOffset[e];
    const to = cols.edgeSegOffset[e + 1];
    for (let s = from; s < to; s++) {
      let x0: number, y0: number, x1: number, y1: number, startPct: number, endPct: number, arrow: boolean;
      if (S > 0) {
        const local = s - e * S;
        const a = evalEdgeAt(cols, dataArray, e, local / S);
        const b = evalEdgeAt(cols, dataArray, e, (local + 1) / S);
        // fround: the expanded columns stored percentages as Float32, so the
        // legacy export carried float32-rounded values — stay byte-identical.
        startPct = Math.fround(local / S);
        endPct = Math.fround((local + 1) / S);
        x0 = a.x; y0 = a.y; x1 = b.x; y1 = b.y;
        arrow = local === S - 1;
      } else {
        x0 = cols.segX0[s]; y0 = cols.segY0[s];
        x1 = cols.segX1[s]; y1 = cols.segY1[s];
        startPct = cols.segStartPct[s];
        endPct = cols.segEndPct[s];
        arrow = cols.segArrow[s] === 1;
      }
      exportSegments.push({
        x0, y0, x1, y1,
        startIndex,
        endIndex,
        startPercentage: startPct,
        endPercentage: endPct,
        splineMidPoint: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
        isArrowSegment: arrow,
        doi: 0,
        action,
      });
      sinceYield++;
      if (sinceYield >= batchSize && exportSegments.length < cols.segmentCount) {
        sinceYield = 0;
        options.onProgress?.(exportSegments.length / cols.segmentCount);
        await yieldFn();
      }
    }
  }
  return { exportSegments };
}

/** Recompute every edge's doi as the mean of its endpoints' DoI. */
export function updateEdgeColumnDois(
  cols: SegmentColumns | null,
  points: readonly DataPoint[]
): void {
  if (!cols) return;
  const pcols = columnsOf(points);
  if (pcols) {
    // edgeStart/edgeEnd are canonical point indices, so the DoI column is
    // indexable without the per-point accessor. `?? 0` reproduces the object
    // path's guard for out-of-range indices (typed-array OOB read → undefined).
    const doi = pcols.doi;
    for (let e = 0; e < cols.edgeCount; e++) {
      const d0 = doi[cols.edgeStart[e]] ?? 0;
      const d1 = doi[cols.edgeEnd[e]] ?? 0;
      cols.edgeDoi[e] = 0.5 * (d0 + d1);
    }
    return;
  }
  const readDoi = rawDoiReader(points);
  for (let e = 0; e < cols.edgeCount; e++) {
    const p0 = points[cols.edgeStart[e]];
    const p1 = points[cols.edgeEnd[e]];
    const d0 = p0 ? readDoi(p0) : 0;
    const d1 = p1 ? readDoi(p1) : 0;
    cols.edgeDoi[e] = 0.5 * (d0 + d1);
  }
}

/** Chord midpoint of the middle segment of an edge — the legacy midpoint
 * fallback center (`segs[floor(len/2)].splineMidPoint`). Virtual columns
 * derive it from the point positions and REQUIRE `points`. */
export function edgeFallbackCenter(
  cols: SegmentColumns,
  e: number,
  points?: readonly Pick<DataPoint, "x" | "y">[]
): { x: number; y: number } {
  const S = cols.virtualSamplesPerEdge ?? 0;
  if (S > 0) {
    if (!points) throw new Error("edgeFallbackCenter: virtual columns need the points array");
    const s = Math.floor(S / 2);
    const a = evalEdgeAt(cols, points, e, s / S);
    const b = evalEdgeAt(cols, points, e, (s + 1) / S);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  const from = cols.edgeSegOffset[e];
  const to = cols.edgeSegOffset[e + 1];
  const s = from + Math.floor((to - from) / 2);
  return { x: (cols.segX0[s] + cols.segX1[s]) / 2, y: (cols.segY0[s] + cols.segY1[s]) / 2 };
}

