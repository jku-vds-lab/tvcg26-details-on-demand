import { describe, expect, it } from "@jest/globals";
import {
  findDatasetEntryBySlug,
  isDatasetEntryLocked,
  isLocalHost,
  LOCAL_DATA_SERVER_ORIGIN,
  PREDEFINED_DATASETS,
  resolveDatasetFetchPath,
} from "./catalog";

const DEPLOYED = "jku-vds-lab.github.io";

describe("localOnly dataset locking", () => {
  it("classifies hostnames", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    expect(isLocalHost(DEPLOYED)).toBe(false);
  });

  it("locks localOnly entries on a deployed host until the cheat unlock", () => {
    const hopper = PREDEFINED_DATASETS.find((d) => d.slug === "hopper")!;
    expect(isDatasetEntryLocked(hopper, DEPLOYED, false)).toBe(true);
    expect(isDatasetEntryLocked(hopper, DEPLOYED, true)).toBe(false);
    expect(isDatasetEntryLocked(hopper, "localhost", false)).toBe(false);
  });

  it("never locks deployed (non-localOnly) entries", () => {
    const chess = PREDEFINED_DATASETS.find((d) => d.slug === "chess")!;
    expect(isDatasetEntryLocked(chess, DEPLOYED, false)).toBe(false);
  });

  it("deep-link slugs for locked datasets resolve only locally or unlocked", () => {
    expect(findDatasetEntryBySlug("hopper", "localhost", false)?.slug).toBe("hopper");
    expect(findDatasetEntryBySlug("hopper", DEPLOYED, false)).toBeUndefined();
    expect(findDatasetEntryBySlug("hopper", DEPLOYED, true)?.slug).toBe("hopper");
    expect(findDatasetEntryBySlug("chess", DEPLOYED, false)?.slug).toBe("chess");
  });

  it("locks backend-requiring entries on provider-less builds regardless of host (2026-08-05)", () => {
    const entry = { localOnly: true, requiresBackend: true };
    // Open-core build: locked even on localhost with the cheat unlock — no
    // provider tree exists, the dataset can never function.
    expect(isDatasetEntryLocked(entry, "localhost", true, false)).toBe(true);
    // Server build: only the normal localOnly rules apply.
    expect(isDatasetEntryLocked(entry, "localhost", false, true)).toBe(false);
    expect(isDatasetEntryLocked({ requiresBackend: true }, DEPLOYED, false, true)).toBe(false);
    // The genuinely server-only datasets carry the flag; chess40k does NOT —
    // its JSON chunks are the fat originals, so the loader's chunk fallback
    // makes it client-complete without a provider.
    for (const slug of ["synth250k", "synth1m"]) {
      expect(PREDEFINED_DATASETS.find((d) => d.slug === slug)?.requiresBackend).toBe(true);
    }
    expect(PREDEFINED_DATASETS.find((d) => d.slug === "chess40k")?.requiresBackend).toBeUndefined();
  });

  it("reroutes localOnly dataset fetches to the local data server on deployed hosts", () => {
    expect(resolveDatasetFetchPath("data/hopper/manifest.json", DEPLOYED)).toBe(
      `${LOCAL_DATA_SERVER_ORIGIN}/data/hopper/manifest.json`
    );
    expect(resolveDatasetFetchPath("data/hopper/manifest.json", "localhost")).toBe(
      "data/hopper/manifest.json"
    );
    // Non-localOnly datasets are deployed with the app: never rerouted.
    expect(resolveDatasetFetchPath("data/all_chess_openings/manifest.json", DEPLOYED)).toBe(
      "data/all_chess_openings/manifest.json"
    );
  });
});
