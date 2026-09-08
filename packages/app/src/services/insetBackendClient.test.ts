// Tests for the content-agnostic inset backend transport (issue #315).
import {
  __resetInsetBackendClientForTests,
  cancelInset,
  getCachedInset,
  requestInset,
} from "./insetBackendClient";

const BASE = "https://backend.example/api";

type FetchImpl = (input: unknown, init?: { signal?: AbortSignal }) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name === "Content-Type"
          ? "application/json"
          : name === "X-Rendered-Count"
            ? "3"
            : name === "X-Total-Count"
              ? "5"
              : null,
    },
    json: async () => body,
  } as unknown as Response;
}

const decodeJson = async (res: Response) => (await res.json()) as unknown;

beforeEach(() => {
  __resetInsetBackendClientForTests();
});

afterEach(() => {
  __resetInsetBackendClientForTests();
});

test("resolves a decoded payload and caches it by key", async () => {
  const fetchMock = jest.fn<Promise<Response>, [unknown, unknown]>(async () =>
    jsonResponse({ ok: 1 })
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  const value = await requestInset({
    key: "node:a",
    baseUrl: BASE,
    path: "/v1/inset/node",
    body: { refs: [] },
    decode: decodeJson,
  }).promise;

  expect(value).toEqual({ ok: 1 });
  expect(getCachedInset("node:a")).toEqual({ ok: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // URL joins base + path without a doubled slash.
  expect(String(fetchMock.mock.calls[0][0])).toBe("https://backend.example/api/v1/inset/node");
});

test("coalesces identical in-flight keys into one request", async () => {
  let resolveFetch!: (r: Response) => void;
  const fetchMock = jest.fn<Promise<Response>, [unknown, unknown]>(
    () => new Promise<Response>((res) => (resolveFetch = res))
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  const a = requestInset({ key: "node:x", baseUrl: BASE, path: "/p", body: {}, decode: decodeJson });
  const b = requestInset({ key: "node:x", baseUrl: BASE, path: "/p", body: {}, decode: decodeJson });

  resolveFetch(jsonResponse({ v: 2 }));
  const [ra, rb] = await Promise.all([a.promise, b.promise]);

  expect(ra).toEqual({ v: 2 });
  expect(rb).toEqual({ v: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancelling the sole subscriber aborts the request", async () => {
  let sawAbort = false;
  const fetchMock = jest.fn<Promise<Response>, [unknown, { signal?: AbortSignal }]>(
    (_input, init) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          sawAbort = true;
          rej(new DOMException("Aborted", "AbortError"));
        });
      })
  ) as unknown as FetchImpl as jest.Mock;
  global.fetch = fetchMock as unknown as typeof fetch;

  const handle = requestInset({ key: "node:c", baseUrl: BASE, path: "/p", body: {}, decode: decodeJson });
  const rejected = handle.promise.catch((e) => e);
  cancelInset("node:c");
  const err = await rejected;

  expect(sawAbort).toBe(true);
  expect((err as DOMException).name).toBe("AbortError");
});

test("rejects and does not cache when the service is unreachable", async () => {
  const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  global.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  await expect(
    requestInset({ key: "node:off", baseUrl: BASE, path: "/p", body: {}, decode: decodeJson }).promise
  ).rejects.toBeInstanceOf(TypeError);
  expect(getCachedInset("node:off")).toBeUndefined();
  // The transport must NOT advise the user itself: unreachable-service hints
  // belong to the adapter that knows the service (e.g. gym's "start it with…").
  expect(infoSpy).not.toHaveBeenCalled();
  infoSpy.mockRestore();
});

test("routes each request to its own baseUrl (services can be live at once)", async () => {
  const seen: string[] = [];
  global.fetch = (async (input: unknown) => {
    seen.push(String(input));
    return jsonResponse({ ok: 1 });
  }) as unknown as typeof fetch;

  await requestInset({
    key: "gym:a",
    baseUrl: "http://localhost:8531",
    path: "/summary",
    body: {},
    decode: decodeJson,
  }).promise;
  await requestInset({
    key: "tiles:a",
    baseUrl: "https://tiles.example",
    path: "/v1/inset/node",
    body: {},
    decode: decodeJson,
  }).promise;

  expect(seen).toEqual([
    "http://localhost:8531/summary",
    "https://tiles.example/v1/inset/node",
  ]);
});

// --- GET mode + caller-owned payloads (issue #315 phase 4b: segment tiles) ---

test("GET requests carry no body or content-type header", async () => {
  const fetchMock = jest.fn<Promise<Response>, [unknown, { method?: string }]>(async () =>
    jsonResponse([{ x0: 0 }])
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  await requestInset({
    key: "segment-tile:1/0/0",
    baseUrl: "",
    path: "https://cdn.example/data/tiles/segments/1/0_0.json.gz",
    method: "GET",
    decode: decodeJson,
  }).promise;

  const init = fetchMock.mock.calls[0][1];
  // fetch() throws on a GET with a body, so the transport must omit both it and
  // the JSON content-type that only makes sense for a POST.
  expect(init).toMatchObject({ method: "GET" });
  expect(init).not.toHaveProperty("body");
  expect(init).not.toHaveProperty("headers");
  // An empty baseUrl passes an already-absolute path straight through.
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    "https://cdn.example/data/tiles/segments/1/0_0.json.gz"
  );
});

test("cache:false resolves the payload without retaining it", async () => {
  global.fetch = jest.fn<Promise<Response>, [unknown, unknown]>(async () =>
    jsonResponse({ big: "tile" })
  ) as unknown as typeof fetch;

  const value = await requestInset({
    key: "segment-tile:1/0/0",
    baseUrl: "",
    path: "/tile",
    method: "GET",
    cache: false,
    decode: decodeJson,
  }).promise;

  expect(value).toEqual({ big: "tile" });
  // The tile client owns tile lifetime; the shared LRU must not also pin
  // megabytes of raw tiles past the caller's own eviction.
  expect(getCachedInset("segment-tile:1/0/0")).toBeUndefined();
});

test("cache:false still coalesces identical in-flight keys", async () => {
  let resolveFetch!: (r: Response) => void;
  const fetchMock = jest.fn<Promise<Response>, [unknown, unknown]>(
    () => new Promise<Response>((res) => { resolveFetch = res; })
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  const a = requestInset({ key: "t", baseUrl: "", path: "/t", method: "GET", cache: false, decode: decodeJson });
  const b = requestInset({ key: "t", baseUrl: "", path: "/t", method: "GET", cache: false, decode: decodeJson });
  resolveFetch(jsonResponse({ n: 1 }));

  await expect(a.promise).resolves.toEqual({ n: 1 });
  await expect(b.promise).resolves.toEqual({ n: 1 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

/**
 * The PULL lane a frame's winners take when no subscription is pushing their
 * content (issue #315 P7 S3). The cards must go out CONCURRENTLY — a serial
 * chain of 8 round trips is the visible card tail — bounded by
 * MAX_CONCURRENT_REQUESTS so a burst cannot starve the cut fetches sharing
 * the queue. (The server side of the same burst is single-flighted per card,
 * so raising the client cap would only queue at the GIL instead.)
 */
test("a frame's winners pull in parallel up to the concurrency cap", async () => {
  const resolvers: Array<(r: Response) => void> = [];
  const fetchMock = jest.fn<Promise<Response>, [unknown, unknown]>(
    () => new Promise<Response>((res) => { resolvers.push(res); })
  );
  global.fetch = fetchMock as unknown as typeof fetch;

  const winners = Array.from({ length: 8 }, (_, i) =>
    requestInset({
      key: `node:range:w${i}`,
      baseUrl: BASE,
      path: "/v1/inset/node",
      body: { leafRanges: [[i * 10, i * 10 + 10]] },
      decode: decodeJson,
    })
  );

  // Four are in flight at once, not one after another.
  expect(fetchMock).toHaveBeenCalledTimes(4);

  // Draining the first four admits the next four — the queue keeps the pipe
  // full instead of waiting for the whole batch.
  for (const resolve of resolvers.splice(0, 4)) resolve(jsonResponse({ card: 1 }));
  await Promise.all(winners.slice(0, 4).map((w) => w.promise));
  expect(fetchMock).toHaveBeenCalledTimes(8);

  for (const resolve of resolvers.splice(0, 4)) resolve(jsonResponse({ card: 2 }));
  await Promise.all(winners.map((w) => w.promise));
});
