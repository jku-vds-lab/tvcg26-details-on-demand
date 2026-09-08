// src/services/insetBackendClient.ts
//
// OPEN-CORE — shared transport for every on-demand inset/tile service.
//
// This is deliberately NOT behind the `@scaling` backend seam. It is generic
// plumbing (LRU, coalescing, a concurrency-limited queue, cancellation) with no
// scaling IP in it, and the open-core Gymnasium inset needs it to talk to its
// local render service. Since open-core may never import the backend providers (see
// plan-315-tiled-backend.md), a shared transport must live here — and it costs
// nothing to do so, because gym ships an equivalent publicly regardless.
// The server-build providers (hosted backend, tile pyramid) import it from here; the
// differentiating parts stay in `src/scaling/`.
//
// Callers supply the endpoint, path, body, and a `decode` function, so images,
// tabular stats, and board diffs all reuse the same machinery.
//
// `baseUrl` is PER REQUEST rather than global config: several services can be
// live at once (a localhost gym render service AND a hosted tile backend), which
// a single module-global endpoint cannot express.

import { ledgerMark, ledgerNote } from "../utils/insetLedger";

const MAX_CONCURRENT_REQUESTS = 4;
const PAYLOAD_CACHE_CAPACITY = 512;

/**
 * One backend request. `key` coalesces identical in-flight requests and keys the
 * LRU (use the cluster signature). `decode` turns the raw `Response` into the
 * cached value; `dispose` (optional) releases it on eviction (e.g. revoke an
 * object URL).
 */
export interface InsetBackendRequest<T> {
  /** Coalesce + LRU key. Prefix per service so two services cannot collide. */
  key: string;
  /** Absolute base url of the target service (dev localhost or hosted). */
  baseUrl: string;
  /** Path appended to the base url, e.g. "/v1/inset/node". */
  path: string;
  /**
   * HTTP method. Defaults to "POST" (every inset provider posts member refs).
   * "GET" is for static, addressable payloads — the segment tile pyramid is
   * fetched from plain files, whose identity is entirely in the path, so it
   * sends no body. `fetch` throws on a GET with a body, so `body` is ignored.
   */
  method?: "GET" | "POST";
  /** JSON-serializable request body. Ignored when `method` is "GET". */
  body?: unknown;
  /**
   * Retain the decoded payload in the shared LRU (default true).
   *
   * Set false when the CALLER owns the payload's lifetime. The tile client
   * evicts hydrated tiles against its own budget keyed by (z,x,y); letting the
   * shared 512-entry LRU also retain every raw tile would double-retain the
   * megabytes tiling exists to bound, and would keep off-view tiles alive past
   * the caller's eviction. Coalescing still applies either way.
   */
  cache?: boolean;
  decode: (response: Response) => Promise<T>;
  dispose?: (value: T) => void;
}

export interface RequestHandle<T> {
  promise: Promise<T>;
  /** Unsubscribe; the fetch aborts once every subscriber cancelled. */
  cancel: () => void;
}

interface PendingEntry {
  key: string;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  body: unknown;
  cache: boolean;
  decode: (response: Response) => Promise<unknown>;
  dispose?: (value: unknown) => void;
  subscribers: number;
  started: boolean;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface CachedPayload {
  value: unknown;
  dispose?: (value: unknown) => void;
}

class PayloadLru {
  private map = new Map<string, CachedPayload>();
  constructor(private capacity: number) {}

  get(key: string): CachedPayload | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: CachedPayload): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.entries().next();
      if (!oldest.done) {
        this.map.delete(oldest.value[0]);
        oldest.value[1].dispose?.(oldest.value[1].value);
      }
    }
  }

  clear(): void {
    for (const cached of this.map.values()) cached.dispose?.(cached.value);
    this.map.clear();
  }
}

const payloadCache = new PayloadLru(PAYLOAD_CACHE_CAPACITY);
const pending = new Map<string, PendingEntry>();
const queue: PendingEntry[] = [];
let activeRequests = 0;

/** Synchronous cache lookup for a resolved payload. */
export function getCachedInset<T>(key: string): T | undefined {
  return payloadCache.get(key)?.value as T | undefined;
}

/**
 * Seed the cache with a payload that arrived unrequested (issue #315 Plan
 * H2 content push), so an inset mounting under `key` finds it synchronously
 * and never renders a spinner frame.
 *
 * A payload already in flight or cached for this key wins: it is the one
 * subscribers are awaiting, and replacing it would strand their promise and
 * leak the object URL they will never see. Returns whether the seed landed.
 */
export function seedCachedInset<T>(
  key: string,
  value: T,
  dispose?: (value: T) => void
): boolean {
  if (pending.has(key) || payloadCache.get(key) !== undefined) {
    dispose?.(value);
    return false;
  }
  payloadCache.set(key, { value, dispose: dispose as ((v: unknown) => void) | undefined });
  return true;
}

/** Request an inset payload; identical keys share one HTTP request. */
export function requestInset<T>(request: InsetBackendRequest<T>): RequestHandle<T> {
  const { key } = request;
  const existing = pending.get(key);
  // Never join an entry that is already aborting (subscribers drained): its
  // promise rejects with AbortError and the new subscriber would hang forever.
  // Start a fresh request instead.
  if (existing && existing.subscribers > 0 && !existing.controller.signal.aborted) {
    existing.subscribers++;
    ledgerMark(`k:${key}`, "reqJoined");
    return {
      promise: existing.promise as Promise<T>,
      cancel: () => unsubscribe(existing),
    };
  }
  if (existing) pending.delete(key);

  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The queue may reject before any subscriber attaches a catch handler.
  promise.catch(() => undefined);

  const entry: PendingEntry = {
    key,
    baseUrl: request.baseUrl,
    path: request.path,
    method: request.method ?? "POST",
    body: request.body,
    cache: request.cache ?? true,
    decode: request.decode as (response: Response) => Promise<unknown>,
    dispose: request.dispose as ((value: unknown) => void) | undefined,
    subscribers: 1,
    started: false,
    controller: new AbortController(),
    promise,
    resolve,
    reject,
  };
  pending.set(key, entry);
  queue.push(entry);
  // Task 2 attribution (#315): queue admission + depth at enqueue time —
  // cut fetches and inset content share these MAX_CONCURRENT_REQUESTS slots.
  ledgerMark(`k:${key}`, "reqQueued");
  ledgerNote(`k:${key}`, "queueDepth", `${queue.length}q/${activeRequests}a`);
  pumpQueue();
  return { promise: promise as Promise<T>, cancel: () => unsubscribe(entry) };
}

/** Drop a subscriber on a request in flight (or queued), by cache key. */
export function cancelInset(key: string): void {
  const entry = pending.get(key);
  if (entry) unsubscribe(entry);
}

function unsubscribe(entry: PendingEntry): void {
  entry.subscribers--;
  if (entry.subscribers > 0) return;
  if (entry.started) {
    entry.controller.abort();
  } else {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    pending.delete(entry.key);
    entry.reject(new DOMException("Aborted", "AbortError"));
  }
}

function pumpQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && queue.length > 0) {
    const entry = queue.shift()!;
    entry.started = true;
    activeRequests++;
    ledgerMark(`k:${entry.key}`, "reqSent");
    void executeRequest(entry).finally(() => {
      activeRequests--;
      pending.delete(entry.key);
      pumpQueue();
    });
  }
}

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function executeRequest(entry: PendingEntry): Promise<void> {
  try {
    const response = await fetch(
      joinUrl(entry.baseUrl, entry.path),
      entry.method === "GET"
        ? { method: "GET", signal: entry.controller.signal }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry.body),
            signal: entry.controller.signal,
          }
    );
    if (!response.ok) {
      let message = `Backend responded ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body; keep the status message
      }
      throw new Error(message);
    }
    ledgerMark(`k:${entry.key}`, "reqResponse");
    const value = await entry.decode(response);
    ledgerMark(`k:${entry.key}`, "reqDecoded");
    if (entry.cache) payloadCache.set(entry.key, { value, dispose: entry.dispose });
    entry.resolve(value);
  } catch (err) {
    // Unreachable-service reporting belongs to the CALLER, not here: each
    // adapter knows its own service and can tell the user how to start it
    // (fetch() rejects with TypeError when the service is unreachable).
    entry.reject(err);
  }
}

/** Test hook: drop caches, queue, and in-flight bookkeeping. */
export function __resetInsetBackendClientForTests(): void {
  payloadCache.clear();
  pending.clear();
  queue.length = 0;
  activeRequests = 0;
}
