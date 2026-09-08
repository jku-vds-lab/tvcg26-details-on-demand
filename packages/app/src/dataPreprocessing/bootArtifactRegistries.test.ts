/**
 * Boot artifact registries (issue #315 B2):
 *  - the prep-time `idsValidated` stamp travels loader → hook via a WeakSet
 *    keyed by the rows array (markIdsValidated / hasValidatedIds);
 *  - static feature-stats payloads travel loader → feature-analysis pass via
 *    a WeakMap (registerStaticFeatureStats / staticFeatureStatsFor), with
 *    isFeatureStatsPayload guarding the fetched JSON's shape.
 */

import { hasValidatedIds, markIdsValidated } from "./columnSidecar";
import {
  isFeatureStatsPayload,
  mergeStaticFeatureStats,
  registerStaticFeatureStats,
  staticFeatureStatsFor,
  type FeatureStatsPayload,
} from "./featureStatsClient";
import type { FeatureStats } from "../slices/datasetFeatures";

describe("ids-validated registry", () => {
  it("is keyed by array identity", () => {
    const stamped: object[] = [];
    const other: object[] = [];
    expect(hasValidatedIds(stamped)).toBe(false);
    markIdsValidated(stamped);
    expect(hasValidatedIds(stamped)).toBe(true);
    expect(hasValidatedIds(other)).toBe(false);
  });
});

describe("static feature-stats registry", () => {
  it("stores and resolves payloads per rows array", () => {
    const rows: object[] = [];
    const payload: FeatureStatsPayload = {
      availableKeys: ["reward"],
      statsByKey: { reward: { variableType: "sequential" } as never },
    };
    expect(staticFeatureStatsFor(rows)).toBeUndefined();
    registerStaticFeatureStats(rows, payload);
    expect(staticFeatureStatsFor(rows)).toBe(payload);
  });

  it("isFeatureStatsPayload rejects malformed shapes", () => {
    expect(isFeatureStatsPayload(null)).toBe(false);
    expect(isFeatureStatsPayload({})).toBe(false);
    expect(isFeatureStatsPayload({ availableKeys: "nope", statsByKey: {} })).toBe(false);
    expect(isFeatureStatsPayload({ availableKeys: [], statsByKey: {} })).toBe(true);
  });
});

describe("mergeStaticFeatureStats (issue #315 B3 union semantics)", () => {
  const stat = (key: string, variableType = "sequential"): FeatureStats =>
    ({ key, variableType } as unknown as FeatureStats);

  it("keeps artifact keys the micro-scan missed and appends local-only keys", () => {
    // `h5` is null on >99% of chess rows — a micro-scan sample never sees it,
    // and the intersecting SERVER merge would drop it. The static artifact
    // describes the loaded rows themselves, so it must survive.
    const artifact: FeatureStatsPayload = {
      availableKeys: ["h5", "reward"],
      statsByKey: { h5: stat("h5", "categorical"), reward: stat("reward") },
    };
    const local: FeatureStatsPayload = {
      availableKeys: ["DoI", "reward"],
      statsByKey: { DoI: stat("DoI"), reward: stat("reward", "provisional-reward") },
    };
    const merged = mergeStaticFeatureStats(artifact, local);
    expect(merged.availableKeys).toEqual(["DoI", "h5", "reward"]);
    // Shared keys: the artifact's full-scan stats win over the micro-scan's.
    expect(merged.statsByKey.reward).toBe(artifact.statsByKey.reward);
    expect(merged.statsByKey.h5).toBe(artifact.statsByKey.h5);
    // Local-only runtime keys (DoI) ride along with their micro-scan stats.
    expect(merged.statsByKey.DoI).toBe(local.statsByKey.DoI);
  });
});
