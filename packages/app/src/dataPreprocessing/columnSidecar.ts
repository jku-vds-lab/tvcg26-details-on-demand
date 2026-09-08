// src/dataPreprocessing/columnSidecar.ts
//
// Binary column sidecar decoder (issue #315 phase E-a / D2 step 1).
//
// A multipart manifest may declare a `dataColumns` section pointing at a
// `columns.bin` sidecar: little-endian typed columns concatenated with
// per-dtype alignment padding, written by rl_trajectories/column_sidecar.py.
// Loading it replaces the JSON point-chunk download AND its parse: columns
// become typed arrays via zero-copy views (or one O(n) division pass for
// fixed-decimal scaled integers), and the row objects the rest of the app
// still consumes are materialized from the columns in yielding slices.
//
// Exactness contract (mirrors the Python emitter's tests): a scaled column
// decodes as `raw / scale` in float64 — for a value that was printed with k
// decimal places and stored as round(v·10^k), that division is the correctly
// rounded float64 of the same rational the JSON parser would have rounded,
// so the decoded value is BIT-EQUAL to the JSON path's.
//
// The decoded columns are kept on the Dataset (`Dataset.dataColumns`) as the
// first brick of the columnar client (plan-315-d2-columnar.md, step 1):
// hot-path consumers migrate to reading these instead of DataPoint objects.

/** A value a dictionary column can carry (FORMAT v2): JSON primitives. */
export type SidecarCategory = string | number | boolean | null;

/** One column entry of the manifest's `dataColumns` section. */
export interface SidecarColumnEntry {
  name: string;
  dtype: "f64" | "f32" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";
  byteOffset: number;
  /** Integer divisor for fixed-decimal columns: value = raw / scale. */
  scale?: number;
  /** Dictionary column (FORMAT v2, issue #315 B3): the stored integers are
   * codes into this array (value = categories[raw]) — how string / boolean /
   * null-bearing columns (chess board squares, labels, sparse numerics)
   * survive the binary lane. Never combined with `scale`. */
  categories?: SidecarCategory[];
}

/** The manifest `dataColumns` section (sibling of `data`). */
export interface DataColumnsSection {
  file: string;
  count: number;
  columns: SidecarColumnEntry[];
  /** Prep-time stamp (issue #315 B2): the emitter validated that the `id`
   * column holds unique finite integers, so the client skips its O(N)
   * boot-time id validation. Absent/false ⇒ the client validates (fallback
   * lane). */
  idsValidated?: boolean;
}

export type DecodedColumn =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  /** Dictionary column (FORMAT v2): code-mapped category values, one per
   * point. A plain array of shared references — repeated values point at
   * the SAME string/number, unlike the JSON parse. */
  | SidecarCategory[];

/** Decoded sidecar: one typed array per column, in canonical point order. */
export interface PointColumns {
  count: number;
  byName: Record<string, DecodedColumn>;
}

const CTORS = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
} as const;

/**
 * Decode a sidecar buffer into typed columns. Unscaled columns are zero-copy
 * views over `buffer` (the emitter aligns each byteOffset to the dtype
 * size); scaled columns materialize one Float64Array via the exact-division
 * pass described in the header comment.
 */
export function decodeColumns(buffer: ArrayBuffer, section: DataColumnsSection): PointColumns {
  const byName: Record<string, DecodedColumn> = {};
  for (const col of section.columns) {
    const Ctor = CTORS[col.dtype];
    if (!Ctor) throw new Error(`Unknown sidecar dtype ${col.dtype} for column ${col.name}`);
    if (col.byteOffset % Ctor.BYTES_PER_ELEMENT !== 0) {
      throw new Error(
        `Misaligned sidecar column ${col.name}: offset ${col.byteOffset} for dtype ${col.dtype}`
      );
    }
    const view = new Ctor(buffer, col.byteOffset, section.count);
    if (col.categories !== undefined) {
      if (col.scale !== undefined) {
        throw new Error(`Sidecar column ${col.name} has both scale and categories`);
      }
      // Dictionary column (FORMAT v2): materialize category references. An
      // out-of-range code marks a corrupt sidecar — throw so the loader's
      // JSON fallback engages instead of silently loading undefineds.
      const cats = col.categories;
      const out: SidecarCategory[] = new Array(section.count);
      for (let i = 0; i < section.count; i++) {
        const code = view[i];
        if (code >= cats.length) {
          throw new Error(`Sidecar column ${col.name}: code ${code} outside its dictionary`);
        }
        out[i] = cats[code];
      }
      byName[col.name] = out;
    } else if (col.scale !== undefined) {
      const out = new Float64Array(section.count);
      const s = col.scale;
      for (let i = 0; i < section.count; i++) out[i] = view[i] / s;
      byName[col.name] = out;
    } else {
      byName[col.name] = view;
    }
  }
  return { count: section.count, byName };
}

// Sidecar registry (issue #315 B1): the loader registers which decoded
// columns a materialized rows array came from, so downstream load-time passes
// (attachPointColumns) can consume the typed views directly instead of
// re-reading 1M row objects. WeakMap — dropping the rows array drops the entry.
const sidecarByRows = new WeakMap<object, PointColumns>();

/** Associate a rows array with the sidecar columns it was materialized from. */
export function registerSidecarColumns(rows: object, cols: PointColumns): void {
  sidecarByRows.set(rows, cols);
}

/** The sidecar columns `rows` was materialized from, if any. */
export function sidecarColumnsFor(rows: object): PointColumns | undefined {
  return sidecarByRows.get(rows);
}

// Prep-time id validation (issue #315 B2): rows whose manifest carried
// `dataColumns.idsValidated: true` skip the client's O(N) boot-time
// id-uniqueness scan. WeakSet keyed by the rows array, like the sidecar
// registry above.
const validatedIdRows = new WeakSet<object>();

/** Mark `rows` as carrying prep-validated ids (unique finite integers). */
export function markIdsValidated(rows: object): void {
  validatedIdRows.add(rows);
}

/** True when `rows` was stamped id-validated at prep time. */
export function hasValidatedIds(rows: object): boolean {
  return validatedIdRows.has(rows);
}

/**
 * The single row constructor of the sidecar lane (issue #315 R1b): builds ONE
 * row at canonical index `i` by copying every column's value onto a fresh
 * object from `rowFactory` (or a plain `{}`). Both the eager materialization
 * below and the lazy row seam (`lazyRows.ts`) go through it, so a row built at
 * boot and a row built on demand have the same own-property shape by
 * construction — the invariant the 200-row feature micro-scan and
 * `collectFeatureColumns` enumerate against (plan §2.4).
 */
export function makeRecordBuilder(
  cols: PointColumns,
  rowFactory?: (i: number) => Record<string, number>
): (i: number) => Record<string, SidecarCategory> {
  const names = Object.keys(cols.byName);
  const arrays = names.map((n) => cols.byName[n]);
  return (i: number): Record<string, SidecarCategory> => {
    const row: Record<string, SidecarCategory> = rowFactory ? rowFactory(i) : {};
    for (let c = 0; c < names.length; c++) row[names[c]] = arrays[c][i];
    return row;
  };
}

/**
 * Materialize plain row objects (the shape a JSON point chunk would have
 * parsed to) from decoded columns, yielding to the main thread between
 * slices so a 1M-row build never blocks a frame for long.
 */
export async function materializeRecords(
  cols: PointColumns,
  opts?: {
    sliceSize?: number;
    signal?: AbortSignal;
    onSlice?: (done: number, total: number) => void;
    /** Row constructor (issue #315 B2): lets the caller materialize rows
     * born column-backed (shared accessor prototype + per-row index) instead
     * of plain objects — see pointColumns.createColumnBackedRowFactory. */
    rowFactory?: (i: number) => Record<string, number>;
  }
): Promise<Array<Record<string, SidecarCategory>>> {
  const sliceSize = opts?.sliceSize ?? 100_000;
  const build = makeRecordBuilder(cols, opts?.rowFactory);
  const rows: Array<Record<string, SidecarCategory>> = new Array(cols.count);
  for (let start = 0; start < cols.count; start += sliceSize) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(cols.count, start + sliceSize);
    for (let i = start; i < end; i++) rows[i] = build(i);
    opts?.onSlice?.(end, cols.count);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return rows;
}
