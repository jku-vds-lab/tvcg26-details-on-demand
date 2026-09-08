// Registration for the data-cache service worker (public/sw.js) — see the
// header comment there for the caching contract.

/**
 * True when the data-cache service worker should register: deployed web
 * contexts only. Never on localhost dev/preview — a persistent worker on a
 * localhost origin would outlive whatever project is served there next —
 * unless the deep link opts in with `sw=1` for local verification.
 */
export function shouldRegisterDataCacheWorker(
  hostname: string,
  hash: string,
  hasServiceWorker: boolean
): boolean {
  if (!hasServiceWorker) return false;
  const local = hostname === "localhost" || hostname === "127.0.0.1";
  return !local || /[#&]sw=1(?:&|$)/.test(hash);
}

/** Fire-and-forget registration (web build only — the Jupyter widget must
 * never install a worker on the notebook origin; the caller guards that). */
export function registerDataCacheWorker(baseUrl: string): void {
  if (
    !shouldRegisterDataCacheWorker(
      window.location.hostname,
      window.location.hash,
      "serviceWorker" in navigator
    )
  ) {
    return;
  }
  navigator.serviceWorker.register(baseUrl + "sw.js").catch(() => {
    // Unsupported/private-mode contexts just keep plain HTTP caching.
  });
}
