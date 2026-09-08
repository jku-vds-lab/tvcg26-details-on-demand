/**
 * Parallelized loader tail (issue #315 R2a): the clustering JSONs
 * (`hdbscan`, `midpointHdbscan`) fire at manifest-parse time instead of
 * serially after materialization, but the RETURN contract is unchanged —
 * `dataset.hdbscan` resolves non-null on a manifest dataset that declares
 * it, because `useInitialClustering`'s precomputed gate requires it at
 * return (else the boot falls onto the worker-fit path).
 *
 * Pinned here:
 *   (1) both clustering fetches START before the column download resolves
 *       (parse-time firing — the parallelization itself),
 *   (2) `hdbscan` / `midpointHdbscan` are resolved non-null at return,
 *   (3) a clustering fetch failure still fails the whole load (the join
 *       preserves the old serial error semantics).
 */

import { describe, expect, it, jest } from "@jest/globals";

import type { DataColumnsSection } from "./columnSidecar";

// downloadJson drives DownloadJob, whose real bytes path needs a worker
// (stubbed to throw under jest) — mock the seam with a path-routed text
// responder that also records start order.
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

// Imported AFTER the mock so DatasetLoader binds the fake.
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

function manifest(overrides: Partial<ManifestV1> = {}): ManifestV1 {
  const { section } = columnsBin();
  return {
    format: "multipart-dataset-v1",
    datasetType: "default",
    data: { chunks: [] },
    dataColumns: section,
    hdbscan: { path: "hdbscan.json.gz" },
    midpointHdbscan: { path: "midpoint_hdbscan.json.gz" },
    ...overrides,
  } as ManifestV1;
}

/** Serve columns.bin behind a manual gate; every other fetch 404s. */
function mockFetch(buffer: ArrayBuffer): { releaseColumns: () => void } {
  let releaseColumns!: () => void;
  const gate = new Promise<void>((res) => {
    releaseColumns = res;
  });
  const fn = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.endsWith("columns.bin")) {
      return gate.then(() => ({ ok: true, arrayBuffer: () => Promise.resolve(buffer) }));
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fn as unknown;
  return { releaseColumns };
}

function jsonResponder(path: string): string | null {
  if (path.endsWith("hdbscan.json.gz")) {
    return path.includes("midpoint")
      ? JSON.stringify(MIDPOINT_FIXTURE)
      : JSON.stringify(HDBSCAN_FIXTURE);
  }
  return null;
}

describe("DatasetLoader parallel tail (R2a)", () => {
  it("fires both clustering fetches before the column download resolves, and returns them resolved", async () => {
    started.length = 0;
    respond = jsonResponder;
    const { buffer } = columnsBin();
    const { releaseColumns } = mockFetch(buffer);

    const p = loadDatasetFromManifestObject(manifest(), "/data/fixture/manifest.json", "task:r2a");
    // The tail promises run synchronously up to their first await, so both
    // jobs must already be started while columns.bin is still gated.
    await Promise.resolve();
    expect(started.some((u) => u.endsWith("/hdbscan.json.gz"))).toBe(true);
    expect(started.some((u) => u.endsWith("/midpoint_hdbscan.json.gz"))).toBe(true);

    releaseColumns();
    const ds = await p;
    // The return contract: resolved (non-null) at return, never a pending
    // promise — useInitialClustering's precomputed gate reads it directly.
    expect(ds.hdbscan).toEqual(HDBSCAN_FIXTURE);
    expect(ds.midpointHdbscan).toEqual(MIDPOINT_FIXTURE);
    expect(ds.data).toHaveLength(N);
  });

  it("resolves hdbscan undefined when the manifest declares none", async () => {
    started.length = 0;
    respond = jsonResponder;
    const { buffer } = columnsBin();
    const { releaseColumns } = mockFetch(buffer);
    releaseColumns();

    const ds = await loadDatasetFromManifestObject(
      manifest({ hdbscan: undefined, midpointHdbscan: undefined }),
      "/data/fixture/manifest.json",
      "task:r2a-none"
    );
    expect(ds.hdbscan).toBeUndefined();
    expect(ds.midpointHdbscan).toBeUndefined();
    expect(started).toHaveLength(0);
  });

  it("a clustering fetch failure still fails the load", async () => {
    started.length = 0;
    respond = (path) =>
      path.endsWith("/hdbscan.json.gz") && !path.includes("midpoint")
        ? Promise.reject(new Error("boom"))
        : jsonResponder(path);
    const { buffer } = columnsBin();
    const { releaseColumns } = mockFetch(buffer);
    releaseColumns();

    await expect(
      loadDatasetFromManifestObject(manifest(), "/data/fixture/manifest.json", "task:r2a-fail")
    ).rejects.toThrow("boom");
  });
});
