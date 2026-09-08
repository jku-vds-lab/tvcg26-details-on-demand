/**
 * Pure logic for injecting user-assigned labels into data-chunk rows.
 * No React, no Redux — safe to import from both the main thread and workers.
 */

/**
 * Build a lookup from the Redux label-assignments snapshot.
 *
 * Redux stores assignments as Record<string, string> where every key is
 * String(DataPoint.id) — a stringified integer.  We convert those back to
 * integer keys so that a simple Map.get(row.id) works during patching.
 */
export function createLabelLookup(
  assignments: Record<string, string>,
): Map<number, string> {
  const lookup = new Map<number, string>();
  for (const [key, label] of Object.entries(assignments)) {
    const id = Number(key);
    if (Number.isFinite(id)) {
      lookup.set(id, label);
    }
  }
  return lookup;
}

/**
 * Return a new array of rows with `labelField` injected (or overwritten) on
 * every row whose numeric `id` is present in `labelLookup`.
 *
 * Guarantees:
 * - Input array and its objects are never mutated.
 * - Row count is identical to the input.
 * - `id` values and all other existing fields are unchanged.
 * - Rows absent from the lookup are returned as-is (no new field added).
 */
export function patchDataPoints(
  rows: Array<Record<string, unknown>>,
  labelLookup: Map<number, string>,
  labelField: string,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const id = row.id;
    if (typeof id !== "number") return row;
    const label = labelLookup.get(id);
    if (label === undefined) return row;
    return { ...row, [labelField]: label };
  });
}
