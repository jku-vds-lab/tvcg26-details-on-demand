// packages/app/src/components/Visualization/Details/imageBackend.ts
//
// OPEN-CORE adapter for the server-side image inset provider (issue #315,
// phase 3; service: rl_trajectories/stats_server.py --kind image). When the
// active dataset declares `backend: { kind: "image", ... }`, the hooks below
// fetch ONE aggregated PNG per cluster (grayscale mean) or per A/B pair
// (diverging per-pixel diff) — per-point pixel payloads are never read
// client-side. The PNGs are decoded by the shared transport into object URLs
// owned by its LRU (same lifecycle as the gym render insets). Any failure
// reports "local" and the CCTV/MNIST insets run their existing client-side
// pixel aggregation unchanged.
//
// The async state machine, offline circuit breaker, and one-time service
// hint live in the shared adapter factory (./backendInsetAdapter.ts).

import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  createBackendInsetAdapter,
  type BackendInsetState,
} from "./backendInsetAdapter";

/** The manifest `backend.kind` this adapter serves. */
export const IMAGE_BACKEND_KIND = "image";

/** Image responses resolve to an object URL; anything else ⇒ local. */
const urlOf = (response: { url?: string }): string | null => response.url ?? null;

const adapter = createBackendInsetAdapter<string, string>({
  kind: IMAGE_BACKEND_KIND,
  decodeNode: urlOf,
  decodeDiff: urlOf,
  startHint: ({ datasetId }) =>
    `python -m rl_trajectories.stats_server --kind image --dataset <manifest.json> ` +
    `--dataset-id ${datasetId ?? "<id>"}`,
});

export type ImageBackendState = BackendInsetState<string>;

/** Object URL of the server-aggregated cluster mean image (or "local"/"loading"). */
export function useBackendImageUrl(samples: readonly DataPoint[]): ImageBackendState {
  return adapter.useNode(samples);
}

/** Object URL of the server-aggregated A/B diff image (or "local"/"loading"). */
export function useBackendImageDiffUrl(
  aSamples: readonly DataPoint[],
  bSamples: readonly DataPoint[]
): ImageBackendState {
  return adapter.useDiff(aSamples, bSamples);
}

/** Test hook: clear the offline breaker and allow the hint to fire again. */
export const __resetImageBackendForTests = adapter.__resetForTests;
