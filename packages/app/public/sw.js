// Data-cache service worker (deployed-perf session, 2026-08-21).
//
// GitHub Pages serves everything with `Cache-Control: max-age=600`, so any
// visit more than 10 minutes after the last re-downloads the full dataset
// payload (~9 MB for chess40k — measured 10.2 s cold vs 6.9 s local).
// Strategy: stale-while-revalidate for same-origin GETs under THIS deploy's
// data/ tree only — repeat visits paint from the local cache immediately
// while a background fetch refreshes the entry, so a dataset update lands
// one reload later. index.html and the hashed bundles are deliberately NOT
// intercepted: a stale data entry self-heals, a wedged app shell would not.
//
// Scope note: each deployment (e.g. a stable site and a nightly copy under a
// sub-path) registers its own copy of this file at its own base, so
// DATA_PREFIX scopes each cache to its own deploy.
//
// Two hard-won shape rules (both produced dead deploys when violated):
//   1. The response must be returned to the page as soon as headers arrive.
//      Awaiting cache.put() before responding deadlocks the clone tee (the
//      put waits for a body the page is never handed), the loader retries,
//      and the retry's put throws "Entry already exists".
//   2. The put must still be AWAITED somewhere — under event.waitUntil,
//      registered synchronously in the dispatch — or the worker is torn
//      down mid-write and the cache silently stays empty.

const DATA_PREFIX = new URL("data/", self.registration.scope).pathname;
const CACHE_NAME = "adv-data:" + DATA_PREFIX;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(DATA_PREFIX)) return;
  if (req.headers.has("range")) return; // partial responses must not be cached

  const cachePromise = caches.open(CACHE_NAME);
  const network = fetch(req);

  // Background refresh: completes independently of the response path.
  event.waitUntil(
    (async () => {
      try {
        const res = await network;
        if (res.ok) await (await cachePromise).put(req, res.clone());
      } catch {
        // Offline / cache failure — the cached copy (if any) was served.
      }
    })()
  );

  event.respondWith(
    (async () => {
      try {
        const cached = await (await cachePromise).match(req);
        if (cached) return cached;
      } catch {
        // CacheStorage unavailable (private mode) — plain network below.
      }
      try {
        return await network;
      } catch {
        return Response.error();
      }
    })()
  );
});
