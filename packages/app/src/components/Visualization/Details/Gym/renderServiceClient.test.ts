import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  __resetGymRenderClientForTests,
  DEFAULT_RENDER_ENDPOINT,
  getCachedClusterSummary,
  getGymRenderConfig,
  requestClusterSummary,
  setGymRenderConfig,
} from "./renderServiceClient";

interface PendingFetch {
  url: string;
  init: RequestInit;
  resolve: (response: unknown) => void;
  reject: (err: unknown) => void;
}

let pendingFetches: PendingFetch[] = [];

function okResponse(nRendered = 3, nTotal = 5) {
  return {
    ok: true,
    headers: {
      get: (name: string) =>
        name === "X-Rendered-Count" ? String(nRendered) : name === "X-Total-Count" ? String(nTotal) : null,
    },
    blob: async () => new Blob(["png-bytes"]),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("renderServiceClient", () => {
  let urlCounter = 0;

  beforeEach(() => {
    __resetGymRenderClientForTests();
    pendingFetches = [];
    urlCounter = 0;
    global.fetch = jest.fn((url: unknown, init?: unknown) => {
      return new Promise((resolve, reject) => {
        const request: PendingFetch = {
          url: String(url),
          init: (init ?? {}) as RequestInit,
          resolve: resolve as (response: unknown) => void,
          reject,
        };
        request.init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
        pendingFetches.push(request);
      });
    }) as unknown as typeof fetch;
    URL.createObjectURL = jest.fn(() => `blob:test-${urlCounter++}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = jest.fn() as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("posts the expected request shape and resolves with meta headers", async () => {
    const handle = requestClusterSummary("k1", { points: [[0, 1], [2, 3]] });
    expect(pendingFetches).toHaveLength(1);
    expect(pendingFetches[0].url).toBe(`${DEFAULT_RENDER_ENDPOINT}/summary`);
    expect(JSON.parse(String(pendingFetches[0].init.body))).toEqual({
      points: [[0, 1], [2, 3]],
      agg: "mean",
      maxSamples: 128,
      size: 96,
    });

    pendingFetches[0].resolve(okResponse(2, 4));
    const summary = await handle.promise;
    expect(summary).toEqual({ url: "blob:test-0", nRendered: 2, nTotal: 4 });
    expect(getCachedClusterSummary("k1")).toEqual(summary);
  });

  it("uses the manifest-configured endpoint", async () => {
    setGymRenderConfig({ envId: "Hopper-v5", endpoint: "http://localhost:9999" });
    expect(getGymRenderConfig().envId).toBe("Hopper-v5");
    requestClusterSummary("k1", { points: [[0, 0]] });
    expect(pendingFetches[0].url).toBe("http://localhost:9999/summary");
  });

  it("coalesces identical in-flight keys into one HTTP request", async () => {
    const a = requestClusterSummary("same", { points: [[0, 0]] });
    const b = requestClusterSummary("same", { points: [[0, 0]] });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    pendingFetches[0].resolve(okResponse());
    const [summaryA, summaryB] = await Promise.all([a.promise, b.promise]);
    expect(summaryA).toBe(summaryB);
  });

  it("limits concurrency to 4 and drains the queue as requests finish", async () => {
    const handles = Array.from({ length: 6 }, (_, i) =>
      requestClusterSummary(`k${i}`, { points: [[0, i]] })
    );
    expect(global.fetch).toHaveBeenCalledTimes(4);

    pendingFetches[0].resolve(okResponse());
    await handles[0].promise;
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(5);

    pendingFetches[1].resolve(okResponse());
    await handles[1].promise;
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it("cancelling a queued request removes it without fetching", async () => {
    const handles = Array.from({ length: 5 }, (_, i) =>
      requestClusterSummary(`k${i}`, { points: [[0, i]] })
    );
    handles[4].cancel(); // still queued (only 4 slots)
    await expect(handles[4].promise).rejects.toThrow("Aborted");

    for (let i = 0; i < 4; i++) pendingFetches[i].resolve(okResponse());
    await Promise.all(handles.slice(0, 4).map((h) => h.promise));
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("aborts a started request only after every subscriber cancelled", async () => {
    const a = requestClusterSummary("shared", { points: [[0, 0]] });
    const b = requestClusterSummary("shared", { points: [[0, 0]] });
    const signal = pendingFetches[0].init.signal!;

    a.cancel();
    expect(signal.aborted).toBe(false);
    b.cancel();
    expect(signal.aborted).toBe(true);
    await expect(a.promise).rejects.toThrow("Aborted");
  });

  it("re-requesting a cancelled key starts a fresh fetch (StrictMode remount)", async () => {
    // React 18 StrictMode mounts, cleans up, and mounts again: the second
    // request must not join the aborted first entry or the inset spins forever.
    const first = requestClusterSummary("k1", { points: [[0, 0]] });
    first.cancel();
    await expect(first.promise).rejects.toThrow("Aborted");

    const second = requestClusterSummary("k1", { points: [[0, 0]] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    pendingFetches[1].resolve(okResponse());
    await expect(second.promise).resolves.toMatchObject({ nRendered: 3 });
  });

  it("rejects and logs a one-time hint when the service is unreachable", async () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    const a = requestClusterSummary("k1", { points: [[0, 0]] });
    pendingFetches[0].reject(new TypeError("Failed to fetch"));
    await expect(a.promise).rejects.toThrow("Failed to fetch");

    const b = requestClusterSummary("k2", { points: [[0, 1]] });
    pendingFetches[1].reject(new TypeError("Failed to fetch"));
    await expect(b.promise).rejects.toThrow("Failed to fetch");

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toContain("render_server");
  });

  it("surfaces server error messages from non-OK responses", async () => {
    const handle = requestClusterSummary("k1", { points: [[99, 0]] });
    pendingFetches[0].resolve({
      ok: false,
      status: 400,
      json: async () => ({ error: "No renderable points in request" }),
      headers: { get: () => null },
    });
    await expect(handle.promise).rejects.toThrow("No renderable points in request");
  });
});
