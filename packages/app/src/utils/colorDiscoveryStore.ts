/**
 * Lightweight external store tracking category keys dynamically assigned by
 * colorScale's fallback (i.e. values not yet present in stats.categories),
 * plus accurate per-category counts computed by the WebGL renderer over the
 * full dataset.
 *
 * Implements the useSyncExternalStore contract so React components can
 * subscribe and re-render the instant a new key is first coloured or counts
 * are updated.
 *
 * Reset by colorScale.ts on every encoding/palette change so stale keys
 * never carry across datasets or encoding switches.
 */

let keys: string[] = [];
let counts: Record<string, number> = {};
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const l of listeners) l();
}

/** Called by colorScale.resetColorScale — clears all discovered keys and counts. */
export function resetDiscovery(): void {
  if (keys.length === 0 && Object.keys(counts).length === 0) return;
  keys = [];
  counts = {};
  notify();
}

/**
 * Called by colorScale whenever its fallback assigns a colour to a key not
 * present in stats.categories. Fires a notification only on first discovery.
 */
export function recordDiscoveredKey(key: string): void {
  if (keys.includes(key)) return;
  keys = [...keys, key];
  notify();
}

/**
 * Called by the WebGL renderer after it iterates all nodes for a given
 * encoding. Provides accurate counts for every category value across the
 * entire dataset (not capped by the progressive scan limit).
 */
export function recordAllCounts(newCounts: Record<string, number>): void {
  counts = newCounts;
  notify();
}

export const colorDiscoveryStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
  getSnapshot(): number {
    return version;
  },
  getKeys(): string[] {
    return keys;
  },
  getCounts(): Record<string, number> {
    return counts;
  },
} as const;
