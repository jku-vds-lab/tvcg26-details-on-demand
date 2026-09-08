/**
 * Laziness contract of the cluster-id registry (issue #315 insets-at-boot
 * I2): registering a provider must not materialize anything; the array and
 * Set build once on first demand and cache until the provider is replaced.
 */

import { describe, expect, it, jest } from "@jest/globals";
import { createClusterId } from "../types/labeling";
import {
    getLabelingClusterIdSet,
    getLabelingClusterIds,
    setLabelingClusterIdProvider,
} from "./labelingClusterIds";

describe("labelingClusterIds registry", () => {
  it("does not call the provider on registration", () => {
    const provider = jest.fn(() => [createClusterId("1")]);
    setLabelingClusterIdProvider(provider);
    expect(provider).not.toHaveBeenCalled();
  });

  it("materializes once and caches array + set until re-registration", () => {
    const provider = jest.fn(() => ["1", "2"].map(createClusterId));
    setLabelingClusterIdProvider(provider);

    const ids = getLabelingClusterIds();
    const set = getLabelingClusterIdSet();
    expect(ids).toEqual(["1", "2"]);
    expect(set.has(createClusterId("2"))).toBe(true);
    expect(getLabelingClusterIds()).toBe(ids);
    expect(getLabelingClusterIdSet()).toBe(set);
    expect(provider).toHaveBeenCalledTimes(1);

    const next = jest.fn(() => [createClusterId("9")]);
    setLabelingClusterIdProvider(next);
    expect(getLabelingClusterIds()).toEqual(["9"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("yields empty ids with no provider registered", () => {
    setLabelingClusterIdProvider(null);
    expect(getLabelingClusterIds()).toEqual([]);
    expect(getLabelingClusterIdSet().size).toBe(0);
  });
});
