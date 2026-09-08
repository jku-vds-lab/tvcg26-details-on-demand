// packages/app/src/components/Visualization/Details/Tabular/tabularStatsBackend.ts
//
// OPEN-CORE adapter for the server-side tabular stats provider (issue #315,
// phase 2; service: rl_trajectories/stats_server.py). When the active dataset
// declares `backend: { kind: "tabular-stats", ... }`, the hooks below fetch
// fully-binned SummaryRow[] / DiffRow[] from the service through the backend
// provider seam — no raw features and no whole-dataset reference are read
// client-side. In every other case (no backend, other backend kinds, the
// public build's `@scaling` stub, service unreachable, malformed payload)
// they report "local" and the caller runs the existing client-side
// featureStats path unchanged.
//
// The async state machine, offline circuit breaker, and one-time service
// hint live in the shared adapter factory (../backendInsetAdapter.ts).

import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  createBackendInsetAdapter,
  type BackendInsetState,
} from "../backendInsetAdapter";
import type { DiffRow, SummaryRow } from "./featureStats";

/** The manifest `backend.kind` this adapter serves. */
export const TABULAR_STATS_KIND = "tabular-stats";

/** A payload is EITHER parsed rows (JSON) or a server-rendered PNG (issue
 * #315 wave S: content negotiation — a service without rendering support
 * ignores `format:"png"` and answers rows, so both arms stay live). */
type TabularPayload<R> = { type: "rows"; rows: R[] } | { type: "image"; url: string };

function payloadOf<R>(response: { json?: unknown; url?: string }): TabularPayload<R> | null {
  if (response.url) return { type: "image", url: response.url };
  const json = response.json as { rows?: unknown } | null | undefined;
  return json && Array.isArray(json.rows) ? { type: "rows", rows: json.rows as R[] } : null;
}

const adapter = createBackendInsetAdapter<TabularPayload<SummaryRow>, TabularPayload<DiffRow>>({
  kind: TABULAR_STATS_KIND,
  decodeNode: payloadOf<SummaryRow>,
  decodeDiff: payloadOf<DiffRow>,
  startHint: ({ datasetId }) =>
    `python -m rl_trajectories.stats_server --dataset <manifest.json> ` +
    `--dataset-id ${datasetId ?? "<id>"}`,
});

export const resolveTabularStatsProvider = adapter.resolveProvider;

export type TabularBackendState<R> =
  | { kind: "local" }
  | { kind: "loading"; grace?: boolean }
  | { kind: "ready"; rows: R[] }
  | { kind: "image"; url: string };

function toRowsState<R>(state: BackendInsetState<TabularPayload<R>>): TabularBackendState<R> {
  if (state.kind !== "ready") return state;
  return state.payload.type === "image"
    ? { kind: "image", url: state.payload.url }
    : { kind: "ready", rows: state.payload.rows };
}

const PNG_OPTS = { format: "png" } as const;

/** Server-side SummaryRow[] — or a server-RENDERED PNG shell when
 * `preferRendered` and the service supports it (or "local"/"loading"). */
export function useBackendSummaryRows(
  samples: readonly DataPoint[],
  opts?: { preferRendered?: boolean }
): TabularBackendState<SummaryRow> {
  return toRowsState(adapter.useNode(samples, opts?.preferRendered ? PNG_OPTS : undefined));
}

/** Server-side DiffRow[] — or a rendered PNG shell (or "local"/"loading"). */
export function useBackendDiffRows(
  aSamples: readonly DataPoint[],
  bSamples: readonly DataPoint[],
  opts?: { preferRendered?: boolean }
): TabularBackendState<DiffRow> {
  return toRowsState(adapter.useDiff(aSamples, bSamples, opts?.preferRendered ? PNG_OPTS : undefined));
}

/** Test hook: clear the offline breaker and allow the hint to fire again. */
export const __resetTabularStatsBackendForTests = adapter.__resetForTests;
