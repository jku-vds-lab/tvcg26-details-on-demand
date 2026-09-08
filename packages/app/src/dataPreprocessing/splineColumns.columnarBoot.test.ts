/**
 * Columnar boot derivation (issue #315 R1a step 2, census items A1–A3): on the
 * sidecar lane the loader's spline pass must stop walking row objects — worker
 * input from the decoded views (A1), edge ids from the canonical id column
 * (A2), edge centers into a column instead of ~1M per-row objects (A3).
 *
 * Every assertion here is EXACT equality against the row path: the columnar
 * branches run the same IEEE operations in the same order on the same values,
 * so "close enough" would hide a real divergence.
 */

import type { DataPoint } from "./dataPreprocessing";
import { materializeRecords, type PointColumns as SidecarPointColumns } from "./columnSidecar";
import {
  columnsFromSidecar,
  createColumnBackedRowFactory,
  type SidecarColumnSource,
} from "./pointColumns";
import {
  attachSegmentPointState,
  compactSegmentColumns,
  computeEdgeList,
  edgeCenterAt,
  edgeFallbackCenter,
  splineInputColumns,
  SAMPLES_PER_EDGE,
} from "./splineColumns";

const COUNT = 8;

/** Two trajectories (line 0: 4 points, line 1: 4 points) — enough for interior
 * edges, where the Catmull-Rom controls differ from the clamped endpoints. */
function sidecar(): SidecarColumnSource & SidecarPointColumns {
  return {
    count: COUNT,
    byName: {
      x: new Float64Array([0.1, 0.35, 0.62, 0.9, 0.15, 0.4, 0.71, 0.95]),
      y: new Float64Array([0.2, 0.55, 0.31, 0.77, 0.9, 0.62, 0.44, 0.12]),
      line: new Uint16Array([0, 0, 0, 0, 1, 1, 1, 1]),
      id: new Uint32Array([10, 11, 12, 13, 14, 15, 16, 17]),
    },
  };
}

/** Rows born column-backed, exactly like the loader's sidecar lane. */
async function bornRows(): Promise<DataPoint[]> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
  })) as unknown as DataPoint[];
}

/** The same values as plain rows — the JSON-chunk / CSV lane. */
async function plainRows(): Promise<DataPoint[]> {
  const rows = (await materializeRecords(sidecar())) as unknown as DataPoint[];
  for (const r of rows) r.nextEdgeCenter = { x: 0, y: 0 };
  return rows;
}

function edgeList(rows: readonly DataPoint[]) {
  const line = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) line[i] = rows[i].line ?? Number.NaN;
  return computeEdgeList(line);
}

describe("splineInputColumns (A1)", () => {
  it("returns the sidecar views' values verbatim, matching the row loop", async () => {
    const sc = sidecar();
    const rows = await bornRows();
    const columnar = splineInputColumns(rows, sc);
    const fromRows = splineInputColumns(rows);

    expect(Array.from(columnar.x)).toEqual(Array.from(fromRows.x));
    expect(Array.from(columnar.y)).toEqual(Array.from(fromRows.y));
    expect(Array.from(columnar.line)).toEqual(Array.from(fromRows.line));
    expect(Array.from(columnar.x)).toEqual(Array.from(sc.byName.x as Float64Array));
  });

  it("copies rather than aliases the sidecar buffers (postMessage detaches them)", () => {
    const sc = sidecar();
    const rows: DataPoint[] = new Array(COUNT).fill(null).map(() => ({}) as DataPoint);
    const out = splineInputColumns(rows, sc);
    expect(out.x.buffer).not.toBe((sc.byName.x as Float64Array).buffer);
  });

  it("falls back to the row loop when the sidecar is absent or mismatched", async () => {
    const rows = await plainRows();
    const short = sidecar();
    short.count = COUNT - 1;
    const out = splineInputColumns(rows, short);
    expect(Array.from(out.x)).toEqual(rows.map((r) => r.x));
    expect(Array.from(out.line)).toEqual(rows.map((r) => r.line));
  });
});

describe("compactSegmentColumns edge ids (A2)", () => {
  it("column-backed rows produce the same edge ids as plain rows", async () => {
    const born = await bornRows();
    const plain = await plainRows();
    const { edgeStart, edgeEnd } = edgeList(born);

    const fromColumns = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, born);
    const fromRows = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, plain);

    expect(Array.from(fromColumns.edgeStartId)).toEqual(Array.from(fromRows.edgeStartId));
    expect(Array.from(fromColumns.edgeEndId)).toEqual(Array.from(fromRows.edgeEndId));
    expect(Array.from(fromColumns.edgeStartId)).toEqual([10, 11, 12, 14, 15, 16]);
  });
});

describe("attachSegmentPointState centers (A3)", () => {
  it("the column holds bit-identical centers to the per-row pass", async () => {
    const born = await bornRows();
    const plain = await plainRows();
    const { edgeStart, edgeEnd } = edgeList(born);
    const colsA = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, born);
    const colsB = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, plain);

    await attachSegmentPointState(born, colsA, { centersInto: "column" });
    await attachSegmentPointState(plain, colsB);

    expect(colsA.edgeCenterX).toBeDefined();
    for (let e = 0; e < colsA.edgeCount; e++) {
      const rowCenter = plain[colsB.edgeStart[e]].nextEdgeCenter;
      expect(colsA.edgeCenterX![e]).toBe(rowCenter.x);
      expect(colsA.edgeCenterY![e]).toBe(rowCenter.y);
    }
  });

  it("writes no nextEdgeCenter onto the rows when centers go to the column", async () => {
    const born = await bornRows();
    const { edgeStart, edgeEnd } = edgeList(born);
    const cols = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, born);

    await attachSegmentPointState(born, cols, { centersInto: "column" });

    expect(born.some((p) => p.nextEdgeCenter !== undefined)).toBe(false);
  });

  it("keeps the row pass when the rows are not column-backed", async () => {
    const plain = await plainRows();
    const { edgeStart, edgeEnd } = edgeList(plain);
    const cols = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, plain);

    await attachSegmentPointState(plain, cols, { centersInto: "column" });

    expect(cols.edgeCenterX).toBeUndefined();
    expect(plain[cols.edgeStart[0]].nextEdgeCenter).not.toEqual({ x: 0, y: 0 });
  });

  it("slicing the columnar pass yields the same values as the unsliced one", async () => {
    const a = await bornRows();
    const b = await bornRows();
    const { edgeStart, edgeEnd } = edgeList(a);
    const colsA = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, a);
    const colsB = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, b);

    await attachSegmentPointState(a, colsA, { centersInto: "column" });
    await attachSegmentPointState(b, colsB, {
      centersInto: "column",
      sliceCenters: true,
      batchSize: 2,
    });

    expect(Array.from(colsB.edgeCenterX!)).toEqual(Array.from(colsA.edgeCenterX!));
    expect(Array.from(colsB.edgeCenterY!)).toEqual(Array.from(colsA.edgeCenterY!));
  });
});

describe("edgeCenterAt", () => {
  it("prefers the column, then the row value, then the chord fallback", async () => {
    const rows = await plainRows();
    const { edgeStart, edgeEnd } = edgeList(rows);
    const cols = compactSegmentColumns(edgeStart, edgeEnd, SAMPLES_PER_EDGE, rows);

    // No column, no row value → chord fallback.
    expect(edgeCenterAt(cols, 1, rows, rows[cols.edgeStart[1]])).toEqual(
      edgeFallbackCenter(cols, 1, rows)
    );

    // Row value wins over the fallback.
    const shipped = { x: 42, y: 43 };
    rows[cols.edgeStart[1]].nextEdgeCenter = shipped;
    expect(edgeCenterAt(cols, 1, rows, rows[cols.edgeStart[1]])).toBe(shipped);

    // Column wins over both.
    cols.edgeCenterX = new Float64Array(cols.edgeCount).fill(7);
    cols.edgeCenterY = new Float64Array(cols.edgeCount).fill(8);
    expect(edgeCenterAt(cols, 1, rows, rows[cols.edgeStart[1]])).toEqual({ x: 7, y: 8 });
  });
});
