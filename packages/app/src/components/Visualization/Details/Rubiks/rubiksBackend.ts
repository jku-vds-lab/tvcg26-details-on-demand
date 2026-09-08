// packages/app/src/components/Visualization/Details/Rubiks/rubiksBackend.ts
//
// OPEN-CORE adapter for the server-side Rubik's board provider (issue #315,
// phase 3; service: rl_trajectories/stats_server.py --kind rubiks). The
// service returns the AGGREGATED STICKER STATE as JSON — majority color +
// share per sticker for node insets, the largest color-probability gain per
// sticker for edge diffs (colorDiff54) — and the existing supersampled
// canvas renderers draw it. Any failure reports "local" and the insets run
// their client-side aggregation unchanged.

import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  createBackendInsetAdapter,
  type BackendInsetState,
} from "../backendInsetAdapter";

/** The manifest `backend.kind` this adapter serves. */
export const RUBIKS_BACKEND_KIND = "rubiks";

/** useRubiksAggregation's shape: majority color index (255 = none) + share. */
export interface RubiksAggregation {
  major: number[];
  prop: number[];
}

/** colorDiff54's per-sticker entry. */
export interface RubiksCellDiff {
  color: number;
  delta: number;
}

const cells54 = <T>(value: unknown): T[] | null =>
  Array.isArray(value) && value.length === 54 ? (value as T[]) : null;

const adapter = createBackendInsetAdapter<RubiksAggregation, RubiksCellDiff[]>({
  kind: RUBIKS_BACKEND_KIND,
  decodeNode: (r) => {
    const json = r.json as { major?: unknown; prop?: unknown } | null;
    const major = cells54<number>(json?.major);
    const prop = cells54<number>(json?.prop);
    return major && prop ? { major, prop } : null;
  },
  decodeDiff: (r) => cells54<RubiksCellDiff>((r.json as { cells?: unknown } | null)?.cells),
  startHint: ({ datasetId }) =>
    `python -m rl_trajectories.stats_server --kind rubiks --dataset <manifest.json> ` +
    `--dataset-id ${datasetId ?? "<id>"}`,
});

/** Server-side majority stickers for one cluster (or "local"/"loading"). */
export function useBackendRubiksBoard(
  samples: readonly DataPoint[]
): BackendInsetState<RubiksAggregation> {
  return adapter.useNode(samples);
}

/** Server-side color-gain diff for an A/B pair (or "local"/"loading"). */
export function useBackendRubiksDiff(
  aSamples: readonly DataPoint[],
  bSamples: readonly DataPoint[]
): BackendInsetState<RubiksCellDiff[]> {
  return adapter.useDiff(aSamples, bSamples);
}

/** Test hook: clear the offline breaker and allow the hint to fire again. */
export const __resetRubiksBackendForTests = adapter.__resetForTests;
