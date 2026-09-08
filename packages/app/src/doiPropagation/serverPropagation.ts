// src/doiPropagation/serverPropagation.ts
//
// Client half of server-side DoI propagation (issue #315 A3 / P-d): on
// server-cut datasets the selection/slider commit becomes ONE fused
// `/v1/select` propagate RTT (wire contract: plan-315-a3-server-doi.md §6)
// and the 13-22 s client heap spread is never run. The server returns a
// sparse leaf-order overlay; this module scatters it into record order and
// applies the same doiGroup ladder the client oracle writes, so everything
// downstream (clustering, opacity, insets) is untouched.
//
// Routing (T1 round 3, CS): by capability/size, never by dataset type —
// a resident local graph on a small dataset stays fully local (no RTT);
// labeled-exclusion mode and freehand pins stay local too (the server knows
// neither, and both are small-dataset workflows) — since #337 they land on
// the CLIENT FIELD lane, not the graph oracle. Every server failure degrades
// to the exact client field AND announces itself via the §8.8d server-loss
// banner (probe-first, see warnIfServerLost — CS row-4 verdict 2026-08-10).

import { resolveCutProvider } from "@scaling";
import type { DoiOverlay, PropagateParams, PropagateSeeds } from "../scaling.types";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { adoptDoiColumn, columnsOf, selectedIndicesOf } from "../dataPreprocessing/pointColumns";
import { ledgerEvent } from "../utils/insetLedger";
import { beginDoiChip, endDoiChip } from "../utils/pipelineChips";
import { warnServerLoss } from "../utils/serverLoss";
import { clearBakedDoi, setBakedDoi } from "./bakedDoi";
import { getPropagationPrecomputation, updateNodeGroup } from "./propagateDoi";
import { unpackDst1 } from "./dst1";
import {
  computeConvergedPreview,
  runConvergedAlternationCore,
  type ConvergedFieldStats,
  type ConvergedScratch,
} from "./convergedField";
import { evalFalloffField, type FalloffShape } from "./falloff";
import {
  computeRecordDistances,
  FIELD_GRID_RESOLUTION,
  rasterize,
  type FieldRaster,
} from "./fieldDistanceCore";
import type { computeRecordDistancesInWorker } from "./fieldDistanceWorker";
import { chainScanTrajectoryCore } from "./fieldPreviewCore";

export interface PropagationSliderSettings {
  proximitySlider: number;
  pastSlider: number;
  futureSlider: number;
  maxEmbeddingDistance: number;
  grayOutDoiThreshold: number;
  annotationDoiThreshold: number;
  insetDoiThreshold: number;
}

/** Embedding-k sent to the server (T4: a REAL parameter served by the
 * per-(dataset, k) cKDTree — decoupled from the baked k=2 graphs, which CS
 * called "like nothing"). Not yet user-facing; flagged for CS review. */
export const DEFAULT_SERVER_PROPAGATION_K = 8;

/** A stashed overlay expires quickly: it is only ever the fused lasso
 * response awaiting the same commit's selection workflow. */
const PENDING_OVERLAY_MAX_AGE_MS = 10_000;

interface PendingOverlay {
  overlay: DoiOverlay;
  /** The node ids the fused lasso resolved to — the overlay applies only
   * when the commit's selection is exactly these (see stashMatchesSelection). */
  ids: number[];
  stashedAt: number;
}

let pendingOverlay: PendingOverlay | null = null;
let lastRevision: number | null = null;
/** Field path: the fused-lasso polygon (data space), stashed by the resolver
 * so the same commit's field propagate can seed by polygon — the server
 * re-resolves seeds itself, sparing the O(selection) ids upload (measured
 * ~700 kB at a 98k lasso) and letting the DST1 RTT overlap the select RTT.
 * `ids` = the node ids THIS lasso resolved to: the polygon may only seed a
 * commit whose selection is exactly those ids — a ctrl-CHAINED selection is
 * a superset, and polygon seeding would silently drop the earlier chain
 * members (CS bug report 2026-07-24). */
let pendingPolygon: {
  polygon: Array<[number, number]>;
  ids: number[];
  stashedAt: number;
} | null = null;

export function stashPendingPolygon(
  polygon: Array<[number, number]>,
  ids: number[]
): void {
  pendingPolygon = { polygon, ids, stashedAt: Date.now() };
}

export function consumePendingPolygon(): {
  polygon: Array<[number, number]>;
  ids: number[];
} | null {
  const pending = pendingPolygon;
  pendingPolygon = null;
  if (!pending) return null;
  if (Date.now() - pending.stashedAt > PENDING_OVERLAY_MAX_AGE_MS) return null;
  return { polygon: pending.polygon, ids: pending.ids };
}

/** True iff the stashed lasso ids are EXACTLY the current selection — the
 * polygon/overlay shortcut is only valid then (never on chained/merged
 * selections). */
function stashMatchesSelection(
  stashedIds: number[],
  selectedIdSet: Set<number>
): boolean {
  if (stashedIds.length !== selectedIdSet.size) return false;
  for (const id of stashedIds) if (!selectedIdSet.has(id)) return false;
  return true;
}

// ── Field-first v2 (§8): falloff shape store + resident distance field ────

/** The resident field-path state: RECORD-order geodesic distances (the DST1
 * leaf-order payload scattered once through the leaf order) + the server's
 * threshold artifacts under the committed falloff. */
export interface ResidentDistanceField {
  revision: number;
  focusActive: boolean;
  nLeaves: number;
  recordDist: Float32Array;
  visibleRanges: Array<[number, number]>;
}

let residentField: ResidentDistanceField | null = null;
/** Client-local field revision (issue #315 field parity): counts the
 * provider-less distance-field commits of the current dataset epoch —
 * reset with the rest of the resident state, never mixed with server
 * revisions (`lastRevision` stays server-only). */
let localFieldRevision = 0;
/** True when the resident field's EDT seeds were labeled-REDUCED
 * (selected & ~labeled, #337). A commit whose labeled state differs must
 * recompute the distances — reusing them spreads from the wrong seed set
 * (the unlabeled-only toggle-OFF bug, CS 2026-08-08). */
let residentFieldLabeledSeeds = false;
let falloffShape: FalloffShape = "log"; // CS: field engine IS production; log is the leading shape
const falloffListeners = new Set<() => void>();
/**
 * DOUBLE-buffered falloff scratch (issue #315 P7, defect round 2026-07-25).
 *
 * Since S5 the applied buffer is ADOPTED as the DoI column AND handed to
 * `setOpacityField`, which keeps the reference as its opacity override — so a
 * single reused scratch made the live, uploaded, column-backing buffer the
 * very array `evalFalloffField` overwrites in place at the START of the next
 * commit. Any repaint that re-reads the override during that window (or any
 * future reader of `p.DoI`) would see a HALF-COMPUTED field: f(D) before the
 * seed clamp and before the trajectory chain, i.e. uniformly lower than both
 * the old and the new field.
 *
 * Alternating two buffers costs one extra 4 MB @1M and makes the invariant
 * structural: the buffer being written is never the buffer currently adopted.
 */
const falloffScratch: [Float32Array | undefined, Float32Array | undefined] = [
  undefined,
  undefined,
];
let falloffScratchSlot: 0 | 1 = 0;
/** The buffer the last apply materialized — App and the slider commit feed it
 * straight to setOpacityField (deletion census T4: rebuilding it from cols.doi
 * was a pure O(n) re-copy). Since S5 the GRAPH path sets it too (its scattered
 * overlay is a dense record-order field like the falloff one); null only after
 * a reset or an apply onto a non-columnar array, where the caller rebuilds. */
let lastFieldOpacity: Float32Array | null = null;

export function getAppliedFieldOpacity(): Float32Array | null {
  return lastFieldOpacity;
}

export function getFalloffShape(): FalloffShape {
  return falloffShape;
}

/** Set by the falloff radio; notifies subscribers (the UI re-render and the
 * commit trigger live with the caller — this store carries state only). */
export function setFalloffShape(shape: FalloffShape): void {
  if (shape === falloffShape) return;
  falloffShape = shape;
  for (const listener of falloffListeners) listener();
}

export function subscribeFalloffShape(listener: () => void): () => void {
  falloffListeners.add(listener);
  return () => falloffListeners.delete(listener);
}

/** The resident distance field of the latest field-path commit (null on the
 * graph path / before any commit). Consumers: the fit chain reads
 * visibleRanges, the live falloff remap reads recordDist. */
export function getResidentField(): ResidentDistanceField | null {
  return residentField;
}

/** The latest server DoI revision (keys slider re-propagates). A stale
 * revision after a dataset switch self-heals: the server answers 409 and
 * the caller re-seeds. */
export function getLastDoiRevision(): number | null {
  return lastRevision;
}

/** Drop the SERVER's retained DoI state for the points tree (empty-seed
 * clear, wire contract §6b) and reset the client mirror. The server keeps
 * DoI state per (tree, fit) across page loads and deselects; under P7
 * server-side selection that ghost state silently re-scores and
 * re-classifies every pushed frame (CS 2026-07-25: clusters vanished after
 * deselect and on reload, insets landed off-screen). Fire on deselect
 * commits and on dataset init. Errors are swallowed: a failed clear only
 * means the 409-re-seed path heals later, as before. */
export async function clearServerDoiState(): Promise<void> {
  const provider = resolveCutProvider(undefined);
  resetServerDoiState();
  if (!provider?.selectPropagate) return;
  try {
    // Params are irrelevant for a clear (empty seeds drop the retained
    // state regardless, §6b) — a fixed literal keeps this callable before
    // any Redux settings exist (dataset init).
    await provider.selectPropagate(
      "points",
      { ids: [] },
      {
        proximity: 0.5,
        past: 0.5,
        future: 0.5,
        maxEmbeddingDistance: 1,
        k: 0,
        thresholds: { grayOut: 0.05, annotation: 0.7, inset: 0.9 },
      }
    );
  } catch {
    /* offline/legacy server: local reset already done */
  }
}

/** Test/reset hook (dataset switches may also call this; staleness is
 * otherwise self-healing via 409-re-seed and the stash max-age). */
export function resetServerDoiState(): void {
  pendingOverlay = null;
  pendingPolygon = null;
  lastRevision = null;
  residentField = null;
  localFieldRevision = 0;
  residentFieldLabeledSeeds = false;
  falloffScratch[0] = undefined;
  falloffScratch[1] = undefined;
  falloffScratchSlot = 0;
  lastFieldOpacity = null;
  seedClampIdx = null;
  pinnedClampIdx = null;
  labeledZeroIdx = null;
  convRasterCache = null;
  convScratch.before = undefined;
  convScratch.grid = undefined;
  clearBakedDoi();
}

/**
 * Bake the applied field instead of writing it out per point (issue #315 P7
 * S5). Adopting the buffer AS the DoI column is an O(1) swap that leaves every
 * `p.DoI` reader correct; `bakedDoi` then answers the `doiGroup` ladder that
 * has no column to swap. Returns false when the array is not the canonical
 * column-backed dataset (small/synthetic arrays, tests) — the caller then runs
 * the legacy per-point loop, which is what keeps the client-complete path and
 * every non-columnar caller byte-identical.
 */
function bakeAppliedField(
  nodes: DataPoint[],
  field: Float32Array,
  thresholds: {
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  }
): boolean {
  if (!adoptDoiColumn(nodes, field)) return false;
  setBakedDoi(field, thresholds);
  return true;
}

/** Stash the overlay a fused lasso resolution brought back, for the
 * selection workflow of the SAME commit to consume instead of issuing a
 * second propagation RTT. `ids` = the node ids that lasso resolved to. */
export function stashPendingOverlay(overlay: DoiOverlay, ids: number[]): void {
  pendingOverlay = { overlay, ids, stashedAt: Date.now() };
  lastRevision = overlay.revision;
}

/** One-shot consume of a fresh stashed overlay (null when none/expired). */
export function consumePendingOverlay(): { overlay: DoiOverlay; ids: number[] } | null {
  const pending = pendingOverlay;
  pendingOverlay = null;
  if (!pending) return null;
  if (Date.now() - pending.stashedAt > PENDING_OVERLAY_MAX_AGE_MS) return null;
  return { overlay: pending.overlay, ids: pending.ids };
}

/** Client slider settings → the wire `propagate` block (§6a names + the §8
 * falloff routing field; the wire union still admits "hop" for the v1 graph
 * engine, but the client never sends it since #337 PR B). */
export function buildPropagateParams(
  settings: PropagationSliderSettings,
  k: number = DEFAULT_SERVER_PROPAGATION_K
): PropagateParams {
  return {
    proximity: settings.proximitySlider,
    past: settings.pastSlider,
    future: settings.futureSlider,
    maxEmbeddingDistance: settings.maxEmbeddingDistance,
    k,
    thresholds: {
      grayOut: settings.grayOutDoiThreshold,
      annotation: settings.annotationDoiThreshold,
      inset: settings.insetDoiThreshold,
    },
    falloff: { shape: falloffShape },
  };
}

/**
 * Whether a selection/slider commit should propagate server-side. False
 * routes to the client field lane (client-complete datasets,
 * labeled-exclusion mode, freehand pins — the server knows neither labels
 * nor pins). The small+resident-graph hop rule retired with the hop oracle
 * (#337 PR B).
 */
export function serverPropagationEligible(deps: {
  nodeCount: number;
  labeledExclusionActive: boolean;
  pinnedCount: number;
}): boolean {
  const provider = resolveCutProvider(undefined);
  if (!provider?.selectPropagate) return false;
  if (deps.labeledExclusionActive || deps.pinnedCount > 0) return false;
  return true;
}

/**
 * Scatter a sparse leaf-order overlay into record order. O(reach) scatter into
 * a dense record-order field.
 *
 * Since S5 the field itself is the result: it is adopted as the DoI column and
 * handed to `setOpacityField` buffer-direct, so the graph path no longer runs
 * the O(n) `node.DoI` + `cols.doi[i]` + `doiGroup` STRING loop either (the two
 * value writes were also redundant — `node.DoI` IS an accessor into
 * `cols.doi`). Arrays without canonical columns keep the legacy loop.
 */
export function applyOverlay(
  nodes: DataPoint[],
  leafOrder: ArrayLike<number>,
  overlay: DoiOverlay,
  thresholds: {
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  }
): void {
  const n = nodes.length;
  const doi = new Float32Array(n); // unreached points hold base 0
  const { runs, values } = overlay;
  let vi = 0;
  for (const [start, length] of runs) {
    for (let pos = start; pos < start + length; pos++) {
      doi[leafOrder[pos]] = values[vi++];
    }
  }
  if (bakeAppliedField(nodes, doi, thresholds)) {
    lastFieldOpacity = doi; // buffer-direct: App uploads exactly this
    return;
  }
  const cols = columnsOf(nodes);
  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    node.DoI = doi[i];
    if (cols) cols.doi[i] = doi[i];
    updateNodeGroup(node, thresholds);
  }
  lastFieldOpacity = null; // non-columnar apply: App rebuilds from cols.doi
}

/**
 * One-pass trajectory chain closure over `values` IN PLACE (the field
 * engine's trajectory term, first alternation round): a successor takes
 * `future · predecessor`, a predecessor takes `past · successor`. One
 * forward and one backward pass suffice — decay < 1 makes the optimal chain
 * monotone, and pred/succ point along array order per line (S5).
 */
export function chainScanTrajectory(
  nodes: DataPoint[],
  values: Float32Array,
  past: number,
  future: number
): void {
  const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
  chainScanTrajectoryCore(values, predIndex, succIndex, past, future);
}

// ── Converged execution shared by COMMIT and DRAG PREVIEW ──────────────────
//
// Both lanes run the identical alternation (convergedField.ts) — the
// preview-equals-commit contract (CS 14.08: the thumb must show the REAL
// converged result; a preview whose semantics differ from the commit is
// dead). The raster and the round buffers are cached here because the
// preview runs this at ~10 Hz: the raster is per-field (coords don't change
// under a resident field — a new selection commit replaces the field object
// and the cache follows), the scratch is safe to share between lanes
// because the field lane is main-thread synchronous.

/** Raster cache keyed on the resident field's identity. */
let convRasterCache: { field: ResidentDistanceField; raster: FieldRaster } | null =
  null;
const convScratch: ConvergedScratch = {};

function convRasterFor(nodes: DataPoint[]): FieldRaster {
  const field = residentField;
  if (field && convRasterCache?.field === field) return convRasterCache.raster;
  const coords = snapshotCoords(nodes);
  const raster = rasterize(coords.x, coords.y, FIELD_GRID_RESOLUTION);
  if (field) convRasterCache = { field, raster };
  return raster;
}

/** Run the converged alternation over `v` in place — the ONE executor both
 * the commit apply and the drag preview call, so their outputs are identical
 * by construction for equal inputs. */
function runConvergedField(
  nodes: DataPoint[],
  v: Float32Array,
  shape: FalloffShape,
  settings: PropagationSliderSettings
): ConvergedFieldStats {
  const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
  return runConvergedAlternationCore(
    v,
    predIndex,
    succIndex,
    () => convRasterFor(nodes),
    {
      shape,
      prox: settings.proximitySlider,
      maxEmb: settings.maxEmbeddingDistance,
      past: settings.pastSlider,
      future: settings.futureSlider,
      scratch: convScratch,
    }
  );
}

/** Labeled/pinned inputs of a field-lane commit (#337 hop retirement) —
 * the `propagateDoI` vocabulary, mirroring `doi_field.propagate_doi_field`:
 * labeled ids never seed (`seed_mask = selected & ~labeled`) and their
 * doiGroup caps at transparent; pinned ids clamp to DoI 1 AFTER the chain
 * (pins receive, never emit). */
export interface FieldLaneExclusions {
  labeledNodeIds?: Set<string>;
  pinnedNodeIds?: ReadonlySet<number>;
}

/** Record indices whose node id satisfies `isMember` — one columnar id scan.
 * Only runs when an exclusion set is non-empty (labeled/pins are
 * small-dataset workflows). */
function recordIndicesOf(
  nodes: DataPoint[],
  isMember: (id: number) => boolean
): number[] {
  const cols = columnsOf(nodes);
  const idx: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const id = cols ? cols.id[i] : nodes[i].id;
    if (isMember(id)) idx.push(i);
  }
  return idx;
}

/**
 * Local falloff application over the resident distance field: `f(D)` +
 * the trajectory chain term, written into DoI + the doiGroup ladder. This
 * is the zero-RTT half of the v2 contract — the falloff radio and the
 * proximity slider re-run THIS, never the server. First-order vs the
 * server's exact alternation (documented in plan §8); the commit re-syncs
 * server truth for doiMass/visibleRanges.
 * Returns false when no field state is resident (caller falls back).
 */
export function applyResidentFieldLocally(
  nodes: DataPoint[],
  settings: PropagationSliderSettings,
  /** Record indices of the current selection, when the caller already scanned
   * for them (issue #315 P7 S5) — spares one more O(n) `selected` sweep per
   * commit. Omitted ⇒ this function scans. NOTE: with labeled exclusion the
   * hint must already be `selected & ~labeled` (runLocalFieldPropagation
   * passes exactly that). */
  seedIdxHint?: readonly number[],
  exclusions?: FieldLaneExclusions
): boolean {
  const field = residentField;
  const shape = falloffShape;
  if (!field || field.recordDist.length !== nodes.length) {
    return false;
  }
  const labeledNodeIds = exclusions?.labeledNodeIds?.size
    ? exclusions.labeledNodeIds
    : undefined;
  const labeledIdx = labeledNodeIds
    ? recordIndicesOf(nodes, (id) => labeledNodeIds.has(String(id)))
    : null;
  const pinnedIdx = exclusions?.pinnedNodeIds?.size
    ? recordIndicesOf(nodes, (id) => exclusions.pinnedNodeIds!.has(id))
    : null;
  // Write into the slot the LAST apply did not adopt (see falloffScratch).
  const slot = falloffScratchSlot;
  const v = evalFalloffField(
    field.recordDist,
    shape,
    settings.proximitySlider,
    settings.maxEmbeddingDistance,
    falloffScratch[slot]
  );
  falloffScratch[slot] = v;
  falloffScratchSlot = slot === 0 ? 1 : 0;
  // Seeds are ALWAYS exactly 1 — from the selection flags, never from
  // D=0 (grid-coincident non-seeds must not inherit seedhood; at p=0 the
  // falloff is 0 everywhere and only this clamp feeds the chain). The
  // indices are cached so drag-preview ticks clamp O(k), not O(n).
  // Labeled points are never seeds (#337: seed_mask = selected & ~labeled) —
  // they still receive falloff/chain DoI like any other point.
  if (seedIdxHint) {
    for (const i of seedIdxHint) v[i] = 1;
    seedClampIdx = seedIdxHint as number[];
  } else {
    const excludedSeed =
      labeledIdx && labeledIdx.length ? new Set(labeledIdx) : null;
    // Selection column (issue #315 R1a, §3.1): the seed indices come from the
    // maintained list — O(selection) instead of a full row walk.
    const fromColumn = selectedIndicesOf(nodes);
    if (fromColumn) {
      const seedIdx: number[] = [];
      for (let k = 0; k < fromColumn.length; k++) {
        const i = fromColumn[k];
        if (excludedSeed?.has(i)) continue;
        v[i] = 1;
        seedIdx.push(i);
      }
      seedClampIdx = seedIdx;
    } else {
      const seedIdx: number[] = [];
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].selected && !excludedSeed?.has(i)) {
          v[i] = 1;
          seedIdx.push(i);
        }
      }
      seedClampIdx = seedIdx;
    }
  }
  // Converged commit (paper model, replaces the single first-order chain
  // pass): chain ↔ re-spread alternation to the fixed point. Rasterization
  // is lazy — a chain-inert dataset (one line per point) never pays it and
  // the output is byte-identical to the old single chain scan. Drag previews
  // run the SAME executor (previewFalloffOpacity below), so what the held
  // thumb shows IS what this commit paints.
  {
    const t0 = performance.now();
    const stats = runConvergedField(nodes, v, shape, settings);
    ledgerEvent(
      "doi:converged",
      `rounds=${stats.rounds} respreads=${stats.respreads} ` +
        `delta=${stats.maxDelta.toExponential(2)} ` +
        `ms=${(performance.now() - t0).toFixed(1)}` +
        (stats.converged ? "" : " CEILING")
    );
  }
  // Pins: DoI 1 AFTER the chain, before the bake (#337 — the graph oracle's
  // postcondition, doi[pinned] = 1.0 in doi_field.apply_falloff). Pins are
  // not seeds and must never feed the chain.
  if (pinnedIdx) for (const i of pinnedIdx) v[i] = 1;
  pinnedClampIdx = pinnedIdx;
  labeledZeroIdx = labeledIdx;
  if (labeledNodeIds) {
    // Labeled-exclusion mode takes the legacy per-point loop (#337): the
    // baked ladder is deliberately dependency-free and has no labeled
    // branch, and labeled mode is a small-dataset workflow — the per-point
    // updateNodeGroup writes carry the excluded cap exactly like the graph
    // oracle did. A stale bake from an earlier unlabeled commit must stop
    // answering.
    clearBakedDoi();
    const cols = columnsOf(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      node.DoI = v[i];
      if (cols) cols.doi[i] = v[i];
      updateNodeGroup(node, settings, labeledNodeIds);
    }
    // No applied buffer: both dispatch sites rebuild the opacity field
    // through their labeled-zeroing branch (labeled points paint 0).
    lastFieldOpacity = null;
    return true;
  }
  // S5: bake instead of materialize — the O(n) DoI + doiGroup-STRING loop
  // below is the ~1.3 s half of the lasso RTT at 1M and is skipped whenever
  // the buffer can be adopted as the column.
  if (!bakeAppliedField(nodes, v, settings)) {
    const cols = columnsOf(nodes);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      node.DoI = v[i];
      if (cols) cols.doi[i] = v[i];
      updateNodeGroup(node, settings);
    }
  }
  lastFieldOpacity = v;
  return true;
}

let previewScratch: Float32Array | undefined;
/** Selected record indices captured by the last commit apply — the drag
 * preview's seed clamp is O(k) with it (a 1M flag scan per tick was part
 * of the drag jank). Invalidated on reset; refreshed by every apply. */
let seedClampIdx: number[] | null = null;
/** Pinned record indices of the last commit apply (#337) — the preview
 * replays the post-chain DoI-1 clamp with them. Null when no pins. */
let pinnedClampIdx: number[] | null = null;
/** Labeled record indices of the last commit apply (#337) — the preview
 * replays the labeled opacity zeroing with them. Null outside
 * unlabeled-only mode. */
let labeledZeroIdx: number[] | null = null;

/** The selected record indices captured by the last field commit apply — the
 * field-preview WORKER copies these as its seed clamp (init once per commit).
 * Null before any commit apply; the caller then keeps the synchronous path. */
export function getSeedClampIndices(): number[] | null {
  return seedClampIdx;
}

/** Cheap route probe for the drag preview: a resident field matching the
 * node count under a field shape. */
export function hasResidentFieldPreview(nodeCount: number): boolean {
  return (
    residentField !== null &&
    residentField.recordDist.length === nodeCount
  );
}

/**
 * Whether the resident field may be REUSED by a commit with the given labeled
 * state (#337): the distances are seed-dependent, and a labeled-mode commit
 * seeds them from `selected & ~labeled` — so a commit on the OTHER side of
 * the unlabeled-only toggle must recompute (reuse spread from the wrong seed
 * set: the toggle-OFF restoration bug, CS 2026-08-08). Labeled commits always
 * recompute (assignments move between commits), so `labeledActive` reuse is
 * never offered.
 */
export function canReuseResidentField(
  nodeCount: number,
  labeledActive: boolean
): boolean {
  return (
    !labeledActive &&
    !residentFieldLabeledSeeds &&
    hasResidentFieldPreview(nodeCount)
  );
}

/**
 * Drag-preview opacity over the resident distance field — the CONVERGED
 * field, identical to what the release commit paints (CS 14.08: the thumb
 * must show the REAL result; the round-0 preview whose semantics differed
 * from the commit is dead). Runs the same `runConvergedField` executor as
 * `applyResidentFieldLocally` on the same inputs, so preview-equals-commit
 * holds by construction; NO node/group writes. Null when no field is
 * resident — the caller skips the preview.
 */
export function previewFalloffOpacity(
  nodes: DataPoint[],
  settings: PropagationSliderSettings
): Float32Array | null {
  const field = residentField;
  const shape = falloffShape;
  if (!field || field.recordDist.length !== nodes.length) {
    return null;
  }
  // Same seed clamp as applyResidentFieldLocally (selection flags, not
  // D=0) — O(k) via the commit-time index cache; O(n) scan only if a
  // preview somehow runs before any commit apply.
  let seeds: ArrayLike<number>;
  if (seedClampIdx) {
    seeds = seedClampIdx;
  } else {
    const fromColumn = selectedIndicesOf(nodes);
    if (fromColumn) {
      seeds = fromColumn;
    } else {
      const scanned: number[] = [];
      for (let i = 0; i < nodes.length; i++) if (nodes[i].selected) scanned.push(i);
      seeds = scanned;
    }
  }
  const { predIndex, succIndex } = getPropagationPrecomputation(nodes);
  // The ONE converged executor (also the worker's compute and, minus the
  // pin/labeled replay, the commit's) — preview == commit by construction.
  // Pins hold DoI 1 post-alternation, labeled points paint transparent in
  // unlabeled-only mode (#337): the last commit's sets, replayed.
  const v = computeConvergedPreview(
    {
      recordDist: field.recordDist,
      predIndex,
      succIndex,
      seedIdx: seeds,
      pinnedIdx: pinnedClampIdx,
      labeledZeroIdx,
      getRaster: () => convRasterFor(nodes),
      shape,
      prox: settings.proximitySlider,
      past: settings.pastSlider,
      future: settings.futureSlider,
      maxEmb: settings.maxEmbeddingDistance,
    },
    previewScratch,
    convScratch
  );
  previewScratch = v;
  return v;
}

/** The cached per-field raster for the GPU motion lane
 * (plan-gpu-motion-lane.md) — the SAME raster object the sync/commit
 * converged lanes share (convRasterFor), so the GPU executor rasterizes
 * against identical cell geometry. Null when no field is resident. */
export function getFieldPreviewRaster(nodes: DataPoint[]): FieldRaster | null {
  if (!residentField || residentField.recordDist.length !== nodes.length) {
    return null;
  }
  return convRasterFor(nodes);
}

/** Always true since converged previews (CS 14.08): the round-0 SHADER
 * frozen-chain preview cannot express the converged re-spread, and this
 * probe (via the hook's canFreezeChain) is what keeps that lane dark. The
 * shader machinery stays in place for the coming GPU motion lane (step B),
 * which will re-open this switch with converged-capable GPU compute.
 * Sync-vs-WORKER routing moved to `fieldPreviewExclusionsActive` — the
 * worker runs the converged compute off-thread since the thumb-lag fix. */
export function fieldPreviewRequiresSync(): boolean {
  return true;
}

/** True when the LAST field commit carried pins or labeled exclusion (#337):
 * the preview worker protocol does not carry either replay set — deliberately,
 * because both can change WITHOUT a field-revision bump (the worker's init
 * identity), so a resident worker copy could go stale. Excluded drags take
 * the throttled synchronous remap, which replays both via
 * `previewFalloffOpacity`; both are small-dataset workflows. */
export function fieldPreviewExclusionsActive(): boolean {
  return pinnedClampIdx !== null || labeledZeroIdx !== null;
}

async function runFieldPropagation(
  nodes: DataPoint[],
  seeds: PropagateSeeds,
  settings: PropagationSliderSettings,
  seedIdxHint?: readonly number[]
): Promise<boolean> {
  const provider = resolveCutProvider(undefined);
  if (!provider?.selectPropagateField) return false;
  const [buffer, leafOrder] = await Promise.all([
    provider.selectPropagateField("points", seeds, buildPropagateParams(settings)),
    provider.getLeafOrder("points"),
  ]);
  const dst = unpackDst1(buffer);
  if ("revision" in seeds && dst.nLeaves === 0 && residentField) {
    // Shape-3 = same seeds = same distances: a server that omits the 4 MB
    // distance array (nLeaves 0) means "keep what you have" — only the
    // revision/threshold artifacts changed. (Never ambiguous with a clear:
    // shape-3 requests always carry retained non-empty seeds.)
    residentField = {
      ...residentField,
      revision: dst.revision,
      focusActive: dst.focusActive,
      visibleRanges: dst.visibleRanges,
    };
  } else {
    // Leaf → record scatter, once per selection; the remap reads record order.
    const recordDist = new Float32Array(nodes.length).fill(Infinity);
    const n = Math.min(dst.dGeo.length, leafOrder.length);
    for (let pos = 0; pos < n; pos++) recordDist[leafOrder[pos]] = dst.dGeo[pos];
    residentField = {
      revision: dst.revision,
      focusActive: dst.focusActive,
      nLeaves: dst.nLeaves,
      recordDist,
      visibleRanges: dst.visibleRanges,
    };
  }
  // Server lane: labeled/pins commits never reach it (eligibility), so the
  // server field is always full-seed.
  residentFieldLabeledSeeds = false;
  lastRevision = dst.revision;
  applyResidentFieldLocally(nodes, settings, seedIdxHint);
  ledgerEvent(
    "doi:server-field",
    `rev=${dst.revision} shape=${falloffShape} focus=${dst.focusActive}`
  );
  return true;
}

// ── Client field lane (issue #315 field parity / #337) ──────────────────────
//
// The distance field is computed CLIENT-SIDE (CS merge-gate decision #2,
// plan-315-field-parity.md): rasterize → exact EDT → bilinear sample in a
// one-shot worker, then the EXISTING residentField machinery —
// applyResidentFieldLocally, the fieldPreview worker, the GPU drag preview,
// the release cross-fade — runs unchanged. Dispatch order at the commit
// sites: server field > client field; the client lane runs whenever the
// server did not apply (no provider, labeled/pins refusal, or server
// failure — the hop oracle it used to degrade to is gone, #337 PR B). NO
// size cap (D3: the hop fallback was not cheaper at any size).

/** Coord copies for the workers (the buffers are TRANSFERRED — never hand
 * over the live column arrays). Row-object fallback for non-columnar sets.
 * Exported for the drag-preview worker init's coords thunk. */
export function snapshotCoords(nodes: DataPoint[]): { x: Float64Array; y: Float64Array } {
  const cols = columnsOf(nodes);
  if (cols) {
    return { x: new Float64Array(cols.x), y: new Float64Array(cols.y) };
  }
  const n = nodes.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = nodes[i].x;
    y[i] = nodes[i].y;
  }
  return { x, y };
}

/**
 * Selection-commit distance field, computed client-side: the provider-less
 * sibling of `runFieldPropagation`. Populates `residentField` identically to
 * the server path (empty `visibleRanges` — both consumers null-guard) and
 * applies via the existing `applyResidentFieldLocally`, so the whole
 * downstream drag machinery works with zero changes. Slider commits need no
 * recompute (the field is seed-dependent only) — re-run
 * `applyResidentFieldLocally` instead.
 *
 * Returns false on empty selection (after clearing the resident state — the
 * deselect mirror of the server lane's clearServerDoiState local half).
 * Rejects with AbortError when superseded. A worker failure falls back to the
 * pure core inline (widget/jsdom — the fieldPreview sync-fallback pattern).
 */
export async function runLocalFieldPropagation(
  nodes: DataPoint[],
  settings: PropagationSliderSettings,
  seedIdxHint?: readonly number[],
  opts?: {
    signal?: AbortSignal;
    /** Test seam: replaces the worker call (jsdom has no Worker). */
    runner?: typeof computeRecordDistancesInWorker;
  } & FieldLaneExclusions
): Promise<boolean> {
  const n = nodes.length;
  if (n === 0) return false;

  // Labeled points never seed the distance field (#337: the EDT sources are
  // seed_mask = selected & ~labeled, exactly like doi_field.base_distance).
  const labeledNodeIds = opts?.labeledNodeIds?.size
    ? opts.labeledNodeIds
    : undefined;
  const excludedSeed = labeledNodeIds
    ? new Set(recordIndicesOf(nodes, (id) => labeledNodeIds.has(String(id))))
    : null;
  let rawSeedCount: number;
  let seedIdx: number[];
  if (seedIdxHint) {
    rawSeedCount = seedIdxHint.length;
    seedIdx = excludedSeed
      ? (seedIdxHint as number[]).filter((i) => !excludedSeed.has(i))
      : (seedIdxHint as number[]);
  } else {
    const fromColumn = selectedIndicesOf(nodes);
    if (fromColumn) {
      rawSeedCount = fromColumn.length;
      seedIdx = excludedSeed
        ? Array.from(fromColumn).filter((i) => !excludedSeed.has(i))
        : Array.from(fromColumn);
    } else {
      rawSeedCount = 0;
      seedIdx = [];
      for (let i = 0; i < n; i++) {
        if (!nodes[i].selected) continue;
        rawSeedCount++;
        if (!excludedSeed?.has(i)) seedIdx.push(i);
      }
    }
  }
  if (seedIdx.length === 0) {
    // Drop the resident field either way — no seeds, no distances, and no
    // stale preview lane may survive.
    resetServerDoiState();
    if (labeledNodeIds && rawSeedCount > 0) {
      // Selection entirely labeled (#337 PR B): the field-lane twin of the
      // python no-seed branch (propagate_doi_field: doi = 1 everywhere,
      // groups = ladder + excluded cap). Formerly the graph oracle's
      // full-space fallback.
      const cols = columnsOf(nodes);
      for (let i = 0; i < n; i++) {
        const node = nodes[i];
        node.DoI = 1;
        if (cols) cols.doi[i] = 1;
        updateNodeGroup(node, settings, labeledNodeIds);
      }
      lastFieldOpacity = null; // callers repaint via their zeroing branch
      return true;
    }
    return false;
  }

  let recordDist: Float32Array;
  try {
    const { x, y } = snapshotCoords(nodes);
    // Lazy import: the worker factory module uses `import.meta`, which the
    // ts-jest graph cannot parse — and the worker chunk stays off the boot
    // path until the first field commit (the commitPropagation.ts seam).
    const runner =
      opts?.runner ??
      (await import("./fieldDistanceWorker")).computeRecordDistancesInWorker;
    recordDist = await runner(
      { x, y, seedIdx: Int32Array.from(seedIdx), gridResolution: FIELD_GRID_RESOLUTION },
      { signal: opts?.signal }
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // Worker unavailable (widget blob URL edge, jsdom) or died: the pure core
    // inline, on FRESH copies (the failed attempt may have neutered the
    // transferred buffers).
    const { x, y } = snapshotCoords(nodes);
    recordDist = computeRecordDistances({
      x,
      y,
      seedIdx,
      gridResolution: FIELD_GRID_RESOLUTION,
    }).recordDist;
  }
  if (opts?.signal?.aborted) {
    throw new DOMException("Field distance aborted", "AbortError");
  }

  localFieldRevision += 1;
  residentField = {
    revision: localFieldRevision,
    focusActive: true,
    nLeaves: n,
    recordDist,
    visibleRanges: [],
  };
  residentFieldLabeledSeeds = !!labeledNodeIds;
  const applied = applyResidentFieldLocally(nodes, settings, seedIdx, {
    labeledNodeIds,
    pinnedNodeIds: opts?.pinnedNodeIds,
  });
  ledgerEvent(
    "doi:local-field",
    `rev=${localFieldRevision} shape=${falloffShape} seeds=${seedIdx.length}`
  );
  return applied;
}

async function runServerPropagation(
  nodes: DataPoint[],
  seeds: PropagateSeeds,
  settings: PropagationSliderSettings
): Promise<boolean> {
  const provider = resolveCutProvider(undefined);
  if (!provider?.selectPropagate) return false;
  const [result, leafOrder] = await Promise.all([
    provider.selectPropagate("points", seeds, buildPropagateParams(settings)),
    provider.getLeafOrder("points"),
  ]);
  applyOverlay(nodes, leafOrder, result.overlay, settings);
  lastRevision = result.overlay.revision;
  ledgerEvent(
    "doi:server",
    `rev=${result.overlay.revision} runs=${result.overlay.runs.length} focus=${result.overlay.focusActive}`
  );
  return true;
}

/** §8.8d: a failed propagate that degrades to the client field is a
 * server-loss surface and must be announced (utils/serverLoss.ts: "every
 * degraded surface funnels through here" — restored per CS's #337 row-4
 * verdict). Probe-first like clusteringService's stream-loss path, so a
 * transient error against a live server stays silent; without a probe
 * capability the thrown propagate is itself the loss evidence. */
function warnIfServerLost(provider: { probeHealth?(): Promise<boolean> }): void {
  if (!provider.probeHealth) {
    warnServerLoss();
    return;
  }
  void provider.probeHealth().then((ok) => {
    if (!ok) warnServerLoss();
  });
}

/**
 * Selection-commit propagation via the server (issue #315 P-d). Consumes a
 * fused-lasso overlay when one is pending (zero extra RTTs); otherwise one
 * `seeds:{ids}` POST with the selected RECORD indices. Returns false on any
 * failure — the caller keeps the local path as fallback.
 */
export async function propagateSelectionOnServer(
  nodes: DataPoint[],
  settings: PropagationSliderSettings
): Promise<boolean> {
  const provider = resolveCutProvider(undefined);
  if (!provider?.selectPropagate) return false;
  // Chip taxonomy A5: set at propagate dispatch, cleared once the overlay /
  // field has been applied (the `finally` runs after every apply site, and
  // after the early no-selection return — which is synchronous, so React
  // batches set+clear and the chip never paints).
  beginDoiChip();
  try {
    // One scan: record indices (the seed vocabulary, S6) AND the node-id
    // set (to validate lasso stashes against the FULL selection — a
    // ctrl-chained selection is a superset of the last lasso, and the
    // polygon/overlay shortcuts must never drop the earlier chain members).
    // Selection column (issue #315 R1a, §3.1): the scan that discovered the
    // seeds by walking every row is now a read of the maintained index list
    // plus one id-column lookup per SELECTED point — the single load-bearing
    // full-array `selected` dependency the row census named.
    const ids: number[] = [];
    const selectedIdSet = new Set<number>();
    const selCols = columnsOf(nodes);
    const selIdx = selectedIndicesOf(nodes);
    if (selIdx && selCols) {
      for (const i of selIdx) {
        ids.push(i);
        selectedIdSet.add(selCols.id[i]);
      }
    } else {
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].selected) {
          ids.push(i);
          selectedIdSet.add(nodes[i].id);
        }
      }
    }
    if (ids.length === 0) {
      // Deselect: the SERVER must forget the selection too, or every pushed
      // select frame keeps scoring against the ghost DoI state. Await it so
      // the A3 re-select push the clear triggers reflects the cleared state.
      if (lastRevision !== null) await clearServerDoiState();
      return false; // the local pipeline still runs its own reset
    }
    // Field path (v2, the production default): DST1 distance commit.
    if (provider.selectPropagateField) {
      consumePendingOverlay(); // drop any stale graph-path stash
      // The stashed lasso polygon spares the O(selection) ids upload, but
      // only seeds correctly when it IS the whole selection.
      const pendingPoly = consumePendingPolygon();
      if (pendingPoly && stashMatchesSelection(pendingPoly.ids, selectedIdSet)) {
        return await runFieldPropagation(nodes, { polygon: pendingPoly.polygon }, settings, ids);
      }
      return await runFieldPropagation(nodes, { ids }, settings, ids);
    }
    const pending = consumePendingOverlay();
    if (pending && stashMatchesSelection(pending.ids, selectedIdSet)) {
      const leafOrder = await provider.getLeafOrder("points");
      applyOverlay(nodes, leafOrder, pending.overlay, settings);
      ledgerEvent("doi:server", `rev=${pending.overlay.revision} (fused lasso overlay)`);
      return true;
    }
    return await runServerPropagation(nodes, { ids }, settings);
  } catch (error) {
    ledgerEvent("doi:fallback", String(error));
    warnIfServerLost(provider);
    return false;
  } finally {
    endDoiChip();
  }
}

/**
 * Slider-commit re-propagation via the server: shape 3 (retained revision),
 * falling back to re-seeding from the current selection on 409, and to the
 * local path (false) on anything else.
 */
export async function propagateSliderCommitOnServer(
  nodes: DataPoint[],
  settings: PropagationSliderSettings
): Promise<boolean> {
  const provider = resolveCutProvider(undefined);
  if (!provider?.selectPropagate) return false;
  const fieldPath = !!provider.selectPropagateField;
  // Same cause/effect pair as the selection commit; the 409 re-seed nests
  // through propagateSelectionOnServer, which the chip's depth counter folds
  // into ONE pending state.
  beginDoiChip();
  try {
    if (lastRevision !== null) {
      try {
        // Field path: the server reuses the cached FieldContext (no distance
        // recompute) and re-stamps under the new falloff/sliders.
        return fieldPath
          ? await runFieldPropagation(nodes, { revision: lastRevision }, settings)
          : await runServerPropagation(nodes, { revision: lastRevision }, settings);
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        ledgerEvent("doi:reseed", `revision ${lastRevision} superseded`);
      }
    }
    return await propagateSelectionOnServer(nodes, settings);
  } catch (error) {
    ledgerEvent("doi:fallback", String(error));
    warnIfServerLost(provider);
    return false;
  } finally {
    endDoiChip();
  }
}
