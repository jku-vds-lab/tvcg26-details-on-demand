// packages/app/src/dataPreprocessing/featureStatsClient.ts
//
// OPEN-CORE client for the server-side feature-stats endpoint (issue #315 —
// slim datasets). When a backend is active AND its /health advertises the
// featureStats capability, the boot-time "Analyzing features" pass FETCHES
// per-column stats from `GET /v1/feature-stats` instead of scanning up to 20k
// rows locally. In every other case (no backend, health not ready, the public
// build's `@scaling` stub, service unreachable, malformed payload, timeout) the
// caller falls back to the existing client-side scan path unchanged, so the
// serverless/paper build stays byte-identical.
//
// The discovery + fetch/retry/intersect logic here is pure and dependency-
// injectable (the `deps` seam) so it is unit-tested without a React render.

import { resolveInsetProvider } from "@scaling";
import type { FeatureStats } from "../slices/datasetFeatures";

export interface FeatureStatsPayload {
  availableKeys: string[];
  statsByKey: Record<string, FeatureStats>;
}

/** Outcome of a feature-stats fetch attempt. `stats` ⇒ dispatch + skip the
 * scan; `fallback` ⇒ run the existing client-side chunked scan. Abort is
 * signalled by a thrown AbortError (like the scan), never a result. */
export type FeatureStatsFetchResult =
  | { kind: "stats"; payload: FeatureStatsPayload }
  | { kind: "fallback" };

/** Injectable seam so the fetch/retry logic is testable without a network. */
export interface FeatureStatsClientDeps {
  fetch: typeof fetch;
  /** Abortable delay used between 503 retries. */
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const HEALTH_TIMEOUT_MS = 4000;
const STATS_TIMEOUT_MS = 15000;
const MAX_503_RETRIES = 2;
const DEFAULT_RETRY_AFTER_MS = 1000;

const defaultDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const defaultDeps: FeatureStatsClientDeps = { fetch: (...args) => fetch(...args), delay: defaultDelay };

/**
 * Base url of the active backend, or `null`. Reads the active manifest through
 * the `@scaling` seam (undefined ⇒ "use the active backend"): the open-core
 * stub always resolves `null`, so the public build never fetches and stays
 * byte-identical. Any backend kind qualifies here — the /health featureStats
 * flag is the real authority on whether the endpoint exists.
 */
export function resolveFeatureStatsBaseUrl(): string | null {
  return resolveInsetProvider(undefined)?.manifest.baseUrl ?? null;
}

/** True when the payload has the intersectable shape. */
export function isFeatureStatsPayload(value: unknown): value is FeatureStatsPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as { availableKeys?: unknown; statsByKey?: unknown };
  return Array.isArray(v.availableKeys) && !!v.statsByKey && typeof v.statsByKey === "object";
}

// Static feature-stats artifact (issue #315 B2): a manifest-declared JSON
// file carrying the same payload the server endpoint would serve, so
// client-complete datasets skip the 20k-row scan too. WeakMap keyed by the
// rows array (the sidecar-registry pattern) — no prop drilling.
const staticStatsByRows = new WeakMap<object, FeatureStatsPayload>();

/** Associate a rows array with its prep-time feature-stats payload. */
export function registerStaticFeatureStats(rows: object, payload: FeatureStatsPayload): void {
  staticStatsByRows.set(rows, payload);
}

/** The static feature-stats payload for `rows`, if the manifest shipped one. */
export function staticFeatureStatsFor(rows: object): FeatureStatsPayload | undefined {
  return staticStatsByRows.get(rows);
}

/**
 * Merge the server payload with the LOCAL micro-scan result. Three cases:
 * - shared keys: server stats win (full-scan `"high"` confidence);
 * - server-only keys: dropped — the server knows the dataset's FAT columns
 *   (board fields, pixels, features) that the slim client never downloaded,
 *   and those must not appear in the UI;
 * - local-only keys: kept with their micro-scan stats — client-RUNTIME
 *   columns (`DoI` is initialized at load and never exists in the server's
 *   raw records) would otherwise vanish from the feature list entirely.
 * Keys are re-sorted with the scan's comparator so the merged list matches
 * what a pure local scan would have produced.
 */
export function mergeServerFeatureStats(
  server: FeatureStatsPayload,
  local: FeatureStatsPayload
): FeatureStatsPayload {
  const localSet = new Set(local.availableKeys);
  const availableKeys = server.availableKeys.filter((key) => localSet.has(key));
  const merged = new Set(availableKeys);
  const statsByKey: Record<string, FeatureStats> = {};
  for (const key of availableKeys) {
    const stat = server.statsByKey[key];
    if (stat) statsByKey[key] = stat;
  }
  for (const key of local.availableKeys) {
    if (merged.has(key)) continue;
    const stat = local.statsByKey[key];
    if (!stat) continue;
    availableKeys.push(key);
    statsByKey[key] = stat;
  }
  availableKeys.sort((a, b) => a.localeCompare(b));
  return { availableKeys, statsByKey };
}

/**
 * Merge a STATIC artifact payload with the local micro-scan (issue #315 B3).
 * Unlike the server merge above, static keys are kept WHOLESALE: the artifact
 * was computed from exactly the records the client loaded (there are no
 * server-only fat columns to hide), and the micro-scan is a few-hundred-row
 * sample that misses keys which are null early in the array (chess board
 * squares are null on >99% of rows) — intersecting would drop real columns.
 * Local-only keys (client-RUNTIME columns like `DoI`) are appended with their
 * micro-scan stats, exactly like the server merge does.
 */
export function mergeStaticFeatureStats(
  staticPayload: FeatureStatsPayload,
  local: FeatureStatsPayload
): FeatureStatsPayload {
  const availableKeys = staticPayload.availableKeys.slice();
  const merged = new Set(availableKeys);
  const statsByKey: Record<string, FeatureStats> = {};
  for (const key of availableKeys) {
    const stat = staticPayload.statsByKey[key];
    if (stat) statsByKey[key] = stat;
  }
  for (const key of local.availableKeys) {
    if (merged.has(key)) continue;
    const stat = local.statsByKey[key];
    if (!stat) continue;
    availableKeys.push(key);
    statsByKey[key] = stat;
  }
  availableKeys.sort((a, b) => a.localeCompare(b));
  return { availableKeys, statsByKey };
}

/** fetch bounded by a timeout AND the caller's abort signal. Rejects with
 * AbortError when the caller aborts; with a generic Error on timeout. */
async function boundedFetch(
  deps: FeatureStatsClientDeps,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await deps.fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Parse a Retry-After header (HTTP: delta-seconds). Falls back to a default. */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return DEFAULT_RETRY_AFTER_MS;
}

/**
 * Fetch server feature-stats for the active backend. Health-gated: a /health
 * without a truthy `featureStats` flag ⇒ `fallback`. On 200 with a valid
 * payload ⇒ `stats`. On 503 ⇒ retry after Retry-After (max MAX_503_RETRIES)
 * then `fallback`. Any other status / network error / timeout ⇒ `fallback`.
 * The caller's abort cancels the in-flight fetch AND the retry delays,
 * surfacing as a thrown AbortError.
 */
export async function fetchServerFeatureStats(
  baseUrl: string,
  signal?: AbortSignal,
  deps: FeatureStatsClientDeps = defaultDeps
): Promise<FeatureStatsFetchResult> {
  const base = baseUrl.replace(/\/+$/, "");

  // ── Health gate ─────────────────────────────────────────────────────────
  let health: Response;
  try {
    health = await boundedFetch(deps, `${base}/health`, HEALTH_TIMEOUT_MS, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: "fallback" };
  }
  if (!health.ok) return { kind: "fallback" };
  let ready = false;
  try {
    const body = (await health.json()) as { featureStats?: unknown };
    const flag = body.featureStats;
    // The server advertises `{ready: boolean}` while precomputing; a plain
    // truthy flag (older/simpler servers) also qualifies. `ready: false`
    // falls back to the scan immediately instead of burning 503 retries.
    ready =
      !!flag &&
      (typeof flag !== "object" || (flag as { ready?: unknown }).ready !== false);
  } catch {
    return { kind: "fallback" };
  }
  if (!ready) return { kind: "fallback" };

  // ── Stats fetch with 503 retry ──────────────────────────────────────────
  const url = `${base}/v1/feature-stats`;
  for (let attempt = 0; attempt <= MAX_503_RETRIES; attempt++) {
    let response: Response;
    try {
      response = await boundedFetch(deps, url, STATS_TIMEOUT_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      return { kind: "fallback" };
    }

    if (response.status === 503) {
      if (attempt === MAX_503_RETRIES) return { kind: "fallback" };
      // Abort during the retry wait must cancel like the scan does.
      await deps.delay(parseRetryAfterMs(response.headers?.get?.("Retry-After") ?? null), signal);
      continue;
    }

    if (!response.ok) return { kind: "fallback" };

    try {
      const payload = await response.json();
      if (isFeatureStatsPayload(payload)) return { kind: "stats", payload };
      return { kind: "fallback" };
    } catch {
      return { kind: "fallback" };
    }
  }

  return { kind: "fallback" };
}
