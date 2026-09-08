// src/scaling.types.ts
//
// Open-core type surface for the tile/backend scaling seam (issue #315).
//
// These are TYPES ONLY (plus two pure, dependency-free helpers) and are safe to
// ship in the public bundle: they describe the contract between the app and the
// (build-excluded) `src/scaling/` implementation. Both the real module
// (`src/scaling/index.ts`) and the public stub (`src/scaling.stub.ts`) implement
// this contract, so the `@scaling` import resolves to a type-compatible module
// in either build. See `plan-315-tiled-backend.md`.
//
// The `import type` below is erased at build time, so this file stays free of
// runtime dependencies and remains safe to ship publicly.

/** A pointer to one cluster member. The frontend sends refs, never payloads. */
export interface MemberRef {
  /** Stable point id (`DataPoint.id`). */
  id: number;
  /** Trajectory / line id (`DataPoint.line`) — disambiguates shared ids. */
  line: number;
}

/**
 * Manifest `backend:` section — the remote inset/tile service for a dataset.
 * `baseUrl` is an ABSOLUTE url resolved from the manifest/config: the dev target
 * is a localhost port, the live target is the lab AWS endpoint. Nothing in the
 * protocol may assume localhost.
 */
export interface BackendManifest {
  /** Provider family, e.g. "gym" | "tabular-stats" | "image". */
  kind: string;
  /** Absolute base url of the service (dev: http://localhost:PORT, live: AWS). */
  baseUrl: string;
  /** Opaque dataset identifier the service uses to resolve member refs. */
  datasetId?: string;
  /** Optional capability advertisements (e.g. ["node", "diff"]). */
  capabilities?: string[];
}

/**
 * Range-backed member set (issue #315): half-open ranges into a tree's
 * boot-once leaf order — the O(1) alternative to shipping O(members)
 * MemberRefs for cut-driven clusters. Attached by `cutDrivenGroups` to its
 * group arrays as the non-enumerable `__leafRange` marker.
 */
export interface LeafRangeRef {
  tree: "points" | "midpoints";
  ranges: Array<[number, number]>;
  /** Fitted-subset scope (issue #315 F2c): ranges index the FITTED tree's
   * leaf order, so the request and its cache key must carry the fitId. */
  fit?: string;
}

/** Reads the `__leafRange` marker off a cut-driven samples/refs array. */
export function leafRangeOf(arr: unknown): LeafRangeRef | null {
  return (arr as { __leafRange?: LeafRangeRef })?.__leafRange ?? null;
}

/** Per-request knobs shared by every provider (content-agnostic). */
export interface InsetRequestOptions {
  /** Cap on members aggregated server-side (subsampling). */
  maxSamples?: number;
  /** Requested output size hint (px) for image providers. */
  size?: number;
  /** Ask the service to RENDER the payload server-side (issue #315 wave S,
   * inset shells): "png" requests one image instead of the JSON rows.
   * Services that don't support rendering ignore the field and answer
   * JSON — callers must handle either payload. Participates in cache keys
   * (a rows request must never hit a cached PNG for the same members). */
  format?: "png";
}

/**
 * Aggregated inset payload for one cluster (or one A/B pair). Content-agnostic:
 * image providers populate `url` (an object URL owned by the client cache),
 * stats/board providers populate `json`.
 */
export interface InsetResponse {
  /** Object URL of a binary payload (image). Undefined for JSON payloads. */
  url?: string;
  /** Parsed JSON payload (e.g. tabular SummaryRow[] / DiffRow[]). */
  json?: unknown;
  /** Members actually aggregated after subsampling. */
  nRendered: number;
  /** Total members referenced. */
  nTotal: number;
}

/**
 * Turns cluster member references into one aggregated inset payload on demand.
 * Node insets aggregate one member set; diff insets take two-sided A/B sets
 * (mirrors the client-side `edgeSplit`).
 */
export interface InsetContentProvider {
  /** True for the real backend provider; false/absent for local paths. */
  readonly isBackend: boolean;
  /** The backend this provider talks to (adapters gate on `kind` and use
   * `baseUrl`/`datasetId` for their unreachable-service hints). */
  readonly manifest: BackendManifest;
  /**
   * Coalescing/LRU key of a node (resp. A/B diff) request — the key `cancel`
   * takes, and the sync-cache key for `getCachedInset` (shared transport).
   * Namespaced per backend kind + dataset so services cannot collide.
   */
  nodeInsetKey(refs: MemberRef[], opts?: InsetRequestOptions): string;
  diffInsetKey(aRefs: MemberRef[], bRefs: MemberRef[], opts?: InsetRequestOptions): string;
  getNodeInset(refs: MemberRef[], opts?: InsetRequestOptions): Promise<InsetResponse>;
  getDiffInset(
    aRefs: MemberRef[],
    bRefs: MemberRef[],
    opts?: InsetRequestOptions
  ): Promise<InsetResponse>;
  /**
   * Range-backed node inset (issue #315, optional): the request carries
   * leafRanges instead of O(members) refs. Providers that implement it must
   * fall back to `refsFallback` transparently when the service rejects
   * ranges (older server without a cut service for the tree).
   */
  nodeInsetRangeKey?(range: LeafRangeRef, opts?: InsetRequestOptions): string;
  getNodeInsetByRange?(
    range: LeafRangeRef,
    refsFallback: () => MemberRef[],
    opts?: InsetRequestOptions
  ): Promise<InsetResponse>;
  /** Range-backed diff inset (both sides cut-driven) — same contract. */
  diffInsetRangeKey?(a: LeafRangeRef, b: LeafRangeRef, opts?: InsetRequestOptions): string;
  getDiffInsetByRange?(
    a: LeafRangeRef,
    b: LeafRangeRef,
    refsFallbackA: () => MemberRef[],
    refsFallbackB: () => MemberRef[],
    opts?: InsetRequestOptions
  ): Promise<InsetResponse>;
  /** Drop a single member set (or A/B pair) request in flight, by cache key. */
  cancel(key: string): void;
}

/**
 * Configure the active backend for the current dataset (called on dataset
 * switch). `null` clears it (offline / no backend declared). The open-core stub
 * ignores this.
 */
export type SetActiveBackend = (manifest: BackendManifest | null | undefined) => void;

/** Resolve the known LOCAL inset service for a catalog dataset path (issue
 * #315 catalog unification): health-gated, localhost-only, null on any miss.
 * The open-core stub always resolves null — deciding server vs client insets
 * at runtime is a server-build capability, never a dataset-tab choice. */
export type ResolveKnownLocalBackend = (datasetPath: string) => Promise<BackendManifest | null>;

// ---------------------------------------------------------------------------
// Server-side hierarchy cut (issue #315, phase S2)
// ---------------------------------------------------------------------------

/** One candidate from the server's hybrid-cut walk (the frontier node). */
export interface CutCandidate {
  /** DFS pre-order hex uid — identical to the client's reuid() scheme. */
  uid: string;
  size: number;
  stability: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Half-open ranges into the boot-once leafOrder permutation. */
  leafRanges: Array<[number, number]>;
  /** Server-computed contour vertices (issue #315 D1) — the client renders
   * this instead of touching members. Optional: older services omit it. */
  hull?: Array<[number, number]> | null;
  /** Server-computed non-overlapping inset seed position in DATA coords
   * (issue #315 wave S3/S4): the client seeds its layout from it and the
   * annealer only polishes. Optional: older services omit it. */
  insetPos?: [number, number] | null;
  /** Server-stamped DoI mass (issue #315 A3 / P-d, plan §6e): the prefix-sum
   * of the candidate's leafRanges over the frame's DoI vector. Present ONLY
   * when server DoI state exists for the frame's (tree, fit); the client
   * prefers it over its own `clusterDoiMassFromPrefix`/member-loop, and falls
   * back to those unchanged when absent (client-complete datasets stay
   * bit-identical). */
  doiMass?: number;
}

/** Inputs of one cut query — the data-space-reconstructable walk inputs. */
export interface CutRequest {
  tree: "points" | "midpoints";
  viewbox: { minX: number; minY: number; maxX: number; maxY: number };
  canvasWidth: number;
  canvasHeight: number;
  splitThresholdFraction: number;
  gapDisclosurePx: number;
  /** selectionActive || doiNonUniform — the walk's only DoI-derived input. */
  focusActive: boolean;
}

export interface CutResponse {
  tree: string;
  candidates: CutCandidate[];
  /** Server DoI revision the candidates' `doiMass` was stamped under (issue
   * #315 A3 / P-d, plan §6e). Absent when no DoI state exists for the
   * (tree, fit) — the frame is then byte-identical to pre-A3. */
  doiRevision?: number;
  /** Server-computed non-uniformity bit (plan §6e; snake_case is the
   * deliberate frame-level asymmetry vs the select response's camelCase
   * `focusActive`). Absent when no DoI state exists. */
  focus_active?: boolean;
}

/**
 * One pushed frame on a viewport subscription (issue #315 Plan H): the
 * server-walked frontier for the freshest viewport the client streamed up.
 * `seq`/`key` echo the originating viewport push.
 *
 * Frames are deltas against the last pushed frontier unless `reset` is set,
 * in which case `enter` IS the whole frontier. The three-list split exists
 * because a candidate's payload is not uniformly viewport-stable: `hull`
 * and `bbox` are data-space and survive a zoom, while `insetPos` is derived
 * from the viewbox and changes constantly. So unchanged-but-moved
 * candidates take a cheap `move` patch instead of a full re-ship, and
 * anything whose stable half changed arrives in `enter` whole.
 */
export interface CutPushEvent {
  seq: number;
  tree: string;
  key: string;
  enter: CutCandidate[];
  leave: string[];
  /** [uid, x, y] inset-seed patches for candidates that only moved. */
  move?: Array<[string, number, number]>;
  reset?: boolean;
  /** Server-side timing attribution (issue #315 B1): mailbox dwell, walk,
   * and diff/emit durations in ms. Absent on older servers. */
  serverMs?: { wait: number; walk: number; emit: number };
  /** Server DoI revision the frame's candidate `doiMass` was stamped under
   * (issue #315 A3 / P-d, plan §6e). Absent when no DoI state exists. */
  doiRevision?: number;
  /** Server-computed non-uniformity bit (plan §6e; snake_case deliberate).
   * Absent when no DoI state exists — the client falls back to its scan. */
  focus_active?: boolean;
}

/**
 * A subset fit finished building (issue #315 P7 A1): `event: fit` on the
 * subscription. Announced to every live subscription on the TREE, not only to
 * ones already scoped to the fitId — the client that asked for the fit is
 * sitting on the BASE tree's stream showing coarse full-tree actives, and this
 * is how it learns it may adopt the fitted tree.
 */
export interface FitPushEvent {
  tree: string;
  /** 40-hex sha1 (P7 G7 — one fitId identity everywhere). */
  fitId: string;
  status: "ready" | "failed";
}

export interface CutSubscriptionHandlers {
  onCut: (event: CutPushEvent) => void;
  /** One pushed SELECT frame (issue #315 P7 S3): the answer lane's `event: sel`.
   * Optional — a subscriber that never pushes a `select` block never sees one. */
  onSelect?: (event: SelectPushEvent) => void;
  /** Registration-ack (issue #315 I3b): the boot re-ask was registered
   * without a re-push — adopt the skipped push's bookkeeping. Optional. */
  onSelectAck?: (event: SelectAckEvent) => void;
  /** A subset fit landed (issue #315 P7 A1). Optional. */
  onFit?: (event: FitPushEvent) => void;
  /** Stream failed or closed — the caller falls back to the pull path. */
  onDown: () => void;
}

/** Terminal state of an async subset fit as the client sees it (P7 A1). */
export type FitStatus = "building" | "ready" | "failed" | "unknown";

// ---------------------------------------------------------------------------
// Server-side score + select (issue #315 P7, plan-315-p7-server-select.md)
// ---------------------------------------------------------------------------

/**
 * The additive `select` block of a cut request (P7 §1.1). WIRE names — they
 * are `rl_trajectories/cluster_select.normalize_select`'s, deliberately NOT
 * the client's Redux field names (`stabilityWeight`, `maxActiveClusters`,
 * `hysteresisActivateFactor`, `grayOutDoiThreshold`, …).
 *
 * Presence of the block turns the cut into the ANSWER lane: the server walks,
 * scores, gates, and selects the ≤ `budget` winners and ships those instead of
 * the candidate flood. Absence ⇒ today's `CutResponse`, byte-identical.
 */
export interface SelectParams {
  /** Saliency weights (client: `stabilityWeight` … `doiDensityWeight`). */
  weights: { stability: number; doiMass: number; footprint: number; doiDensity: number };
  /** Min-area gate as a fraction of the split threshold. */
  labelMinFraction: number;
  /** Chain-rescue DoI-density gate. */
  chainDoiThreshold: number;
  /** True total cap (client: `maxActiveClusters`). */
  budget: number;
  /** Rescue slots reserved from WITHIN `budget`. */
  chainRescueBudget: number;
  /** Hysteresis factors (client: `hysteresis{Activate,Deactivate}Factor`). */
  hysteresis: { activate: number; deactivate: number };
  /** Visibility mask + annotation/inset split thresholds (client:
   * `visualizationSettings.{grayOut,annotation,inset}DoiThreshold`). */
  thresholds: { grayOut: number; annotation: number; inset: number };
  /**
   * Hysteresis echo — contract (b): the client ships the uid pools of its
   * current actives and the server runs the ported `HysteresisManager.update()`
   * statelessly. The split key is `SelectedActive.reserved` (WHICH POOL won the
   * slot), NOT `rescued` (eligibility) — plan §3b.1. An echoed uid the server
   * cannot resolve silently fails retention and self-heals in one frame.
   */
  actives: { main: string[]; rescue: string[] };
  /** Response encoding. "json" through S5; "sel1" once the binary lands (S6). */
  fmt?: "json" | "sel1";
  /** Rest vs gesture: an unsettled frame skips inset relaxation only. */
  settled?: boolean;
}

/** One winner of a server-side select — an ANSWER, not a candidate. */
export interface SelectedActive {
  /** DFS pre-order hex uid, the same vocabulary `CutCandidate.uid` uses. */
  uid: string;
  size: number;
  stability: number;
  /** The server's four-term weighted score for this frame. */
  saliency: number;
  /** Prefix-sum DoI mass over the server's own DoI vector (0 when the server
   * holds no DoI state for the frame's (tree, fit) — never NaN, plan §3b.3).
   * The select lane NEVER recomputes or compares this client-side, so the f32
   * coherence trap (plan §3b.6) cannot bite here. */
  doiMass: number;
  /** Masked VISIBLE-member mean DoI (fa509be3 rule) — the value behind
   * `group`; 0 when no DoI state. */
  visibleMeanDoi: number;
  /** Annotation/inset split, server-computed: 0 = neither, 1 = annotation,
   * 2 = inset. Replaces the client's masked-prefix classification pass. */
  group: 0 | 1 | 2;
  /** Rescue ELIGIBILITY (sub-min-area, chain-rescued by the whitespace gate). */
  rescued: boolean;
  /** Won a RESERVE slot — the echo pool key (plan §3b.1). A rescue-eligible
   * winner can hold a MAIN slot (rescue budget 0 / reserve full), so this is
   * not a synonym of `rescued`. */
  reserved: boolean;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  centroid: [number, number] | null;
  insetPos: [number, number] | null;
  leafRanges: Array<[number, number]>;
  hull?: Array<[number, number]> | null;
}

/** One server-selected frame (JSON encoding; SEL1 binary lands in S6). */
export interface SelectFrame {
  tree?: string;
  /** The ≤ budget winners in final display order (saliency desc, uid tie). */
  actives: SelectedActive[];
  /** K-th saliency — the hysteresis border (diagnostics). */
  borderScore: number;
  /** Nodes the walk popped (work attribution). */
  examined: number;
  /** The walk hit its examined cap — the honest-ledger bit. */
  clipped: boolean;
  /** The empty-score stability-only fallback ranking fired. */
  fallbackRanking: boolean;
  /** Server-owned DoI non-uniformity bit (the request's `focusActive` is the
   * rescue gate; the client ORs them — plan §3b.4). */
  focusActive: boolean;
  /** DoI revision the frame was selected under; null/absent = no DoI state. */
  doiRevision?: number | null;
  serverMs?: { score?: number; walk?: number; wait?: number };
  /** The walk was superseded and aborted — there is no frame to apply. */
  aborted?: boolean;
}

/** A cut request carrying the select block (P7 §1.1). */
export interface SelectCutRequest extends CutRequest {
  select: SelectParams;
  /** Boot registration re-ask (issue #315 ack fix, 2026-08-03): set ONLY
   * when the asker already HOLDS this key's frame (the adopted warm boot
   * stash) and re-asks purely to register its select question server-side —
   * the server may then answer with a bare `selAck` instead of re-walking.
   * A warm FIRST ask must never carry it: its whole purpose is to elicit
   * the frame, and acking it boots the session insetless. */
  registration?: boolean;
}

/**
 * One PUSHED select frame (issue #315 P7 S3, design-seam-first §1.3): the same
 * full frame the pull lane returns, plus the push envelope. Frames are
 * self-contained — the enter/leave/move delta protocol and the client cut mirror
 * do not exist on this lane (the hysteresis echo is the cross-frame memory).
 *
 * Seq contract (plan A2/A3): `seq` echoes the originating viewport push, EXCEPT
 * for a server-initiated re-select (`reselect` set), which re-answers the
 * subscription's CURRENT seq — the server cannot invent a newer one. Two frames
 * can therefore share a seq, and `subOrdinal` (monotonic per subscription) is
 * what orders them.
 */
export interface SelectPushEvent extends SelectFrame {
  seq: number;
  key: string;
  /** Monotonic push counter of the subscription that produced the frame. */
  subOrdinal: number;
  /** Set when the SERVER started this frame rather than a viewport push:
   * `"doi"` = a propagate committed, `"fit"` = a subset fit landed (A3). */
  reselect?: "doi" | "fit";
}

/**
 * Registration-ack (issue #315 insets-at-boot I3b): the server registered the
 * boot re-ask's select question — arming A3 reselects and content memory —
 * WITHOUT re-walking and re-pushing the identical frame the warmer already
 * answered. `seq` echoes the registration push; no frame accompanies it, so
 * the subscription's push ordinal does not advance. Older servers never send
 * it (the client's `sel:bootDup` suppression remains the fallback), and older
 * clients ignore the unknown SSE event.
 */
export interface SelectAckEvent {
  seq: number;
  key: string;
  tree?: string;
  /** The subscription's CURRENT push ordinal at ack time (diagnostics). */
  subOrdinal: number;
}

/** Server DoI propagation request params (issue #315 A3 / P-d): the wire
 * names of `/v1/select`'s `propagate` block (plan-315-a3-server-doi.md §6a).
 * NOT the client's internal `proximitySlider/…` names. */
export interface PropagateParams {
  proximity: number;
  past: number;
  future: number;
  maxEmbeddingDistance: number;
  /** Embedding-k for the GRAPH engine (T4); ignored on the field path. */
  k: number;
  thresholds: { grayOut: number; annotation: number; inset: number };
  /** Field-first v2 (§8): a field shape routes the server to the field
   * engine; absent or "hop" keeps the v1 graph engine byte-identical. */
  falloff?: {
    shape: "exp" | "linear" | "gauss" | "log" | "plateau" | "hop";
  };
}

/** The three propagate request shapes (§6a): a lasso polygon, explicit
 * RECORD-index seeds (feature search), or a retained-revision re-propagate
 * (slider commit). */
export type PropagateSeeds =
  | { polygon: Array<[number, number]> }
  | { ids: number[] }
  | { revision: number };

/** Sparse leaf-order DoI overlay (§6b): nonzero DoI only over the reached
 * set; unreached points hold base 0 and are never shipped. */
export interface DoiOverlay {
  /** Server-global monotonic revision of this DoI state. */
  revision: number;
  /** Server-computed non-uniformity bit (max−min > 1e-6 on f32). */
  focusActive: boolean;
  /** Leaf-order [start, length] runs where DoI > 0. */
  runs: Array<[number, number]>;
  /** f32 DoI values concatenated in leaf order, aligned run-by-run. */
  values: Float32Array;
  /** Half-open leaf ranges with DoI ≥ annotation threshold — the F2 fit
   * vocabulary (`subsetLeafRanges`-compatible). */
  visibleRanges: Array<[number, number]>;
  /** Set when an empty-seed selection cleared the retained state. */
  cleared?: boolean;
}

export interface PropagateResult {
  overlay: DoiOverlay;
  /** The polygon selection's leaf ranges (shape 1); [] for ids/revision. */
  ranges: Array<[number, number]>;
  /** Shape 1: selection size; shapes 2/3: seed count. */
  n: number;
}

/**
 * The server edition's hierarchy-cut transport (issue #315 S2). Resolved per
 * dataset from `backend.capabilities` containing `"cut"`; `null` everywhere
 * else — and always in the open-core stub, where the client-side walk over
 * the shipped trees remains the one and only path.
 */
export interface ClusterCutProvider {
  readonly manifest: BackendManifest;
  /** Fitted-subset scope (issue #315 F2c): set on providers returned by
   * `withFit` — every request/key/subscription this provider makes is
   * routed to the fitted tree. Undefined = the full base tree. */
  readonly fit?: string;
  /** Coalescing/cache key of a cut request (quantized inputs). A request
   * carrying a `select` block additionally folds in a hash of the select
   * SCALARS — never the echo, which must not fragment the key (P7 §6.2). */
  cutKey(request: CutRequest | SelectCutRequest): string;
  getCut(request: CutRequest): Promise<CutResponse>;
  /**
   * Server-side score + select (issue #315 P7, optional): one POST returns the
   * ≤ budget ANSWERS for the request's viewport instead of the candidate
   * flood. Present only on providers whose manifest advertises the
   * `"select-cut"` capability; absent ⇒ callers keep the candidates lane +
   * client scoring, byte-identical (the permanent fallback).
   */
  selectCut?(request: SelectCutRequest): Promise<SelectFrame>;
  /** Boot-once: leaf position → point index permutation for a tree (the
   * FITTED tree's, composed to original point indices, when fit-scoped).
   *
   * TYPED (issue #315 P7 S6a): the wire payload is already little-endian
   * u32, so the view over the response buffer IS the answer — the previous
   * `Array.from(...)` box cost ~1.1 s per 1M-leaf decode and re-ran on every
   * cut re-init. Every consumer indexes it identically. */
  getLeafOrder(tree: CutRequest["tree"]): Promise<Uint32Array>;
  /** Subset fit (issue #315 F2c, optional): cluster `ranges` (half-open,
   * over the FULL tree's leaf order) server-side. The returned fitId
   * addresses the fitted tree via `withFit`.
   *
   * ASYNC since P7 A1: the content-addressed fitId comes back immediately
   * with `status: "building"` and the fitted tree only answers cut /
   * leaforder / subscribe once it is `"ready"` (409 until then). A re-fit of
   * the same selection is a cache hit and answers `"ready"` at once.
   * `status` absent = a pre-A1 server, i.e. the fit already ran. */
  fitSubset?(
    tree: CutRequest["tree"],
    ranges: Array<[number, number]>,
    minSamples?: number
  ): Promise<{ fitId: string; n: number; status?: FitStatus }>;
  /** Block until an async subset fit settles (issue #315 P7 A1). Resolves
   * `"ready"` / `"failed"`, or `"unknown"` when the fitId was evicted or the
   * wait timed out (the caller keeps its coarse cut either way). Implemented
   * as the SSE `event: fit` raced against bounded polling, so it works on the
   * pull lane too. */
  awaitFit?(
    tree: CutRequest["tree"],
    fitId: string,
    timeoutMs?: number
  ): Promise<FitStatus>;
  /** A provider scoped to a fitted subset (same backend, fitId-routed). */
  withFit?(fitId: string): ClusterCutProvider;
  /** Boot select frame (issue #315 insets-at-boot I1, optional): the boot
   * warmer's subscription already received the full boot-viewport answer
   * while the dataset was downloading. `initServerCut` takes it ONCE and
   * adopts it as the seq-0 stash — the live subscription's first real frame
   * (seq ≥ 1) supersedes it under the normal drop rules. Null when no warm
   * frame arrived, it was already taken, or the provider is fit-scoped. */
  takeBootSelectFrame?(tree: CutRequest["tree"]): SelectPushEvent | null;
  /** Server-side lasso hit-test (issue #315 A2, optional): data-space
   * polygon → half-open ranges over the tree's leaf order. Stateless —
   * ranges ARE the selection; the client expands them via getLeafOrder. */
  select?(
    tree: CutRequest["tree"],
    polygon: Array<[number, number]>
  ): Promise<{ ranges: Array<[number, number]>; n: number }>;
  /** Fused select + server DoI propagation (issue #315 A3 / P-d, optional):
   * one POST resolves the seeds (polygon / record ids / retained revision)
   * AND propagates server-side, returning the sparse leaf-order overlay.
   * A 409 (superseded or unknown revision) rejects with `status: 409` on
   * the error — revision-reuse callers re-seed via ids. */
  selectPropagate?(
    tree: CutRequest["tree"],
    seeds: PropagateSeeds,
    params: PropagateParams
  ): Promise<PropagateResult>;
  /** Field-path propagate (issue #315 field-first v2): fmt=bin request,
   * DST1 distance-field response decoded to raw bytes for the client's
   * local falloff remap. Requires params.falloff to be a field shape. */
  selectPropagateField?(
    tree: CutRequest["tree"],
    seeds: PropagateSeeds,
    params: PropagateParams
  ): Promise<ArrayBuffer>;
  cancel(key: string): void;
  /**
   * Viewport subscription (issue #315 Plan H) — optional capabilities; a
   * provider without them (or an old server) keeps the pull path. Opening a
   * subscription for a tree replaces any previous one for the same backend
   * dataset + tree (one clustering service per tree is current at a time).
   */
  subscribe?(
    tree: CutRequest["tree"],
    handlers: CutSubscriptionHandlers
  ): () => void;
  /** Fire-and-forget: stream the freshest viewport up; the walked frontier
   * arrives as a `cut` event on the subscription — or, when the request carries
   * a `select` block (issue #315 P7 S3), the ≤ budget answer arrives as a `sel`
   * event. `wantReset` asks for a full frame because the caller's mirror is
   * untrustworthy (candidate lane only; select frames are always full). Returns
   * false when no live subscription exists — the caller should pull instead. */
  pushViewport?(
    request: CutRequest | SelectCutRequest,
    seq: number,
    key: string,
    wantReset: boolean
  ): boolean;
  /** One bounded liveness probe (issue #315 §8.8d): resolves false when the
   * backend is unreachable. Used after a stream loss to decide whether the
   * LOUD server-loss warning should show immediately, instead of waiting for
   * the next interaction's fetch to fail. */
  probeHealth?(): Promise<boolean>;
}

/**
 * Resolve the cut provider for a dataset's backend section. Returns `null`
 * unless the manifest is valid AND advertises the `"cut"` capability (the
 * first consumer of `BackendManifest.capabilities`).
 */
export type ResolveCutProvider = (
  manifest: BackendManifest | null | undefined
) => ClusterCutProvider | null;

/**
 * Resolve the inset-content provider for a dataset's backend section. Returns
 * `null` when no backend is declared (or in the open-core stub build), which
 * signals consumers to use the existing fully-client-side inset path.
 */
export type ResolveInsetProvider = (
  manifest: BackendManifest | null | undefined
) => InsetContentProvider | null;

// ---------------------------------------------------------------------------
// Deferred-column fetch (issue #315 R3b/R3c, plan §6.1)
// ---------------------------------------------------------------------------

/**
 * Transport for POST /v1/columns: whole-column fetches of the columns an
 * endgame manifest deferred (names/types without bytes). Kept structural —
 * the result is the columnSidecar `PointColumns` shape (`count` + decoded
 * arrays under `byName`), which `lazyColumns.ensureResidentColumns` attaches
 * into the registered sidecar.
 */
export interface ColumnsProvider {
  fetchColumns(names: string[]): Promise<{
    count: number;
    byName: Record<string, ArrayLike<unknown>>;
  }>;
  /** One bounded reachability probe (issue #315 §8.8d): false ONLY when the
   * server cannot be reached at all (network error / timeout — any HTTP
   * answer counts as reachable). The loader gates the deferred-columns lane
   * on it: an unreachable server at boot fails the sidecar path over to the
   * fat JSON chunks — the "reload for the client-only version" the banner
   * promises. */
  probeHealth?(): Promise<boolean>;
}

/**
 * Resolve the deferred-columns provider for a dataset's backend section.
 * Returns `null` unless the manifest is valid AND advertises the
 * `"columns"` capability; always `null` in the open-core stub build, whose
 * fat manifests never declare deferred columns.
 */
export type ResolveColumnsProvider = (
  manifest: BackendManifest | null | undefined
) => ColumnsProvider | null;

// ---------------------------------------------------------------------------
// Server-rendered scatterplot tiles (issue #315 phase E)
// ---------------------------------------------------------------------------

/** Pyramid metadata the server advertises under `health.tiles`. */
export interface TileMeta {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  tilePx: number;
  maxZoom: number;
  classCount: number;
  /** Column the tiles were colored by at prep time (the /health `tiles`
   * section carries it; optional so a source predating it keeps drawing).
   * The renderer drops to raw geometry when the client's colorEncoding
   * differs — pre-rendered imagery cannot represent any other encoding. */
  colorColumn?: string;
}

/**
 * A source of scatterplot raster tiles: tile (z, x, y) covers cell (x, y) of
 * the 2^z x 2^z grid over the data bbox, row 0 at the TOP. `getTile` resolves
 * to null on failure (the layer just leaves the cell empty and retries on a
 * later settle).
 */
export interface ScatterTileSource {
  readonly meta: TileMeta;
  getTile(z: number, x: number, y: number): Promise<ImageBitmap | null>;
}

/**
 * Resolve the tile source for a dataset's backend section (async — reads the
 * service's health for the pyramid meta). Null when no backend, no "tiles"
 * capability, unreachable service, or in the open-core stub build.
 */
export type ResolveTileSource = (
  manifest: BackendManifest | null | undefined
) => Promise<ScatterTileSource | null>;

// ---------------------------------------------------------------------------
// Per-level weighted-point aggregates (issue #315 plan G, G2/G3)
// ---------------------------------------------------------------------------

/** Pyramid metadata the server advertises under `health.aggregates`. */
export interface AggregateMeta {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  binsPerTile: number;
  maxLevel: number;
  colorColumn: string;
  /** Ordered class-id → column VALUE table; the client maps these through
   * its own colorScale so aggregate colors equal raw-geometry colors. */
  classes: (string | number)[];
  /** Total raw points in the dataset — the service's top-level /health
   * `points` count, stitched in by the client resolver (issue #315 G4:
   * density-adaptive sizing input before any raw geometry has loaded). */
  pointCount?: number;
}

/** One decoded AGG1 tile: columnar weighted points (centroid, count, class). */
export interface AggregateTile {
  count: number;
  xs: Float32Array;
  ys: Float32Array;
  weights: Uint32Array;
  classes: Uint16Array;
}

/**
 * A source of weighted-point aggregate tiles (GET /v1/aggregates): tile
 * (level, x, y) covers cell (x, y) of the 2^level x 2^level grid over the
 * data bbox, row 0 at the TOP (same addressing as ScatterTileSource).
 * `getTile` resolves to a count-0 tile for empty cells (404) and to null on
 * transient failure (503 while precomputing, network) — the layer retries
 * on a later settle.
 */
export interface AggregateTileSource {
  readonly meta: AggregateMeta;
  getTile(level: number, x: number, y: number): Promise<AggregateTile | null>;
}

/**
 * Resolve the aggregate source for a dataset's backend section (async —
 * reads the service's health for the `aggregates` meta). Null when no
 * backend, no aggregates meta, unreachable service, or in the open-core
 * stub build.
 */
export type ResolveAggregateSource = (
  manifest: BackendManifest | null | undefined
) => Promise<AggregateTileSource | null>;

/** Build a MemberRef from any object carrying `id`/`line` (e.g. a DataPoint). */
export function toMemberRef(point: { id: number; line: number }): MemberRef {
  return { id: point.id, line: point.line };
}

/**
 * Order-independent identity key for a member (matches `reconcileClusterItems`
 * `sampleKey`), used to build cluster signatures for coalescing and caching.
 */
export function memberRefKey(ref: MemberRef): string {
  const idPart = Number.isFinite(ref.id) ? String(ref.id) : "na";
  const linePart = Number.isFinite(ref.line) ? String(ref.line) : "na";
  return `${idPart}:${linePart}`;
}
