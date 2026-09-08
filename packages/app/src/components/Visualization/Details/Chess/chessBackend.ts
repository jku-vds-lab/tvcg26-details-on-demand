// packages/app/src/components/Visualization/Details/Chess/chessBackend.ts
//
// OPEN-CORE adapter for the server-side chess board provider (issue #315,
// phase 3; service: rl_trajectories/stats_server.py --kind chess). The
// service returns the AGGREGATED BOARD STATE as JSON — the per-square top
// piece for node insets and the PSE change-heat SquareDiff for edge insets —
// and the existing sprite renderers draw it, so per-point square payloads
// never need to be read client-side. Any failure reports "local" and the
// insets run their client-side aggregation unchanged.

import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  createBackendInsetAdapter,
  type BackendInsetState,
} from "../backendInsetAdapter";
import type { SquareDiff } from "./chessDiffEncoding";

/** The manifest `backend.kind` this adapter serves. */
export const CHESS_BACKEND_KIND = "chess";

/** ChessBoardInset's per-square top entry (most frequent piece + share). */
export interface ChessSquareTop {
  code: string;
  count: number;
  ratio: number;
}

const board64 = <T>(value: unknown): T[] | null =>
  Array.isArray(value) && value.length === 64 ? (value as T[]) : null;

const adapter = createBackendInsetAdapter<ChessSquareTop[], SquareDiff[]>({
  kind: CHESS_BACKEND_KIND,
  decodeNode: (r) => board64<ChessSquareTop>((r.json as { tops?: unknown } | null)?.tops),
  decodeDiff: (r) => board64<SquareDiff>((r.json as { squares?: unknown } | null)?.squares),
  startHint: ({ datasetId }) =>
    `python -m rl_trajectories.stats_server --kind chess --dataset <manifest.json> ` +
    `--dataset-id ${datasetId ?? "<id>"}`,
});

/** Server-side per-square tops for one cluster (or "local"/"loading"). */
export function useBackendChessBoard(
  samples: readonly DataPoint[]
): BackendInsetState<ChessSquareTop[]> {
  return adapter.useNode(samples);
}

/** Server-side PSE SquareDiffs for an A/B pair (or "local"/"loading"). */
export function useBackendChessDiff(
  aSamples: readonly DataPoint[],
  bSamples: readonly DataPoint[]
): BackendInsetState<SquareDiff[]> {
  return adapter.useDiff(aSamples, bSamples);
}

/** Test hook: clear the offline breaker and allow the hint to fire again. */
export const __resetChessBackendForTests = adapter.__resetForTests;
