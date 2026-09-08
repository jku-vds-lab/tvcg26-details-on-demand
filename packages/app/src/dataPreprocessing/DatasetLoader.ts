import { resolveColumnsProvider, resolveCutProvider, scalingBuildHasBackends } from "@scaling";
import { warnServerLoss } from "../utils/serverLoss";
import type { BackendManifest } from "../scaling.types";
import type { Dataset } from "../types/datasetTypes";
import { markDatasetLoadPhase } from "../utils/datasetLoadInstrumentation";
import { completeTask, failTask, startTask, updateTask } from "../utils/progressApi";
import { makeJsonWorker } from "../workers/makeJsonWorker";
import { makeSplineWorker } from "../workers/makeSplineWorker";
import type { SplineWorkerResponse } from "../workers/spline.worker";
import {
    decodeColumns,
    markIdsValidated,
    materializeRecords,
    registerSidecarColumns,
    type DataColumnsSection,
    type PointColumns,
} from "./columnSidecar";
import { isFeatureStatsPayload, registerStaticFeatureStats } from "./featureStatsClient";
import {
  parseStaticBootFrame,
  registerStaticBootFrame,
} from "../semanticZoom/staticBootFrame";
import {
    clearLazyRowArray,
    clientLazyBootEnabled,
    createLazyRowArray,
    rowLazyBootEnabled,
} from "./lazyRows";
import {
    clearDeferredColumns,
    deferColumnsEnabled,
    ensureResidentColumns,
    registerDeferredColumns,
    type DeferredColumnEntry,
} from "./lazyColumns";
import { columnsFromSidecar, createColumnBackedRowFactory } from "./pointColumns";
import type { DataPoint } from "./dataPreprocessing";
import {
    PrecomputedSegment,
    PrecomputedTrajectoryMidpoint,
} from "./dataPreprocessing";
import { DownloadJob } from "./DownloadJob";
import { JSONLoader } from "./JSONLoader";
import { attachPixelViews, type PixelViewMeta } from "./pixelGrid";
import {
    attachSegmentPointState,
    compactSegmentColumns,
    splineColumnSegmentCount,
    splineInputColumns,
    type SplineColumns,
} from "./splineColumns";

const DBG = (...args: unknown[]) => console.log("[DatasetLoader]", ...args);

// Deduplicate in-flight loads
const inflightLoads = new Map<string, Promise<Dataset>>();

interface ChunkMeta { path: string; count: number }

interface LoadDatasetAutoOptions {
  signal?: AbortSignal;
  parentTaskId?: string;
  /** Boot columns-direct paint hook (issue #315 B1): fired with the decoded
   * sidecar columns BEFORE row materialization starts, so a live renderer can
   * upload and draw real points while the DataPoint[] pipeline still runs.
   * Best-effort — a throwing callback never fails the load. */
  onPointColumns?: (cols: PointColumns) => void;
}

const HYDRATE_SEGMENT_BATCH = 24000;
const KEEP_PRECOMPUTED_EXPORT_LIMIT = 250000;

/**
 * Whether this manifest's rows may stay lazy (issue #315 R1b, row contract
 * §3.5; client variant R3d, plan §6.1). Shared preconditions, each a lane the
 * seam is not designed to serve:
 *
 *  - prep-validated ids — otherwise `ensurePointsInitializedInPlace` runs its
 *    two O(N) id-scan loops over the rows at mount.
 *  - no pixel artifact — `attachPixelViews` writes per-row pixel views.
 *  - the kill switch is not off (`window.__rowLazyBoot = false`, plan §7).
 *
 * Then either lane qualifies:
 *
 *  - `resolveCutProvider` answers — the SERVER cut lane, the one R1a made
 *    walk-free.
 *  - a static bootFrame is declared (issue #315 R3d) — the first inset mounts
 *    from the artifact, so row MATERIALIZATION defers until after it (the
 *    parked R2c window); `window.__clientLazyBoot = false` is this lane's own
 *    A/B lever. This amends §3.5's "no cut provider ⇒ no lazy anything": the
 *    public build's rows may now stay lazy too — its boot-order row consumers
 *    are columnar or residency-gated (plan §6.1 R3d), and `/v1/` stays out of
 *    the bundle because laziness never touches the provider registry.
 */
export function rowsMayStayLazy(manifest: ManifestV1): boolean {
  if (!rowLazyBootEnabled()) return false;
  if (!manifest.dataColumns?.idsValidated) return false;
  if (manifest.pixels?.file) return false;
  if (resolveCutProvider(manifest.backend ?? null)) return true;
  return clientLazyBootEnabled() && Boolean(manifest.bootSelectFrame?.file);
}

/**
 * Derive trajectory spline geometry from the already-loaded points (issue
 * #315): Catmull-Rom math runs in a worker over transferred point columns,
 * the returned columns are materialized onto the DataPoints' adjacency lists
 * in the same chunked cadence the downloaded-segment hydration used. The
 * splines are a pure function of point x/y + line ordering, so nothing is
 * lost versus the (much larger) precomputed download.
 */
async function computeSplineColumnsInWorker(
  data: DataPoint[],
  signal?: AbortSignal,
  sidecar?: PointColumns
): Promise<SplineColumns> {
  // Columnar worker input on the sidecar lane (issue #315 R1a, A1).
  const { x, y, line } = splineInputColumns(data, sidecar);

  return new Promise<SplineColumns>((resolve, reject) => {
    throwIfAborted(signal);
    const w = makeSplineWorker();
    const finish = (fn: () => void) => {
      signal?.removeEventListener("abort", onAbort);
      w.terminate();
      fn();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException("Dataset load aborted", "AbortError")));
    signal?.addEventListener("abort", onAbort);

    w.onmessage = (e: MessageEvent<SplineWorkerResponse>) => {
      const msg = e.data;
      if (msg.ok) {
        finish(() => resolve(msg.columns));
      } else {
        finish(() => reject(new Error(msg.error || "Spline worker failed")));
      }
    };
    w.onerror = (err) => finish(() => reject(err));

    w.postMessage({ x: x.buffer, y: y.buffer, line: line.buffer, edgesOnly: true }, [
      x.buffer,
      y.buffer,
      line.buffer,
    ]);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Dataset load aborted", "AbortError");
  }
}

/**
 * Resolve a manifest-relative asset path (chunk, tile) against the manifest's
 * own URL. Absolute urls pass through untouched.
 *
 * Exported because the server-build segment tile client resolves tile paths the same
 * way chunks are resolved, and two implementations of this would drift.
 */
export function joinUrl(manifestPath: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  const baseDir = manifestPath.replace(/[^/?#]+([?#].*)?$/, "");
  return new URL(rel, new URL(baseDir, window.location.href)).toString();
}

async function processChunksWithPrefetch<T>(
  chunks: ChunkMeta[],
  manifestPath: string,
  signal: AbortSignal | undefined,
  onChunk: (arr: T[], chunk: ChunkMeta, idx: number) => Promise<void> | void,
  opts?: DownloadJsonOptions
): Promise<void> {
  if (chunks.length === 0) return;

  let nextPromise: Promise<T[]> | null = null;
  const startDownload = (idx: number) =>
    downloadJson<T[]>(joinUrl(manifestPath, chunks[idx].path), undefined, signal, opts);

  nextPromise = startDownload(0);

  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    const currentPromise = nextPromise;
    if (!currentPromise) break;

    if (i + 1 < chunks.length) {
      nextPromise = startDownload(i + 1);
    } else {
      nextPromise = null;
    }

    const arr = await currentPromise;
    throwIfAborted(signal);
    await onChunk(arr, chunks[i], i);
  }
}

export interface DownloadJsonOptions {
  /** Strip inlined pixel grids in the parse worker (see jsonParse.worker.ts). */
  pixelExtract?: boolean;
}

export function downloadJson<T = unknown>(
  url: string,
  onProgress?: (progress: number | null) => void,
  signal?: AbortSignal,
  opts?: DownloadJsonOptions
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    throwIfAborted(signal);
    const job = new DownloadJob({ path: url, type: "json" }, signal);

    void job.start(
      // onFinishText → CSV or JSON fallback when we didn't use the bytes path
      (resultText: string) => {
        try {
          const obj = JSON.parse(resultText) as T;
          resolve(obj);
        } catch (e) {
          reject(e);
        }
      },

      // onProgress → forward to caller (determinate or indeterminate)
      (p: number | null) => {
        if (signal?.aborted) return;
        if (onProgress) onProgress(p);
      },

      // onFinishBytes → preferred path for JSON: parse in a worker
      async ({ bytes, needsClientGzip }: { bytes: Uint8Array; needsClientGzip: boolean }) => {
        try {
          throwIfAborted(signal);
          const w = makeJsonWorker();

          w.onmessage = (
            e: MessageEvent<{ ok?: boolean; parsed?: unknown; text?: string; error?: string; pixels?: PixelViewMeta }>
          ) => {
            const { ok, parsed, text, error, pixels } = e.data || {};
            try {
              throwIfAborted(signal);
              if (!ok) throw new Error(error || "Worker parse failed");

              if (typeof text === "string") {
                // Worker returned a UTF-8 JSON string
                resolve(JSON.parse(text) as T);
              } else {
                // Worker returned a parsed JS object; rehydrate zero-copy
                // pixel views when the worker stripped a pixel grid.
                if (pixels && Array.isArray(parsed)) {
                  attachPixelViews(parsed, pixels);
                }
                resolve(parsed as T);
              }
            } catch (err) {
              reject(err);
            } finally {
              // Always release the worker
              w.terminate();
            }
          };

          w.onerror = (err) => {
            w.terminate();
            reject(err);
          };

          // Transfer the buffer for zero-copy; worker handles optional gzip.
          // With pixelExtract, image data chunks come back as slim points +
          // one transferable pixel buffer instead of a multi-MB JSON string
          // that froze the main thread when re-parsed here. All other
          // payloads keep the legacy text path (structured clone would
          // stack-overflow on deep HDBSCAN trees).
          w.postMessage(
            {
              kind: "parseBytes",
              bytes: bytes.buffer as ArrayBuffer,
              needsGzip: needsClientGzip,
              returnText: true,
              pixelExtract: !!opts?.pixelExtract,
            },
            [bytes.buffer]
          );
        } catch (err) {
          reject(err);
        }
      }
    ).catch(reject);
  });
}

export interface ManifestV1 {
  format: "multipart-dataset-v1";
  datasetType: string;
  data: { chunks: ChunkMeta[] };
  /** Binary column sidecar (issue #315 phase E-a): when present, point data
   * loads from `columns.bin` typed columns instead of the JSON chunks —
   * no 17 MB parse at 1M. JSON chunks stay declared as the fallback. */
  dataColumns?: DataColumnsSection | null;
  /** Deferred columns (issue #315 R3a, plan §6.1): an endgame manifest keeps
   * only the boot-critical columns in `columns.bin` and declares the rest
   * here — names and types WITHOUT bytes, fetched on demand through POST
   * /v1/columns (lazyColumns.ensureResidentColumns). Requires the backend
   * section to advertise the `"columns"` capability; ignored without it. */
  deferredColumns?: { columns: DeferredColumnEntry[] } | null;
  /** Optional since issue #315 A3/P-b: server-cut datasets may omit the
   * neighbor graph entirely (the 13 MB payload exists only for client DoI
   * propagation). Absence ⇒ zero chunks; propagation degrades to the
   * trajectory-only terms (`propagateDoI` tolerates empty rows). */
  knnGraph?: { chunks: ChunkMeta[] } | null;
  /** Static feature-stats artifact (issue #315 B2): client-complete datasets
   * ship the `/v1/feature-stats`-shaped payload as a JSON file so the boot
   * skips the 20k-row client scan on every lane, not just server-backed. */
  featureStats?: { file: string } | null;
  /** Prep-time pixel-grid artifact (issue #315 B3): image datasets (mnist,
   * fashion, cctv) ship the canonical pixel buffer their inlined `"{a}x{b}"`
   * JSON keys would have been extracted into (pixelGrid.ts order), so the
   * sidecar lane keeps working image insets without the JSON chunks. Only
   * read on the dataColumns lane — a fetch failure fails the sidecar path
   * (rows without pixels would silently break the insets). */
  pixels?: { file: string; width: number; height: number; kind: "u8" | "f32" } | null;
  /** Static boot select-frame artifact (issue #315 insets-at-boot I3):
   * client-complete datasets ship the settled boot-viewport select frame
   * (generate_boot_select_frames.py) so insets mount before the first local
   * scoring pass. Fetched fire-and-forget, never awaited on the critical
   * path; absent or failed ⇒ boot exactly as today (degrade, never block). */
  bootSelectFrame?: { file: string } | null;
  hdbscan?: { path: string } | null;
  midpointHdbscan?: { path: string } | null;
  /** Declared segment chunks are no longer downloaded — geometry is derived
   * client-side from the points (issue #315). The field's presence still
   * marks the dataset as carrying trajectory geometry. */
  segments?: { chunks: ChunkMeta[] } | null;
  trajectoryMidpoints?: { chunks: ChunkMeta[] } | null;
  /** On-demand render service info for gymnasium datasets (render insets). */
  render?: { envId?: string; endpoint?: string } | null;
  /** Optional on-demand inset/tile backend (issue #315); ignored when absent. */
  backend?: BackendManifest | null;
  /** DEPRECATED (issue #315 phase 4b, removed): the offline segment pyramid.
   * Kept only as a trajectory-geometry marker for manifests authored during
   * 4b — never read beyond its presence. */
  segmentTiles?: unknown;
}

export async function fetchManifest(
  path: string,
  onProgress?: (progress: number | null) => void,
  signal?: AbortSignal
): Promise<ManifestV1> {
  const m = await downloadJson<ManifestV1>(path, onProgress, signal);
  if (m.format !== "multipart-dataset-v1") {
    throw new Error(`Unknown dataset format: ${(m as { format?: unknown }).format}`);
  }
  return m;
}

// --- type inference for legacy datasets ---
function inferDatasetTypeFromData(data: unknown[]): string | undefined {
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const sample = data[0];
  if (typeof sample !== "object" || sample === null) return undefined;
  if ("opening_name" in sample || "a1" in sample) return "chess";
  if ("cube_state" in sample || "rubik_facelets" in sample) return "rubik";
  if ("trajectory" in sample && "midpoints" in sample) return "trajectories";
  return undefined;
}

export function loadDatasetAuto(path: string, options: LoadDatasetAutoOptions = {}): Promise<Dataset> {
  const { signal, parentTaskId, onPointColumns } = options;
  throwIfAborted(signal);
  const existing = parentTaskId ? undefined : inflightLoads.get(path);
  if (existing) {
    DBG("loadDatasetAuto:dedupeInFlight", path);
    return existing;
  }

  const p = (async (): Promise<Dataset> => {
    throwIfAborted(signal);
    if (/\.json\.gz($|\?)/.test(path)) {
      const parsed = await downloadJson<unknown>(path, undefined, signal);
      throwIfAborted(signal);
      if (parsed && typeof parsed === "object" && (parsed as ManifestV1).format === "multipart-dataset-v1") {
        return loadDatasetFromManifestObject(
          parsed as ManifestV1,
          path,
          parentTaskId ?? `dataset:${path}`,
          signal,
          onPointColumns
        );
      }

      // Legacy JSON
      return await new Promise<Dataset>((resolve, reject) => {
        try {
          new JSONLoader().resolveParsed(
            parsed,
            (dataset: Dataset) => {
              if (!dataset.datasetType) {
                dataset.datasetType = inferDatasetTypeFromData(dataset.data) ?? "default";
                DBG("type:inferred", { datasetType: dataset.datasetType });
              }
              dataset.datasetType = dataset.datasetType.toLowerCase();
              resolve(dataset);
            },
            (phase: unknown) => {
              DBG("loadDatasetAuto:legacyPhase", path, phase);
            }
          );
        } catch (err) {
          reject(err);
        }
      });
    }

    // Manifest
    const parentId = parentTaskId ?? `dataset:${path}`;
    const manifestTaskId = `${parentId}:manifest`;
    startTask({
      id: manifestTaskId,
      label: "Loading dataset",
      parentId,
      phase: "Fetching manifest…",
      kind: "io",
      value: 0,
    });
    let manifest: ManifestV1;
    try {
      manifest = await fetchManifest(path, (p) => {
        if (signal?.aborted) return;
        if (p === null) {
          updateTask({ id: manifestTaskId, progressMode: "indeterminate" });
        } else {
          updateTask({
            id: manifestTaskId,
            value: Math.min(99, p),
            progressMode: undefined,
          });
        }
      }, signal);
      throwIfAborted(signal);
      completeTask(manifestTaskId);
    } catch (err) {
      if (signal?.aborted) {
        failTask(manifestTaskId, "Cancelled");
        throw err;
      }
      failTask(manifestTaskId, "Failed to fetch manifest");
      throw err;
    }

    const ds = await loadDatasetFromManifestObject(manifest, path, parentId, signal, onPointColumns);
    ds.datasetType = ds.datasetType?.toLowerCase?.() ?? "default";
    return ds;
  })();

  inflightLoads.set(path, p);
  p.finally(() => inflightLoads.delete(path));
  return p;
}

export async function loadDatasetFromManifestObject(
  manifest: ManifestV1,
  manifestPath: string,
  parentId: string,
  signal?: AbortSignal,
  onPointColumns?: (cols: PointColumns) => void
): Promise<Dataset> {
  // Backend reachability gate (issue #315 §8.8d, 2026-08-05): a declared
  // backend whose server is unreachable at load must not be adopted — the
  // cut provider would hang the boot clustering on a dead host (observed:
  // fat-chunk rows loaded fine, then `cut:leaforder` waited forever and no
  // inset ever mounted). One bounded /health probe; on failure the whole
  // load proceeds as if the manifest were serverless (classic client lanes,
  // shipped hierarchies, fat chunks), which IS the "client-only version"
  // the server-loss banner promises a reload delivers. LOUD on backend-
  // capable builds; the open-core stub resolves no provider and falls
  // through silently (there is no server story to have lost).
  if (manifest.backend) {
    const probeProvider =
      resolveColumnsProvider(manifest.backend) ?? resolveCutProvider(manifest.backend);
    const alive = probeProvider ? ((await probeProvider.probeHealth?.()) ?? true) : false;
    throwIfAborted(signal);
    if (!alive) {
      if (probeProvider) warnServerLoss();
      manifest = { ...manifest, backend: undefined };
    }
  }
  // Treeless boot on cut-served datasets (issue #315 merge gate): a LIVE cut
  // provider drives the boot clustering, so the shipped hierarchy JSONs are
  // dead transfer (chess40k: 4.8 MB). Keyed on the POST-probe manifest — a
  // dead backend was stripped above, restoring the client-complete fetch,
  // and the open-core stub resolves null, so the public build always
  // fetches. The `manifest.backend` guard is load-bearing: with no argument
  // resolveCutProvider falls back to the PREVIOUS dataset's active backend.
  const cutSupersedesHierarchy =
    manifest.backend != null && resolveCutProvider(manifest.backend) !== null;
  const startCategory = (
    id: string,
    label: string,
    total: number,
    phaseBase: string
  ) => {
    startTask({
      id,
      label,
      parentId,
      kind: "io",
      phase: `${phaseBase} (0/${total})…`,
      value: 0,
    });
  };
  const updateCategory = (
    id: string,
    label: string,
    done: number,
    total: number,
    phaseBase: string
  ) => {
    updateTask({
      id,
      label,
      value: (done / total) * 100,
      phase: `${phaseBase} (${done}/${total})…`,
    });
  };

  const finishCategory = (id: string) => completeTask(id);

  // Static feature-stats artifact (issue #315 B2): fired in parallel with
  // the data download, awaited (it is a few-kB JSON) before the dataset is
  // returned so the feature-analysis pass finds it registered. Any failure
  // simply leaves the registry empty — the scan lane is the fallback.
  const staticFeatureStatsPromise: Promise<unknown | null> = manifest.featureStats?.file
    ? fetch(joinUrl(manifestPath, manifest.featureStats.file), { signal })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null)
    : Promise.resolve(null);

  // Serial loader tail hoisted to manifest-parse time (issue #315 R2a): the
  // clustering JSONs and the midpoint export cache have zero data dependency
  // on the point download, yet were awaited serially after materialization.
  // Fired here, joined immediately before the `Dataset` literal below. The
  // return contract is unchanged on purpose — parallelize the fetch, not the
  // contract: `dataset.hdbscan` must be resolved at return, or
  // `useInitialClustering`'s precomputed gate never trips and the boot falls
  // onto the worker-fit path (wrong tree uids, the static bootFrame never
  // armed).
  const hdbscanPromise: Promise<Dataset["hdbscan"] | undefined> = (async () => {
    if (cutSupersedesHierarchy || !manifest.hdbscan?.path) return undefined;
    const id = `${parentId}:hdbscan`;
    startTask({
      id,
      label: "Loading dataset",
      parentId,
      kind: "io",
      phase: "Loading clustering…",
      value: 0,
    });
    try {
      const result = await downloadJson<Dataset["hdbscan"]>(
        joinUrl(manifestPath, manifest.hdbscan.path),
        undefined,
        signal
      );
      updateTask({ id, value: 100 });
      completeTask(id);
      return result;
    } catch (err) {
      failTask(id, "Failed to load clustering");
      throw err;
    }
  })();

  const midpointHdbscanPromise: Promise<Dataset["midpointHdbscan"] | undefined> = (async () => {
    if (cutSupersedesHierarchy || !manifest.midpointHdbscan?.path) return undefined;
    const id = `${parentId}:midpointHdbscan`;
    startTask({
      id,
      label: "Loading dataset",
      parentId,
      kind: "io",
      phase: "Loading clustering…",
      value: 0,
    });
    try {
      const result = await downloadJson<Dataset["midpointHdbscan"]>(
        joinUrl(manifestPath, manifest.midpointHdbscan.path),
        undefined,
        signal
      );
      updateTask({ id, value: 100 });
      completeTask(id);
      return result;
    } catch (err) {
      failTask(id, "Failed to load clustering");
      throw err;
    }
  })();

  // Midpoint chunks are an export-only cache (runtime midpoints are derived
  // from points): above the export limit the download's rows were DISCARDED
  // — ~15 MB of dead boot transfer at 1M (issue #315). Skip it entirely.
  // Off the critical path since R3a (issue #315 plan §6.1): the array
  // instance lands in the Dataset immediately and fills in the BACKGROUND
  // (the knn pattern) — audited 2026-08-04: the manifest lane has no
  // runtime consumer of this cache (usePrepareDatasetRefs derives its own
  // midpoints from columns), so nothing can observe the fill racing boot.
  const mpChunks = manifest.trajectoryMidpoints?.chunks ?? [];
  const mpKeepCount = mpChunks.reduce((acc, c) => acc + (c.count ?? 0), 0);
  const mpEligible = mpChunks.length > 0 && mpKeepCount <= KEEP_PRECOMPUTED_EXPORT_LIMIT;
  const trajectoryMidpoints: PrecomputedTrajectoryMidpoint[] | undefined = mpEligible
    ? []
    : undefined;
  if (mpEligible) {
    const mpTotal = mpChunks.length;
    const mpTask = `${parentId}:midpoints`;
    startCategory(mpTask, "Caching trajectory center chunks", mpTotal, "Caching trajectory center chunks");
    let mpDone = 0;
    void processChunksWithPrefetch<PrecomputedTrajectoryMidpoint>(
      mpChunks,
      manifestPath,
      signal,
      async (arr) => {
        markDatasetLoadPhase("manifest:midpoints-chunk:download");
        for (let i = 0; i < arr.length; i++) trajectoryMidpoints!.push(arr[i]);
        markDatasetLoadPhase("manifest:midpoints-chunk:cache");
        mpDone++;
        updateCategory(mpTask, "Caching trajectory center chunks", mpDone, mpTotal, "Caching trajectory center chunks");
      }
    )
      .then(() => finishCategory(mpTask))
      .catch(() =>
        failTask(mpTask, signal?.aborted ? "Cancelled" : "Failed to download trajectory centers")
      );
  }

  // A tail failure joins (rethrows) at the awaits before the Dataset literal;
  // these handles only keep the window in between from surfacing it as an
  // unhandled rejection (same pattern as pixelsPromise below).
  hdbscanPromise.catch(() => undefined);
  midpointHdbscanPromise.catch(() => undefined);

  const data: DataPoint[] = [];

  // Static boot select-frame (issue #315 insets-at-boot I3): fired in
  // parallel with the data download and NEVER awaited on the critical path —
  // the promise registers the parsed artifact against the rows array when it
  // lands, and the boot clustering's first zoom pass takes it if it made it
  // in time (the registry tombstones after that take, so a slow fetch can
  // never resurrect the boot view mid-session). Any failure or shape
  // mismatch leaves the registry empty — the classic boot is the fallback.
  if (manifest.bootSelectFrame?.file) {
    void fetch(joinUrl(manifestPath, manifest.bootSelectFrame.file), { signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((obj) => {
        const artifact = parseStaticBootFrame(obj);
        if (artifact) registerStaticBootFrame(data, artifact);
      })
      .catch(() => undefined);
  }
  let pointColumns: PointColumns | undefined;
  // Row-lazy boot (issue #315 R1b): true once `data` is a length-N array of
  // holes served by `rowAt`. Gates the two remaining row consumers of this
  // loader (the pixel attach is excluded by rowsMayStayLazy; the export copy
  // forces residency below).
  let lazyRows = false;
  // Binary sidecar path (issue #315 phase E-a): typed columns instead of a
  // JSON download+parse. Any failure falls back to the JSON chunks so an
  // old/partial sidecar can never break a dataset.
  if (manifest.dataColumns?.file && manifest.dataColumns.columns?.length) {
    const binTask = `${parentId}:dataColumns`;
    startTask({
      id: binTask,
      label: "Loading point columns",
      parentId,
      kind: "io",
      phase: "Downloading point columns…",
      value: null,
      progressMode: "indeterminate",
    });
    try {
      markDatasetLoadPhase("manifest:data-columns:download");
      // Pixel artifact (issue #315 B3): fired in parallel with the column
      // download; awaited only after materialization. Any failure rejects the
      // whole sidecar path — image insets need the pixels, so the JSON-chunk
      // fallback (which extracts them itself) is the correct degradation.
      const pixelsPromise: Promise<ArrayBuffer> | null = manifest.pixels?.file
        ? fetch(joinUrl(manifestPath, manifest.pixels.file), { signal }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status} for ${manifest.pixels!.file}`);
            return r.arrayBuffer();
          })
        : null;
      // A column-fetch failure below can leave the pixel promise un-awaited;
      // this no-op branch keeps that from surfacing as an unhandled rejection.
      pixelsPromise?.catch(() => undefined);
      const res = await fetch(joinUrl(manifestPath, manifest.dataColumns.file), { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${manifest.dataColumns.file}`);
      const buffer = await res.arrayBuffer();
      throwIfAborted(signal);
      markDatasetLoadPhase("manifest:data-columns:decode");
      pointColumns = decodeColumns(buffer, manifest.dataColumns);
      // Columns-direct boot paint (issue #315 B1): hand the decoded views to
      // the live renderer BEFORE materialization, so real points draw while
      // the row objects are still being built. Own try — a paint failure must
      // not trigger the JSON-chunk fallback.
      if (onPointColumns) {
        try {
          markDatasetLoadPhase("manifest:data-columns:paint");
          onPointColumns(pointColumns);
        } catch (paintErr) {
          console.warn("[DatasetLoader] columns-direct paint failed", paintErr);
        }
      }
      // Born column-backed rows (issue #315 B2): the canonical point columns
      // are built from the sidecar views up front and every row comes out of
      // the factory already carrying the DoI accessor via a shared prototype
      // — attachPointColumns then short-circuits instead of running its
      // 3×N defineProperty install.
      const bootCols = columnsFromSidecar(pointColumns);
      lazyRows = bootCols !== null && rowsMayStayLazy(manifest);
      // Deferred columns (issue #315 R3c): a slim manifest declares the
      // columns it kept server-side; the rows' shared prototype gains one
      // accessor per name (undefined before fetch, live after), and the
      // fetch seam registers against the canonical array BEFORE any row is
      // built. Requires a live columns provider — without one (public
      // build, backend section missing the capability) the declared columns
      // are unreachable, which is a prep/config error worth shouting about.
      const deferredEntries = manifest.deferredColumns?.columns ?? [];
      let deferred: { names: string[]; source: PointColumns } | undefined;
      if (deferredEntries.length > 0 && bootCols !== null) {
        const columnsProvider = resolveColumnsProvider(manifest.backend ?? null);
        // No columns provider (open-core build; a dead server already had
        // its backend stripped by the reachability gate above; or a backend
        // missing the "columns" capability — a config error): booting the
        // slim sidecar would strand the declared columns forever while the
        // fat JSON chunks are right there. The throw fails this whole
        // sidecar path over to them — the "client-only version" the
        // server-loss banner promises. Loud on backend-capable builds,
        // silent on the stub (nothing was lost there).
        if (!columnsProvider) {
          if (scalingBuildHasBackends) warnServerLoss();
          throw new Error(
            "deferred columns unreachable (no columns provider) — " +
              "falling back to the full JSON chunks"
          );
        }
        deferred = { names: deferredEntries.map((e) => e.name), source: pointColumns };
        registerDeferredColumns(
          data,
          pointColumns,
          deferredEntries,
          // The provider contract is structural (scaling.types stays
          // dependency-free); the server transport genuinely returns the
          // decodeColumns output, i.e. this module's PointColumns.
          (names) => columnsProvider.fetchColumns(names) as Promise<PointColumns>
        );
      }
      if (lazyRows) {
        // Row-lazy boot (issue #315 R1b): the server lane needs no row object
        // between load and first inset, so the array is created with holes and
        // rows are served on demand through `rowAt` / `ensureResidentRows`.
        markDatasetLoadPhase("manifest:data-columns:lazy-rows");
        createLazyRowArray(data, pointColumns, bootCols!, { deferred });
      } else {
        markDatasetLoadPhase("manifest:data-columns:materialize");
        const rows = await materializeRecords(pointColumns, {
          signal,
          rowFactory: bootCols ? createColumnBackedRowFactory(bootCols, deferred) : undefined,
          onSlice: (done, total) =>
            updateTask({
              id: binTask,
              phase: "Materializing points…",
              value: Math.min(99, (done / total) * 100),
              progressMode: undefined,
            }),
        });
        for (let i = 0; i < rows.length; i++) data.push(rows[i] as unknown as DataPoint);
      }
      // Attach the prep-time pixel views (issue #315 B3) exactly like the
      // JSON lane's worker extraction would have — same own properties
      // (pixels / pixelsWidth / pixelsHeight), same canonical buffer order.
      if (pixelsPromise && manifest.pixels) {
        const pixelBuffer = await pixelsPromise;
        throwIfAborted(signal);
        markDatasetLoadPhase("manifest:data-columns:pixels");
        attachPixelViews(data, {
          buffer: pixelBuffer,
          width: manifest.pixels.width,
          height: manifest.pixels.height,
          kind: manifest.pixels.kind,
        });
      }
      // Load-time passes downstream (attachPointColumns) consume the typed
      // views directly instead of re-reading the rows (issue #315 B1).
      registerSidecarColumns(data, pointColumns);
      // Kill switch (plan §6.1 A/B levers): `window.__deferColumns = false`
      // fetches every declared deferred column DURING boot — the fat-download
      // A/B without a manifest rebuild. Awaited so the census measures the
      // full payload on the boot path, exactly like a fat sidecar.
      if (deferred && !deferColumnsEnabled()) {
        markDatasetLoadPhase("manifest:data-columns:defer-kill-switch");
        await ensureResidentColumns(data, deferred.names);
      }
      // Prep-time id validation stamp (issue #315 B2): only trusted when the
      // sidecar actually carried an id column the rows adopted.
      if (manifest.dataColumns.idsValidated && pointColumns.byName.id) {
        markIdsValidated(data);
      }
      completeTask(binTask);
    } catch (err) {
      if (signal?.aborted) {
        failTask(binTask, "Cancelled");
        throw err;
      }
      console.warn("[DatasetLoader] column sidecar failed, falling back to JSON chunks", err);
      failTask(binTask, "Sidecar unavailable — using JSON chunks");
      pointColumns = undefined;
      clearLazyRowArray(data);
      clearDeferredColumns(data);
      lazyRows = false;
      data.length = 0;
    }
  }
  if (data.length === 0) {
    const dataTotal = manifest.data.chunks.length;
    const dataTask = `${parentId}:data`;
    startCategory(dataTask, "Downloading point chunks", dataTotal, "Downloading point chunks");
    let dataDone = 0;
    await processChunksWithPrefetch<DataPoint>(manifest.data.chunks, manifestPath, signal, async (arr) => {
      markDatasetLoadPhase("manifest:data-chunk");
      for (let i = 0; i < arr.length; i++) data.push(arr[i]);
      dataDone++;
      updateCategory(dataTask, "Downloading point chunks", dataDone, dataTotal, "Downloading point chunks");
    }, { pixelExtract: true });
    finishCategory(dataTask);
  }

  // kNN downloads in the BACKGROUND (issue #315 boot): the graph is consumed
  // only at selection/propagation time, never during boot, and every consumer
  // tolerates missing rows (propagateDoI `|| []`, PreviewPropagator
  // `if (nbrs)`) — rows are pushed in chunk order into the SAME array
  // instance the dataset holds, so a propagation racing the tail of the
  // download degrades to fewer proximity neighbors instead of blocking the
  // first render behind ~14 MB at 1M. A manifest without a knnGraph section
  // (issue #315 A3/P-b) simply keeps the empty array.
  const knnGraph: number[][] = [];
  const knnChunks = manifest.knnGraph?.chunks ?? [];
  const knnTotal = knnChunks.length;
  if (knnTotal > 0) {
    const knnTask = `${parentId}:knn`;
    startCategory(knnTask, "Downloading neighbor graph", knnTotal, "Downloading neighbor graph");
    let knnDone = 0;
    void processChunksWithPrefetch<number[]>(knnChunks, manifestPath, signal, async (arr) => {
      markDatasetLoadPhase("manifest:knn-chunk");
      for (let i = 0; i < arr.length; i++) knnGraph.push(arr[i]);
      knnDone++;
      updateCategory(knnTask, "Downloading neighbor graph", knnDone, knnTotal, "Downloading neighbor graph");
    })
      .then(() => finishCategory(knnTask))
      .catch(() => failTask(knnTask, signal?.aborted ? "Cancelled" : "Failed to download neighbor graph"));
  }

  let segments: PrecomputedSegment[] | undefined;
  let segmentColumns: Dataset["segmentColumns"];
  // A manifest that declared segment chunks or a (retired) segment-tile
  // pyramid was authored with trajectory geometry — derive it from the points
  // instead of downloading the ~20x larger tessellation (issue #315). The
  // result stays columnar (phase B1): no per-segment JS objects exist.
  if (manifest.segments?.chunks?.length || manifest.segmentTiles != null) {
    const segTask = `${parentId}:segments`;
    startTask({
      id: segTask,
      label: "Building trajectory splines",
      parentId,
      kind: "compute",
      phase: "Computing splines…",
      value: null,
      progressMode: "indeterminate",
    });
    try {
      markDatasetLoadPhase("manifest:segments:derive");
      const knots = await computeSplineColumnsInWorker(data, signal, pointColumns);
      throwIfAborted(signal);
      markDatasetLoadPhase("manifest:segments:expand");
      // Compact columns (issue #315 phase B2): edge arrays only; segment
      // geometry stays virtual and is derived on demand from the points.
      segmentColumns = compactSegmentColumns(knots.edgeStart, knots.edgeEnd, knots.samplesPerEdge, data);
      // The PrecomputedSegment export copy reads per-row x/y and `action` —
      // on the lazy lane it is NOT built at load any more (issue #315 R3c):
      // the residency forcing here was the one thing keeping chess/rubiks
      // rows materialized at boot, and the copy has no load-time consumer.
      // A future export/labeling consumer must go through
      // `ensureResidentRows` (which also fetches deferred columns first) and
      // rebuild the copy on demand.
      const keepSegmentsForExport =
        splineColumnSegmentCount(knots) <= KEEP_PRECOMPUTED_EXPORT_LIMIT && !lazyRows;
      const { exportSegments } = await attachSegmentPointState(data, segmentColumns, {
        signal,
        batchSize: HYDRATE_SEGMENT_BATCH,
        keepExportCopy: keepSegmentsForExport,
        // Awaited to completion before the Dataset is returned, so slicing the
        // nextEdgeCenter pass here can't race any consumer (issue #315).
        sliceCenters: true,
        // Edge centers into a column on the sidecar lane (issue #315 R1a,
        // A3): born-column-backed rows carry no shipped center to preserve,
        // so the pass never touches a row object. `pointColumns` is defined
        // only when the rows came from the sidecar (the JSON fallback clears
        // it), and attachSegmentPointState re-checks the rows itself.
        centersInto: pointColumns ? "column" : "rows",
        onProgress: (fraction) =>
          updateTask({
            id: segTask,
            phase: "Preparing spline export…",
            value: Math.min(99, fraction * 100),
            progressMode: undefined,
          }),
      });
      segments = exportSegments;
      completeTask(segTask);
    } catch (err) {
      failTask(segTask, signal?.aborted ? "Cancelled" : "Failed to build splines");
      throw err;
    }
  }

  // Register the static feature-stats payload (issue #315 B2) keyed by the
  // rows array, the same registry pattern as the sidecar columns.
  const staticStats = await staticFeatureStatsPromise;
  if (isFeatureStatsPayload(staticStats)) registerStaticFeatureStats(data, staticStats);

  // R2a join: the tail fetches fired at manifest-parse time (top of this
  // function) resolve here, before the Dataset literal — same return
  // contract as the old serial awaits, without their added wall-clock.
  const hdbscan = await hdbscanPromise;
  const midpointHdbscan = await midpointHdbscanPromise;
  // trajectoryMidpoints fills in the background (R3a) — no await here.

  const dataset: Dataset = {
    data,
    knnGraph,
    hdbscan,
    midpointHdbscan,
    datasetType: manifest.datasetType?.toLowerCase?.() ?? "default",
    segments,
    segmentColumns,
    trajectoryMidpoints,
    dataColumns: pointColumns,
    render: manifest.render ?? undefined,
    backend: manifest.backend ?? undefined,
  };

  return dataset;
}
