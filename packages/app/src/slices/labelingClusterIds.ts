import type { ClusterId } from "../types/labeling";

/**
 * Lazy registry for the full cluster-id list of the current dataset.
 *
 * The labeling slice stores only `totalClusters`; the ids themselves
 * (up to 1M branded strings at synth1m scale) must never enter Redux —
 * materializing them and pushing them through Immer's finalize walk cost
 * ~0.3 s on the boot critical path (issue #315 insets-at-boot, I2).
 * `useLabelingModeKeyboardToggle` registers a provider on dataset/count
 * change; the array and its membership Set materialize on first demand
 * (rare: "select all/unlabeled" actions, progress over labeled sessions)
 * and are cached until the provider is replaced.
 */

let provider: (() => ClusterId[]) | null = null;
let idsCache: ClusterId[] | null = null;
let idSetCache: Set<ClusterId> | null = null;

export function setLabelingClusterIdProvider(
  next: (() => ClusterId[]) | null
): void {
  provider = next;
  idsCache = null;
  idSetCache = null;
}

export function getLabelingClusterIds(): ClusterId[] {
  if (idsCache === null) idsCache = provider ? provider() : [];
  return idsCache;
}

export function getLabelingClusterIdSet(): Set<ClusterId> {
  if (idSetCache === null) idSetCache = new Set(getLabelingClusterIds());
  return idSetCache;
}
