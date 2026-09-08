/** Typed client for the local Python render service (rl_trajectories/render_server.py).
 *
 * OPEN-CORE — ships in the public bundle. The gym demo datasets are a teaser:
 * cheat-unlocked on deployed hosts and inert unless the user runs the render
 * service locally, so shipping this gives away a demo, not a product.
 *
 * The service restores recorded env states and returns ONE aggregated PNG per
 * cluster, so per-state frames never reach the browser. Everything generic about
 * that exchange — the LRU of resolved summaries, coalescing of identical
 * in-flight requests, the concurrency-limited queue (zoom bursts activate many
 * clusters at once), and cancellation — lives in `services/insetBackendClient`
 * and is SHARED with the server-build tile/backend providers. This module keeps only
 * what is gym-specific: the endpoint/envId config, the `/summary` request shape,
 * PNG decoding, and the "start the render server like this" offline hint.
 *
 * The shared transport takes `baseUrl` per request precisely so this localhost
 * render service and a hosted tile backend can be live at the same time.
 */

import {
  __resetInsetBackendClientForTests,
  cancelInset,
  getCachedInset,
  requestInset,
  type RequestHandle,
} from "../../../../services/insetBackendClient";
import type { RenderPointRef } from "./gymPoints";

export interface GymRenderConfig {
  endpoint: string;
  envId?: string;
}

export const DEFAULT_RENDER_ENDPOINT = "http://localhost:8531";

/** Namespaces gym's cache keys so they cannot collide with other services. */
const KEY_PREFIX = "gym:";

let activeConfig: GymRenderConfig = { endpoint: DEFAULT_RENDER_ENDPOINT };
let offlineHintLogged = false;

/** Called on dataset switch with the manifest's `render` section (if any). */
export function setGymRenderConfig(render?: { envId?: string; endpoint?: string } | null): void {
  activeConfig = {
    endpoint: render?.endpoint ?? DEFAULT_RENDER_ENDPOINT,
    envId: render?.envId,
  };
}

export function getGymRenderConfig(): GymRenderConfig {
  return activeConfig;
}

export interface ClusterSummaryRequest {
  points: RenderPointRef[];
  agg?: "mean" | "presence";
  maxSamples?: number;
  size?: number;
}

export interface ClusterSummary {
  /** Object URL of the PNG (owned by the cache; do not revoke). */
  url: string;
  nRendered: number;
  nTotal: number;
}

export interface SummaryHandle {
  promise: Promise<ClusterSummary>;
  /** Unsubscribe; the fetch aborts once every subscriber cancelled. */
  cancel: () => void;
}

async function decodeSummary(response: Response): Promise<ClusterSummary> {
  const blob = await response.blob();
  return {
    url: typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "",
    nRendered: Number(response.headers.get("X-Rendered-Count") ?? "0"),
    nTotal: Number(response.headers.get("X-Total-Count") ?? "0"),
  };
}

function disposeSummary(summary: ClusterSummary): void {
  if (summary.url && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(summary.url);
  }
}

export function getCachedClusterSummary(key: string): ClusterSummary | undefined {
  return getCachedInset<ClusterSummary>(KEY_PREFIX + key);
}

/** Request a cluster summary; identical keys share one HTTP request. */
export function requestClusterSummary(key: string, request: ClusterSummaryRequest): SummaryHandle {
  const handle: RequestHandle<ClusterSummary> = requestInset<ClusterSummary>({
    key: KEY_PREFIX + key,
    baseUrl: activeConfig.endpoint,
    path: "/summary",
    body: {
      points: request.points,
      agg: request.agg ?? "mean",
      maxSamples: request.maxSamples ?? 128,
      size: request.size ?? 96,
    },
    decode: decodeSummary,
    dispose: disposeSummary,
  });

  const promise = handle.promise.catch((err: unknown) => {
    if (err instanceof TypeError && !offlineHintLogged) {
      // fetch() rejects with TypeError when the service is unreachable.
      offlineHintLogged = true;
      console.info(
        `[gym-insets] Render service unreachable at ${activeConfig.endpoint}. Start it with: ` +
          `python -m rl_trajectories.render_server --npz-dir <npz dir> --env-id ${activeConfig.envId ?? "<env id>"}`
      );
    }
    throw err;
  });
  // A caller may cancel before attaching a handler; keep the derived promise
  // from surfacing as an unhandled rejection.
  promise.catch(() => undefined);

  return { promise, cancel: handle.cancel };
}

/** Drop a gym summary request in flight, by its (unprefixed) key. */
export function cancelClusterSummary(key: string): void {
  cancelInset(KEY_PREFIX + key);
}

/** Test hook: drop gym config/hint state AND the shared transport's caches,
 * queue, and in-flight bookkeeping — the queue and LRU now live there, so
 * resetting only the gym side would leak state across tests. */
export function __resetGymRenderClientForTests(): void {
  activeConfig = { endpoint: DEFAULT_RENDER_ENDPOINT };
  offlineHintLogged = false;
  __resetInsetBackendClientForTests();
}
