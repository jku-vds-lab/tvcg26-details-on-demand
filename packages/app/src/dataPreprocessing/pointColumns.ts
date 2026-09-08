// packages/app/src/dataPreprocessing/pointColumns.ts
//
// The columnar point model (issue #315 phase D2, step 1-3): typed-array
// columns over the canonical dataset order, built once per load in the
// same full pass that initializes points. Shared open-core code — one
// data model for both editions (like the B2 renderer).
//
// DoI is special: it is the hot mutable column (propagation, lasso,
// search, labeling — ~15 scattered write sites), so each canonical point
// gets an ACCESSOR property backed by the column. Every existing
// `p.DoI = v` site writes the column automatically — the single write
// surface is exhaustive by construction, no site audit. x/y stay plain
// fields (single rewrite site: reprojection) mirrored into columns with
// explicit invalidation via refreshPositionColumns.
//
// `columnsOf(points)` returns the columns only for the canonical array
// (identity-checked); subset arrays fall back to object reads — the same
// point instances carry the DoI accessor, so subset writes still land in
// the canonical column.
//
// Must stay rbush/DOM-free (worker + jest graphs).

import type { DataPoint } from "./dataPreprocessing";

export interface PointColumns {
  count: number;
  x: Float64Array;
  y: Float64Array;
  line: Int32Array;
  id: Int32Array;
  /** Float64Array while the CLIENT owns DoI; a Float32Array once a server
   * apply adopts its own field as the column (issue #315 P7 S5,
   * `adoptDoiColumn`) — the element type is the only difference, every reader
   * and writer is index-identical. */
  doi: Float64Array | Float32Array;
  /**
   * Selection flags, 1 = selected (issue #315 R1a, §3.1 of the row contract).
   * Like DoI this is an ACCESSOR-backed column: every `p.selected = v` site
   * writes it through the property, so the write surface stays exhaustive by
   * construction. Readers that walk the whole dataset (the server-propagation
   * seed scan, "is anything selected", the deep-link count) go through
   * selectedIndicesOf / hasAnySelected instead of a row walk.
   */
  selected: Uint8Array;
  /**
   * Canonical indices of the selected points, maintained by
   * writeSelectionByIds and INVALIDATED by any per-row `selected` write
   * (rebuilt from the column on next read). Undefined ⇒ not currently known.
   */
  selectedIndices?: Int32Array;
  /** id → canonical index, built lazily (see indexOfId); rebuilt implicitly
   * whenever attachPointColumns replaces the columns object. */
  idIndex?: Map<number, number>;
}

// Column linkage lives under SYMBOL keys (issue #315 B2): plain symbol
// stores are invisible to every string enumeration (for-in, Object.keys,
// JSON.stringify), so linking a point costs two ordinary writes instead of
// the two non-enumerable defineProperty calls that dominated the 1M-row
// attach (~1.5 s of the refs:fast-path gap).
const COLS = Symbol("pointColumns.cols");
const CI = Symbol("pointColumns.index");

interface ColumnBackedPoint extends DataPoint {
  [COLS]?: PointColumns;
  [CI]?: number;
}

const columnsByArray = new WeakMap<readonly DataPoint[], PointColumns>();

/** The decoded-sidecar column views attachPointColumns can consume directly
 * (issue #315 B1) — structurally the columnSidecar `PointColumns` shape, kept
 * structural so this module stays dependency-free. Dictionary columns
 * (FORMAT v2) appear as plain arrays of category values; every consumer here
 * narrows to the typed numeric views it actually needs. */
export interface SidecarColumnSource {
  count: number;
  byName: Record<string, ArrayLike<unknown> | undefined>;
}

/**
 * Build (or rebuild) the canonical columns for `points` and install the
 * DoI accessors. Idempotent; call from the load-time full pass. O(n).
 *
 * `sidecar` (issue #315 B1, sidecar-direct fast path): when the points were
 * materialized from a decoded binary sidecar, its typed views ARE the columns
 * — x/y are adopted by reference (they hold exactly the values the rows
 * copied out of them), line/id convert in one typed-array pass, and the DoI
 * column starts at the uniform boot value 1 (the boot pass just wrote
 * `p.DoI = 1` on every point; the sidecar carries no DoI column). Taken only
 * on a FIRST attach — a re-attach may carry live DoI values that must be
 * read back through the old accessors, so it keeps the classic loop.
 */
export function attachPointColumns(points: DataPoint[], sidecar?: SidecarColumnSource): PointColumns {
  const n = points.length;

  // Born-column-backed fast path (issue #315 B2): rows materialized through
  // createColumnBackedRowFactory already share a prototype carrying the DoI
  // accessor + columns link and own per-row indices — the whole per-point
  // install loop is unnecessary. FIRST attach only (columnsByArray guard): a
  // re-attach must rebuild the columns through the classic loop below so
  // live DoI values are read back through the old accessors.
  const p0 = points[0] as ColumnBackedPoint | undefined;
  const born = p0?.[COLS];
  if (
    born &&
    !columnsByArray.has(points) &&
    born.count === n &&
    p0[CI] === 0 &&
    (points[n - 1] as ColumnBackedPoint)[CI] === n - 1
  ) {
    columnsByArray.set(points, born);
    schedulePrebuildIdIndex(points);
    return born;
  }

  const sc =
    sidecar &&
    sidecar.count === n &&
    (points[0] as ColumnBackedPoint | undefined)?.[COLS] === undefined &&
    sidecar.byName.x instanceof Float64Array &&
    sidecar.byName.y instanceof Float64Array &&
    sidecar.byName.line !== undefined &&
    sidecar.byName.id !== undefined
      ? sidecar.byName
      : null;

  const cols: PointColumns = sc
    ? {
        count: n,
        x: sc.x as Float64Array,
        y: sc.y as Float64Array,
        line: new Int32Array(sc.line as ArrayLike<number>),
        id: new Int32Array(sc.id as ArrayLike<number>),
        doi: new Float64Array(n).fill(1),
        selected: new Uint8Array(n),
      }
    : {
        count: n,
        x: new Float64Array(n),
        y: new Float64Array(n),
        line: new Int32Array(n),
        id: new Int32Array(n),
        doi: new Float64Array(n),
        selected: new Uint8Array(n),
      };

  for (let i = 0; i < n; i++) {
    const p = points[i] as ColumnBackedPoint;
    if (!sc) {
      // Read BEFORE relinking: on re-attach the old accessor still resolves
      // against the previous columns, which hold the current value.
      const doi = p.DoI ?? 1;
      const sel = p.selected === true;
      cols.x[i] = p.x;
      cols.y[i] = p.y;
      cols.line[i] = Number.isFinite(p.line) ? (p.line as number) : -1;
      cols.id[i] = Number.isFinite(p.id) ? p.id : -1;
      cols.doi[i] = doi;
      cols.selected[i] = sel ? 1 : 0;
    }

    // Plain symbol stores (invisible to string enumeration, shadow any
    // prototype link on re-attach); only the accessor-backed columns still
    // need a defineProperty, to replace a possible own data property.
    p[COLS] = cols;
    p[CI] = i;
    Object.defineProperty(p, "DoI", {
      enumerable: true,
      configurable: true,
      get: doiGet,
      set: doiSet,
    });
    Object.defineProperty(p, "selected", {
      enumerable: true,
      configurable: true,
      get: selectedGet,
      set: selectedSet,
    });
  }

  columnsByArray.set(points, cols);
  schedulePrebuildIdIndex(points);
  return cols;
}

/** Warm the id → index map off the critical path so the first lasso finds it
 * built (indexOfId still builds it lazily if the idle callback hasn't fired). */
function schedulePrebuildIdIndex(points: readonly DataPoint[]): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => prebuildIdIndex(points));
  else setTimeout(() => prebuildIdIndex(points), 0);
}

function doiGet(this: ColumnBackedPoint): number {
  return this[COLS]!.doi[this[CI]!];
}

function doiSet(this: ColumnBackedPoint, v: number) {
  this[COLS]!.doi[this[CI]!] = v;
}

function selectedGet(this: ColumnBackedPoint): boolean {
  return this[COLS]!.selected[this[CI]!] === 1;
}

function selectedSet(this: ColumnBackedPoint, v: unknown) {
  const cols = this[COLS]!;
  cols.selected[this[CI]!] = v ? 1 : 0;
  // A per-row write can flip the membership either way — the maintained list
  // is stale from here until something rebuilds it (selectedIndicesOf).
  cols.selectedIndices = undefined;
}

/**
 * Columns built straight from a decoded binary sidecar (issue #315 B2):
 * x/y adopted by reference, line/id one-pass converted, DoI at the uniform
 * boot value 1. Null when the sidecar lacks the required columns — callers
 * keep the classic materialize-then-attach lane.
 */
export function columnsFromSidecar(sidecar: SidecarColumnSource): PointColumns | null {
  const n = sidecar.count;
  if (
    !(sidecar.byName.x instanceof Float64Array) ||
    !(sidecar.byName.y instanceof Float64Array) ||
    sidecar.byName.line === undefined ||
    sidecar.byName.id === undefined
  ) {
    return null;
  }
  return {
    count: n,
    x: sidecar.byName.x,
    y: sidecar.byName.y,
    line: new Int32Array(sidecar.byName.line as ArrayLike<number>),
    id: new Int32Array(sidecar.byName.id as ArrayLike<number>),
    doi: new Float64Array(n).fill(1),
    selected: new Uint8Array(n),
  };
}

/**
 * Row factory for sidecar materialization (issue #315 B2): rows come out of
 * it BORN column-backed — a shared per-dataset prototype carries the DoI
 * accessor and the columns link (one-time cost), each row only stores its
 * own index. Replaces the 3×N defineProperty install that dominated the
 * refs:fast-path gap (~1.5 s at 1M rows). Enumeration semantics audited
 * (issue #315 B2): for-in still sees DoI (enumerable proto accessor), while
 * Object.keys/JSON.stringify never included the internals and now also skip
 * DoI — every scan/export consumer either uses for-in or excludes DoI
 * explicitly.
 */
export function createColumnBackedRowFactory(
  cols: PointColumns,
  /** Deferred-column accessors (issue #315 R3c): one enumerable prototype
   * accessor per manifest-declared deferred name, reading through the
   * dataset sidecar's `byName` slot — `undefined` before the column is
   * fetched (lazyColumns.ensureResidentColumns), live values after, SAME
   * row instance. Writes shadow with an own property, exactly the
   * divergence semantics of the materialized lane (row writes never write
   * back into sidecar columns). */
  deferred?: { names: readonly string[]; source: SidecarColumnSource }
): (i: number) => Record<string, number> {
  // A plain-object prototype (NOT Object.create(null)) so rows keep
  // Object.prototype methods (hasOwnProperty, toString) like every other row.
  const proto = {} as ColumnBackedPoint;
  proto[COLS] = cols;
  if (deferred) {
    const source = deferred.source;
    for (const name of deferred.names) {
      if (name in proto) continue; // never shadow DoI/selected/Object.prototype
      Object.defineProperty(proto, name, {
        enumerable: true,
        configurable: true,
        get(this: ColumnBackedPoint) {
          return source.byName[name]?.[this[CI]!];
        },
        set(this: ColumnBackedPoint, v: unknown) {
          Object.defineProperty(this, name, {
            value: v,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        },
      });
    }
  }
  Object.defineProperty(proto, "DoI", {
    enumerable: true,
    configurable: true,
    get: doiGet,
    set: doiSet,
  });
  // `selected` rides the same prototype (issue #315 R1a, §3.1): born rows get
  // the column-backed property for free, so the boot pass that used to write
  // `selected = false` onto every row has nothing left to do, and the
  // own-property enumeration shape the feature micro-scan sees is unchanged
  // (an enumerable prototype accessor, exactly like DoI).
  Object.defineProperty(proto, "selected", {
    enumerable: true,
    configurable: true,
    get: selectedGet,
    set: selectedSet,
  });
  return (i: number) => {
    const row = Object.create(proto) as ColumnBackedPoint;
    row[CI] = i;
    return row as unknown as Record<string, number>;
  };
}

/**
 * The columns for `points` IF it is the canonical array they were built
 * for (identity + linkage check); null otherwise — callers fall back to
 * per-object reads.
 */
export function columnsOf(points: readonly DataPoint[]): PointColumns | null {
  const p0 = points[0] as ColumnBackedPoint | undefined;
  const cols = p0?.[COLS];
  if (!cols || cols.count !== points.length) return null;
  if (p0[CI] !== 0) return null;
  const pl = points[points.length - 1] as ColumnBackedPoint;
  if (pl[COLS] !== cols || pl[CI] !== points.length - 1) return null;
  // Endpoint check suffices for the arrays that reach the hot readers:
  // they are the canonical array or order-preserving filter SUBSEQUENCES of
  // it — a subsequence with equal length and matching endpoints is the
  // identical sequence. (Arbitrary permutations would fool this; none of
  // the columnsOf call sites produce permutations.)
  return cols;
}

/**
 * A DoI reader that bypasses the accessor property: on the canonical array it
 * reads the backing column directly (the accessor's getter costs ~97 ms per
 * ~4M reads at 1M points). Points that are NOT column-backed — e.g. synthetic
 * midpoint endpoints — fall back to `p.DoI ?? 0`. Returns one of two
 * monomorphic closures; both are allocation-free per call.
 */
export function rawDoiReader(points: readonly DataPoint[]): (p: DataPoint) => number {
  const cols = columnsOf(points);
  if (!cols) return (p) => p.DoI ?? 0;
  return rawDoiOfPoint;
}

/**
 * Per-point raw DoI read that bypasses the accessor (the getter costs
 * ~97 ms per ~4M reads at 1M points). Non-column-backed points (synthetic
 * midpoint endpoints, test literals) fall back to `p.DoI ?? 0`.
 */
export function rawDoiOfPoint(p: DataPoint): number {
  const cb = p as ColumnBackedPoint;
  // The index may be 0 (falsy) — test for presence, not truthiness.
  return cb[COLS] !== undefined && cb[CI] !== undefined
    ? cb[COLS].doi[cb[CI]]
    : p.DoI ?? 0;
}

/**
 * The canonical dataset index of a column-backed point, regardless of which
 * (possibly DoI-filtered) array the caller is holding it in. Undefined for
 * points that were never column-backed (synthetic midpoint endpoints, test
 * literals). O(1) — the index is stamped by attachPointColumns.
 */
export function canonicalIndexOf(p: DataPoint): number | undefined {
  return (p as ColumnBackedPoint)[CI];
}

/**
 * Adopt `field` as the DoI column (issue #315 P7 S5) — an O(1) buffer swap
 * that replaces the per-point apply loop on the server path. Because
 * `p.DoI` is an accessor into `cols.doi`, every existing DoI reader (hover,
 * details, labeling, saliency fallbacks, the opacity rebuilds) keeps reading
 * server truth without a single per-point write.
 *
 * The adopted buffer is float32 by design: plan §3b.6 requires the client to
 * read float32-EXACT values on the server path (the doiMass fallback diverged
 * at 1.1e-8 against pre-quantization doubles). A later local-path commit
 * writes straight back into it — DoI is a 0..1 opacity/threshold input, so the
 * narrower mantissa is immaterial, and a dataset re-attach restores float64.
 *
 * Returns false (and changes nothing) when `points` is not the canonical
 * column-backed array or the length does not match — caller keeps its
 * per-point path.
 */
export function adoptDoiColumn(points: readonly DataPoint[], field: Float32Array): boolean {
  const cols = columnsOf(points);
  if (!cols || field.length !== cols.count) return false;
  cols.doi = field;
  return true;
}

function buildIdIndex(cols: PointColumns): Map<number, number> {
  const map = new Map<number, number>();
  const id = cols.id;
  for (let i = 0; i < cols.count; i++) map.set(id[i], i);
  return map;
}

/** Eagerly build the id → index map (idempotent). Called from
 * attachPointColumns via requestIdleCallback so lookups start warm. */
export function prebuildIdIndex(points: readonly DataPoint[]): void {
  const cols = columnsOf(points);
  if (!cols || cols.idIndex) return;
  cols.idIndex = buildIdIndex(cols);
}

/**
 * Canonical index of the point with `id`, via a Map built lazily on first call
 * and cached on the columns object. Returns undefined when `points` is not
 * column-backed (callers keep their legacy id-scan path) or the id is absent.
 * Assumes ids are unique across the canonical array (they are by construction).
 */
export function indexOfId(points: readonly DataPoint[], id: number): number | undefined {
  const cols = columnsOf(points);
  if (!cols) return undefined;
  let idx = cols.idIndex;
  if (!idx) {
    idx = buildIdIndex(cols);
    cols.idIndex = idx;
  }
  return idx.get(id);
}

/**
 * Replace the whole selection with the points carrying `ids` (issue #315 R1a,
 * §3.1) — a typed-array clear plus one write per selected id, instead of the
 * O(N) row loop every selection commit used to run (1M accessor calls at
 * synth1m). Also installs the selected-index list, which turns the
 * server-propagation seed discovery into an O(selection) read.
 *
 * Returns false (writing nothing) when `points` is not the canonical
 * column-backed array — callers keep their row loop.
 */
export function writeSelectionByIds(points: readonly DataPoint[], ids: Iterable<number>): boolean {
  const cols = columnsOf(points);
  if (!cols) return false;
  cols.selected.fill(0);
  const indices: number[] = [];
  for (const id of ids) {
    const i = indexOfId(points, id);
    if (i === undefined) continue;
    cols.selected[i] = 1;
    indices.push(i);
  }
  // Ascending order: consumers walk it as a canonical-index sequence.
  indices.sort((a, b) => a - b);
  cols.selectedIndices = Int32Array.from(indices);
  return true;
}

/**
 * The current DoI of every point as a renderer opacity field (issue #315
 * R1b) — the columnar twin of `for (i) out[i] = points[i].DoI ?? 1`, which is
 * the shape half a dozen commit/restore paths build. Reads the backing column
 * directly (no accessor calls, no row dereference on the row-lazy lane) and
 * keeps the row walk for non-column-backed arrays.
 */
export function doiOpacityField(points: readonly DataPoint[]): Float32Array {
  const out = new Float32Array(points.length);
  const cols = columnsOf(points);
  if (cols) {
    const doi = cols.doi;
    for (let i = 0; i < out.length; i++) out[i] = doi[i];
    return out;
  }
  for (let i = 0; i < out.length; i++) out[i] = points[i]?.DoI ?? 1;
  return out;
}

/**
 * Every point's id, from the canonical column when there is one (issue #315
 * R1b) — the columnar twin of `points.map(p => p.id)`, which on the row-lazy
 * lane would skip the holes and yield a sparse array. Falls back to the row
 * map on non-column-backed arrays.
 */
export function allNodeIds(points: readonly DataPoint[]): number[] {
  const cols = columnsOf(points);
  if (!cols) return points.map((p) => p.id);
  const out: number[] = new Array(cols.count);
  for (let i = 0; i < cols.count; i++) out[i] = cols.id[i];
  return out;
}

/**
 * The canonical indices of the selected points, rebuilt from the column when a
 * per-row write invalidated the maintained list. Null when `points` is not
 * column-backed — callers keep their `nodes[i].selected` scan.
 */
export function selectedIndicesOf(points: readonly DataPoint[]): Int32Array | null {
  const cols = columnsOf(points);
  if (!cols) return null;
  if (cols.selectedIndices) return cols.selectedIndices;
  const sel = cols.selected;
  const indices: number[] = [];
  for (let i = 0; i < cols.count; i++) if (sel[i] === 1) indices.push(i);
  cols.selectedIndices = Int32Array.from(indices);
  return cols.selectedIndices;
}

/**
 * Whether anything is selected, without materializing the index list — the
 * column read behind `nodes.some(n => n.selected)`. Null when `points` is not
 * column-backed.
 */
export function hasAnySelected(points: readonly DataPoint[]): boolean | null {
  const cols = columnsOf(points);
  if (!cols) return null;
  if (cols.selectedIndices) return cols.selectedIndices.length > 0;
  const sel = cols.selected;
  for (let i = 0; i < cols.count; i++) if (sel[i] === 1) return true;
  return false;
}

/**
 * Clear stale cluster-id assignments, write-guarded (issue #315 B2): on a
 * first boot no pass has ever stamped an id, and blanket-assigning
 * `undefined` to 1M points would CREATE both property slots — ~2M
 * hidden-class transitions costing ~0.1–0.6 s. Reading a missing property
 * is cheap and leaves the object shape untouched. Lives here (not in
 * dataPreprocessing) to stay importable from rbush-free test/worker graphs.
 */
export function clearNodeClusterIds(nodes: DataPoint[]): void {
  // Nothing was ever stamped ⇒ nothing to clear (issue #315 R1a, A8/A10). The
  // guarded reads were still ~2M prototype-miss lookups per boot pass, and on
  // the server lane no pass stamps ids at all any more (step 5).
  if (!clusterIdsStamped) return;
  for (const n of nodes) {
    // Holes carry no stamps by construction (issue #315 R3d: `rowAt` builds
    // rows without cluster ids), and `for..of` visits them as undefined.
    if (n === undefined) continue;
    if (n.annotationClusterId !== undefined) n.annotationClusterId = undefined;
    if (n.insetClusterId !== undefined) n.insetClusterId = undefined;
  }
  clusterIdsStamped = false;
}

/** True once a clustering pass stamped per-point cluster ids; reset by a full
 * clear. Module-level because the ids are a global per-dataset invariant. */
let clusterIdsStamped = false;

/** Announce that a pass wrote per-point cluster ids (the two assignment sites
 * in hdbscanClustering) — the next clearNodeClusterIds then does real work. */
export function markClusterIdsStamped(): void {
  clusterIdsStamped = true;
}

/** Re-mirror x/y into the columns after an in-place position rewrite
 * (reprojection — the single runtime x/y write site). */
export function refreshPositionColumns(points: readonly DataPoint[]): void {
  const cols = columnsOf(points);
  if (!cols) return;
  for (let i = 0; i < cols.count; i++) {
    cols.x[i] = points[i].x;
    cols.y[i] = points[i].y;
  }
}
