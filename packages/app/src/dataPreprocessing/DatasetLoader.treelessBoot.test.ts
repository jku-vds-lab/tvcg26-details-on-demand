/**
 * Treeless boot on cut-served datasets (issue #315 merge gate): a manifest
 * whose LIVE backend advertises the `cut` capability must not download its
 * shipped hierarchy JSONs — the cut provider drives the boot clustering and
 * the transfer is dead weight (chess40k: 4.8 MB).
 *
 * Pinned here, one lane per test:
 *   (1) live cut backend — both hierarchy fetches are SKIPPED and the
 *       dataset returns with `hdbscan`/`midpointHdbscan` undefined (the
 *       chessslim/synth1m manifest shape, which the server lane serves),
 *   (2) dead backend — the strip-at-load path restores the client-complete
 *       fetch (the "reload delivers the client-only version" contract),
 *   (3) no declared backend — the skip must NOT key on the PREVIOUS
 *       dataset's active provider (resolveCutProvider's undefined-argument
 *       fallback), so a plain client manifest still fetches.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import type { DataColumnsSection } from "./columnSidecar";

// downloadJson drives DownloadJob, whose real bytes path needs a worker
// (stubbed to throw under jest) — mock the seam with a path-routed text
// responder that also records start order (same harness as the R2a test).
const started: string[] = [];
let respond: (path: string) => string | Promise<string> | null = () => null;

jest.mock("./DownloadJob", () => {
  class FakeDownloadJob {
    entry: { path: string };
    terminated = false;
    constructor(entry: { path: string }) {
      this.entry = entry;
    }
    async start(onFinishText: (t: string) => void): Promise<void> {
      started.push(this.entry.path);
      const res = respond(this.entry.path);
      if (res === null) throw new Error(`no responder for ${this.entry.path}`);
      onFinishText(await res);
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  return { DownloadJob: FakeDownloadJob };
});

const scalingMock = {
  resolveColumnsProvider: jest.fn((_backend?: unknown): unknown => null),
  resolveCutProvider: jest.fn((_backend?: unknown): unknown => null),
  scalingBuildHasBackends: true,
};
jest.mock("@scaling", () => scalingMock);

const warnServerLoss = jest.fn();
jest.mock("../utils/serverLoss", () => ({ warnServerLoss: (...a: unknown[]) => warnServerLoss(...a) }));

// Imported AFTER the mocks so DatasetLoader binds the fakes.
import { loadDatasetFromManifestObject, type ManifestV1 } from "./DatasetLoader";

const N = 8;

/** Little-endian columns.bin: f64 x, f64 y, u32 line, u32 id. */
function columnsBin(): { buffer: ArrayBuffer; section: DataColumnsSection } {
  const offX = 0;
  const offY = offX + 8 * N;
  const offLine = offY + 8 * N;
  const offId = offLine + 4 * N;
  const buffer = new ArrayBuffer(offId + 4 * N);
  const x = new Float64Array(buffer, offX, N);
  const y = new Float64Array(buffer, offY, N);
  const line = new Uint32Array(buffer, offLine, N);
  const id = new Uint32Array(buffer, offId, N);
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = i * 2;
    line[i] = 0;
    id[i] = 100 + i;
  }
  return {
    buffer,
    section: {
      file: "columns.bin",
      count: N,
      idsValidated: true,
      columns: [
        { name: "x", dtype: "f64", byteOffset: offX },
        { name: "y", dtype: "f64", byteOffset: offY },
        { name: "line", dtype: "u32", byteOffset: offLine },
        { name: "id", dtype: "u32", byteOffset: offId },
      ],
    },
  };
}

const HDBSCAN_FIXTURE = { tree: [{ id: 0, children: [] }], version: 1 };
const MIDPOINT_FIXTURE = { tree: [{ id: 7, children: [] }], version: 1 };

const CUT_BACKEND = {
  kind: "chess",
  baseUrl: "http://127.0.0.1:8548",
  datasetId: "chess40k",
  capabilities: ["node", "diff", "cut", "select-cut", "columns"],
};

function manifest(overrides: Partial<ManifestV1> = {}): ManifestV1 {
  const { section } = columnsBin();
  return {
    format: "multipart-dataset-v1",
    datasetType: "chess",
    data: { chunks: [] },
    dataColumns: section,
    hdbscan: { path: "hdbscan.json.gz" },
    midpointHdbscan: { path: "midpoint_hdbscan.json.gz" },
    ...overrides,
  } as ManifestV1;
}

function mockFetch(buffer: ArrayBuffer): void {
  const fn = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.endsWith("columns.bin")) {
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(buffer) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fn as unknown;
}

function jsonResponder(path: string): string | null {
  if (path.endsWith("hdbscan.json.gz")) {
    return path.includes("midpoint")
      ? JSON.stringify(MIDPOINT_FIXTURE)
      : JSON.stringify(HDBSCAN_FIXTURE);
  }
  return null;
}

const startedHierarchyFetches = () =>
  started.filter((u) => u.endsWith("hdbscan.json.gz"));

describe("DatasetLoader treeless boot (cut provider supersedes shipped hierarchies)", () => {
  beforeEach(() => {
    started.length = 0;
    respond = jsonResponder;
    warnServerLoss.mockClear();
    scalingMock.resolveColumnsProvider.mockReset().mockReturnValue(null);
    scalingMock.resolveCutProvider.mockReset().mockReturnValue(null);
    mockFetch(columnsBin().buffer);
  });

  it("skips both hierarchy downloads when the backend is alive and cut-capable", async () => {
    scalingMock.resolveCutProvider.mockImplementation((backend?: unknown) =>
      backend ? { probeHealth: async () => true } : null
    );

    const ds = await loadDatasetFromManifestObject(
      manifest({ backend: CUT_BACKEND } as Partial<ManifestV1>),
      "/data/fixture/manifest.json",
      "task:treeless-live"
    );
    expect(startedHierarchyFetches()).toHaveLength(0);
    expect(ds.hdbscan).toBeUndefined();
    expect(ds.midpointHdbscan).toBeUndefined();
    expect(ds.data).toHaveLength(N);
    expect(warnServerLoss).not.toHaveBeenCalled();
  });

  it("fetches the hierarchies when the backend is DEAD (strip-at-load restores client-complete boot)", async () => {
    scalingMock.resolveCutProvider.mockImplementation((backend?: unknown) =>
      backend ? { probeHealth: async () => false } : null
    );

    const ds = await loadDatasetFromManifestObject(
      manifest({ backend: CUT_BACKEND } as Partial<ManifestV1>),
      "/data/fixture/manifest.json",
      "task:treeless-dead"
    );
    expect(startedHierarchyFetches()).toHaveLength(2);
    expect(ds.hdbscan).toEqual(HDBSCAN_FIXTURE);
    expect(ds.midpointHdbscan).toEqual(MIDPOINT_FIXTURE);
    expect(warnServerLoss).toHaveBeenCalled();
  });

  it("fetches the hierarchies on a backend-less manifest even while a cut provider is registered for the previous dataset", async () => {
    // resolveCutProvider(undefined) resolves the ACTIVE (previous dataset's)
    // backend — simulate that stale fallback answering for every call.
    scalingMock.resolveCutProvider.mockReturnValue({ probeHealth: async () => true });

    const ds = await loadDatasetFromManifestObject(
      manifest(),
      "/data/fixture/manifest.json",
      "task:treeless-clientonly"
    );
    expect(startedHierarchyFetches()).toHaveLength(2);
    expect(ds.hdbscan).toEqual(HDBSCAN_FIXTURE);
    expect(ds.midpointHdbscan).toEqual(MIDPOINT_FIXTURE);
    // The loader must never have asked with no argument (the stale-active
    // fallback) — every call names the manifest's own backend.
    for (const call of scalingMock.resolveCutProvider.mock.calls as unknown[][]) {
      expect(call.length).toBeGreaterThan(0);
      expect(call[0]).toBeDefined();
    }
  });
});
