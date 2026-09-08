// src/utils/clusteringSwitchGate.ts
//
// Issue #315 round 4 — dependency-free seam between the renderer switch path
// and the clustering module. useInitializeRenderer must retire the OLD
// dataset's persistent clustering when a menu switch installs the new
// aggregate base (or settled ticks re-dispatch stale actives over it), but a
// static hdbscanClustering import drags the worker factories' import.meta
// into every jest graph that touches the hook, and ts-jest resolves dynamic
// imports eagerly too. hdbscanClustering registers its clear function here
// at module load; the hook calls through the registry. A no-op until the
// clustering module has loaded — which, in the app, is always before any
// switch can happen.

let clearFn: (() => void) | null = null;

/** Registered by hdbscanClustering at module load. */
export function registerSwitchClear(fn: () => void): void {
  clearFn = fn;
}

/** Retire the persistent clustering pipelines for a dataset switch. */
export function requestSwitchClear(): void {
  clearFn?.();
}
