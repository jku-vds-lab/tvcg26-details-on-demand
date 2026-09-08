/**
 * Decides what the shared web entry (`src/index.tsx`) mounts for a given
 * `location.hash`. The tool owns every hash it uses today (empty, `#`, and
 * `#v=1&…` deep links — see `utils/deepLink.ts`); only the previously unused
 * `#/`-prefixed namespace maps to the landing page, so all existing URLs keep
 * booting the tool unchanged.
 */
export type BootTarget = "app" | "landing";

/** `""`/`"#"`/`"#v=1&…"` → `"app"`; `"#/"`/`"#/anything"` → `"landing"`. */
export function resolveBootTarget(hash: string): BootTarget {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw.startsWith("/") ? "landing" : "app";
}

/**
 * Returns a `hashchange` handler that calls `reload` when the boot target
 * flips relative to `initialHash` (landing ↔ app). Same-target hash changes —
 * e.g. the tool rewriting its own deep link — never reload.
 */
export function makeBootTargetChangeHandler(
  initialHash: string,
  reload: () => void
): (newHash: string) => void {
  const initial = resolveBootTarget(initialHash);
  return (newHash) => {
    if (resolveBootTarget(newHash) !== initial) reload();
  };
}
