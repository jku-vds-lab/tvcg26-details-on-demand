import type { DataPoint } from "../../../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../../../dataPreprocessing/pointColumns";
import type { SegmentColumns } from "../../../dataPreprocessing/splineColumns";

export const EDGE_FLOATS_PER_VERT = 16;
export const ARROW_FLOATS_PER_VERT = 11;

export type EdgeGeometryBuildResult = {
  edgeVerts: Float32Array;
  edgeIdx: Uint16Array | Uint32Array;
  edgeIndexType: number;
  edgeIndexCount: number;
  vertexCount: number;
};

export type ArrowGeometryBuildResult = {
  arrowVerts: Float32Array;
  arrowCount: number; // vertex count
};

export function segmentCountOf(edges: SegmentColumns | null): number {
  return edges?.segmentCount ?? 0;
}

/**
 * Samples-per-edge if the columns are uniformly tessellated (every edge has
 * exactly S segments, in edge order) — the precondition for the instanced
 * edge path's `edge = instance / S` decomposition. Columns from
 * expandSplineColumns always qualify; legacy precomputed-segment datasets
 * may not, and return null → CPU fallback path.
 */
export function uniformSamplesPerEdge(edges: SegmentColumns | null): number | null {
  if (!edges || edges.edgeCount === 0) return null;
  // Virtual columns (issue #315 phase B2) are uniform by construction.
  if (edges.virtualSamplesPerEdge) return edges.virtualSamplesPerEdge;
  const S = edges.segmentCount / edges.edgeCount;
  if (!Number.isInteger(S) || S <= 0) return null;
  for (let e = 0; e <= edges.edgeCount; e++) {
    if (edges.edgeSegOffset[e] !== e * S) return null;
  }
  return S;
}

/**
 * Mean edge chord length in DATA units (issue #315 C2 → R1a): drives the
 * zoom-adaptive tessellation of the instanced edge path. Columnar fast path
 * (edgeStart/edgeEnd are canonical indices into the mirrored x/y columns);
 * the row walk stays for non-column-backed arrays, where a missing endpoint
 * (load streaming beyond the prefix) contributes nothing.
 */
export function meanEdgeChordDataLen(edges: SegmentColumns, nodes: DataPoint[]): number {
  const E = edges.edgeCount;
  if (E <= 0) return 0;
  let sum = 0;
  const cols = columnsOf(nodes);
  if (cols) {
    const { x, y } = cols;
    for (let e = 0; e < E; e++) {
      const ai = edges.edgeStart[e];
      const bi = edges.edgeEnd[e];
      sum += Math.hypot(x[bi] - x[ai], y[bi] - y[ai]);
    }
  } else {
    for (let e = 0; e < E; e++) {
      const a = nodes[edges.edgeStart[e]];
      const b = nodes[edges.edgeEnd[e]];
      if (a && b) sum += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return sum / E;
}

export class GeometrySystem {
  buildIndexById(nodes: DataPoint[], maxNodes = nodes.length): Map<number, number> {
    const count = Math.max(0, Math.min(maxNodes, nodes.length));
    const indexById = new Map<number, number>();
    // Columnar fast path (issue #315 R1b), like buildNodePositions above: the
    // canonical id column holds exactly the ids the rows carry, and on the
    // row-lazy lane the rows do not exist — this Map is built lazily, but it
    // IS built (the CPU edge fallback passes it eagerly as an argument).
    const cols = columnsOf(nodes);
    if (cols) {
      for (let i = 0; i < count; i++) indexById.set(cols.id[i], i);
      return indexById;
    }
    for (let i = 0; i < count; i++) indexById.set(nodes[i].id, i);
    return indexById;
  }

  buildNodePositions(nodes: DataPoint[], maxNodes = nodes.length): Float32Array {
    const count = Math.max(0, Math.min(maxNodes, nodes.length));
    const out = new Float32Array(count * 2);
    // Columnar fast path (issue #315 D2).
    const cols = columnsOf(nodes);
    if (cols) {
      for (let i = 0; i < count; i++) {
        const base = i * 2;
        out[base + 0] = cols.x[i];
        out[base + 1] = cols.y[i];
      }
      return out;
    }
    for (let i = 0; i < count; i++) {
      const base = i * 2;
      out[base + 0] = nodes[i].x;
      out[base + 1] = nodes[i].y;
    }
    return out;
  }

  /**
   * Columns-direct twin of buildNodePositions (issue #315 B1 boot paint):
   * interleaved x/y straight from the decoded sidecar views — no DataPoint[]
   * involved. Callers must have verified the x/y columns exist.
   */
  buildNodePositionsFromColumns(
    // ArrayLike<unknown>: dictionary columns (sidecar FORMAT v2) ride along in
    // byName; x/y are always numeric typed views (emitter-enforced).
    cols: { count: number; byName: Record<string, ArrayLike<unknown> | undefined> },
    maxNodes = cols.count
  ): Float32Array {
    const count = Math.max(0, Math.min(maxNodes, cols.count));
    const out = new Float32Array(count * 2);
    const x = cols.byName["x"] as ArrayLike<number> | undefined;
    const y = cols.byName["y"] as ArrayLike<number> | undefined;
    if (!x || !y) return out;
    for (let i = 0; i < count; i++) {
      const base = i * 2;
      out[base + 0] = x[i];
      out[base + 1] = y[i];
    }
    return out;
  }

  /**
   * Per-edge Catmull-Rom control data for the instanced edge path (issue
   * #315 phase B2): RGBA per edge = renderer node indices of p0,p1,p2,p3.
   * p0/p3 come from the neighboring edge of the same trajectory (detected
   * via shared canonical endpoint indices) and are clamped to p1/p2 at
   * trajectory ends — exactly computeSplineColumns' control choice, so the
   * shader reproduces the CPU spline. Edges whose endpoints aren't in
   * indexById yet (load streaming) get p1 = -1 and render degenerate.
   * O(edges) — replaces the O(segments×4×16) CPU vertex expansion.
   */
  /**
   * Canonical twin of buildEdgeControlData (issue #315 I2): when `nodes` is
   * the canonical column-backed array, renderer index == canonical index and
   * the edges already carry canonical endpoint indices (`edgeStart`/
   * `edgeEnd`), so the control data resolves with pure typed-array reads —
   * no id→index Map (4 Map lookups per edge cost ~285 ms at 1M on the boot
   * pre-pass, plus the ~220 ms Map build). A verification pass proves every
   * endpoint id matches the canonical id column inside the visible prefix;
   * any mismatch (foreign edges, load streaming beyond the prefix,
   * non-canonical nodes array) returns null and the caller falls back to
   * the Map path, so both paths always agree.
   */
  buildEdgeControlDataCanonical(
    edges: SegmentColumns,
    nodes: DataPoint[],
    visibleNodeCount = nodes.length
  ): Float32Array | null {
    const cols = columnsOf(nodes);
    if (!cols) return null;
    const limit = Math.max(0, Math.min(visibleNodeCount, cols.count));
    const ids = cols.id;
    const E = edges.edgeCount;
    for (let e = 0; e < E; e++) {
      const c1 = edges.edgeStart[e];
      const c2 = edges.edgeEnd[e];
      if (c1 < 0 || c1 >= limit || ids[c1] !== edges.edgeStartId[e]) return null;
      if (c2 < 0 || c2 >= limit || ids[c2] !== edges.edgeEndId[e]) return null;
    }
    const out = new Float32Array(E * 4);
    for (let e = 0; e < E; e++) {
      const base = e * 4;
      const i1 = edges.edgeStart[e];
      const i2 = edges.edgeEnd[e];
      const chainPrev = e > 0 && edges.edgeEnd[e - 1] === i1;
      const chainNext = e + 1 < E && edges.edgeStart[e + 1] === i2;
      out[base + 0] = chainPrev ? edges.edgeStart[e - 1] : i1;
      out[base + 1] = i1;
      out[base + 2] = i2;
      out[base + 3] = chainNext ? edges.edgeEnd[e + 1] : i2;
    }
    return out;
  }

  buildEdgeControlData(edges: SegmentColumns, indexById: Map<number, number>): Float32Array {
    const E = edges.edgeCount;
    const out = new Float32Array(E * 4);
    for (let e = 0; e < E; e++) {
      const base = e * 4;
      const i1 = indexById.get(edges.edgeStartId[e]);
      const i2 = indexById.get(edges.edgeEndId[e]);
      if (i1 === undefined || i2 === undefined) {
        out[base + 0] = -1;
        out[base + 1] = -1;
        out[base + 2] = -1;
        out[base + 3] = -1;
        continue;
      }
      const chainPrev = e > 0 && edges.edgeEnd[e - 1] === edges.edgeStart[e];
      const chainNext = e + 1 < E && edges.edgeStart[e + 1] === edges.edgeEnd[e];
      const i0 = chainPrev ? indexById.get(edges.edgeStartId[e - 1]) ?? i1 : i1;
      const i3 = chainNext ? indexById.get(edges.edgeEndId[e + 1]) ?? i2 : i2;
      out[base + 0] = i0;
      out[base + 1] = i1;
      out[base + 2] = i2;
      out[base + 3] = i3;
    }
    return out;
  }

  buildEdgesGeometry(
    gl: WebGL2RenderingContext,
    edges: SegmentColumns | null,
    indexById: Map<number, number>,
    maxSegments = segmentCountOf(edges)
  ): EdgeGeometryBuildResult {
    // Virtual columns have no materialized segment arrays — the instanced
    // path renders them; this CPU builder can only produce an empty result
    // (reachable via the __edgeCpuPath dev flag).
    const total = edges?.virtualSamplesPerEdge ? 0 : segmentCountOf(edges);
    const segCount = Math.max(0, Math.min(maxSegments, total));
    const vertexCount = segCount * 4;
    const edgeVerts = new Float32Array(vertexCount * EDGE_FLOATS_PER_VERT);

    const indexCount = segCount * 6;
    const useUint32 = vertexCount > 65535;
    const edgeIdx: Uint16Array | Uint32Array = useUint32
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);
    const edgeIndexType = useUint32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    const corners: ReadonlyArray<readonly [number, number]> = [
      [-1, 1],
      [-1, -1],
      [1, 1],
      [1, -1],
    ];

    let idxWrite = 0;

    // Per-EDGE endpoint resolution: segments of an edge are contiguous, so
    // the two indexById lookups happen once per ~20 segments.
    const cols = edges!;
    for (let e = 0; e < cols.edgeCount && cols.edgeSegOffset[e] < segCount; e++) {
      const from = cols.edgeSegOffset[e];
      const to = Math.min(cols.edgeSegOffset[e + 1], segCount);
      const lastIndex = indexById.get(cols.edgeStartId[e]) ?? 0;
      const nextIndex = indexById.get(cols.edgeEndId[e]) ?? 0;

      for (let i = from; i < to; i++) {
        const sp = cols.segStartPct[i];
        const ep = cols.segEndPct[i];

        const baseVertex = i * 4;

        // Indices (two triangles per quad)
        edgeIdx[idxWrite + 0] = baseVertex + 0;
        edgeIdx[idxWrite + 1] = baseVertex + 1;
        edgeIdx[idxWrite + 2] = baseVertex + 2;
        edgeIdx[idxWrite + 3] = baseVertex + 2;
        edgeIdx[idxWrite + 4] = baseVertex + 1;
        edgeIdx[idxWrite + 5] = baseVertex + 3;
        idxWrite += 6;

        for (let v = 0; v < 4; v++) {
          const [cx, cy] = corners[v];
          const base = (baseVertex + v) * EDGE_FLOATS_PER_VERT;

          edgeVerts[base + 0] = cols.segX0[i];
          edgeVerts[base + 1] = cols.segY0[i];
          edgeVerts[base + 2] = cols.segX1[i];
          edgeVerts[base + 3] = cols.segY1[i];
          edgeVerts[base + 4] = cx;
          edgeVerts[base + 5] = cy;

          // base + 6..11 are colors (filled by ColorSystem)

          edgeVerts[base + 12] = lastIndex;
          edgeVerts[base + 13] = nextIndex;
          edgeVerts[base + 14] = sp;
          edgeVerts[base + 15] = ep;
        }
      }
    }

    return {
      edgeVerts,
      edgeIdx,
      edgeIndexType,
      edgeIndexCount: edgeIdx.length,
      vertexCount,
    };
  }

  buildArrowsGeometry(
    edges: SegmentColumns | null,
    indexById: Map<number, number>,
    maxSegments = segmentCountOf(edges)
  ): ArrowGeometryBuildResult {
    const total = edges?.virtualSamplesPerEdge ? 0 : segmentCountOf(edges);
    const segCount = Math.max(0, Math.min(maxSegments, total));
    let arrowSegCount = 0;
    for (let i = 0; i < segCount; i++) {
      if (edges!.segArrow[i] === 1) arrowSegCount++;
    }

    const arrowCount = arrowSegCount * 3;
    const arrowVerts = new Float32Array(arrowCount * ARROW_FLOATS_PER_VERT);

    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [-0.5, 1],
      [0.5, 1],
    ];

    let writeVertex = 0;

    for (let i = 0; i < segCount; i++) {
      const cols = edges!;
      if (cols.segArrow[i] !== 1) continue;

      const e = cols.segEdge[i];
      const lastIndex = indexById.get(cols.edgeStartId[e]) ?? 0;
      const nextIndex = indexById.get(cols.edgeEndId[e]) ?? 0;
      const ep = cols.segEndPct[i];

      const x0 = cols.segX0[i];
      const y0 = cols.segY0[i];
      const x1 = cols.segX1[i];
      const y1 = cols.segY1[i];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;

      const rotation = Math.atan2(dy, dx) + Math.PI / 2;

      for (let v = 0; v < 3; v++) {
        const [ox, oy] = offsets[v];
        const base = writeVertex * ARROW_FLOATS_PER_VERT;

        arrowVerts[base + 0] = x1;
        arrowVerts[base + 1] = y1;
        arrowVerts[base + 2] = rotation;
        arrowVerts[base + 3] = ox;
        arrowVerts[base + 4] = oy;

        // base + 5..7 are color (filled by ColorSystem)

        arrowVerts[base + 8] = lastIndex;
        arrowVerts[base + 9] = nextIndex;
        arrowVerts[base + 10] = ep;

        writeVertex++;
      }
    }

    // If any zero-length segments were skipped, arrowVerts may be partially unused.
    // Keep behavior stable by trimming to the actually written vertex count.
    const writtenCount = writeVertex;
    const trimmed = writtenCount === arrowCount ? arrowVerts : arrowVerts.subarray(0, writtenCount * ARROW_FLOATS_PER_VERT);

    return { arrowVerts: trimmed, arrowCount: writtenCount };
  }
}
