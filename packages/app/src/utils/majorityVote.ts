// Utility to compute the majority label within a list of strings.
// Returns the most frequent label and whether multiple unique
// labels were present in the input.

/**
 * Single-pass majority vote over arbitrary items (issue #315 insets-at-boot
 * I2): the label-array call sites materialized one or two O(members)
 * intermediate string arrays per inset before counting — ~100 ms + GC on the
 * 1M boot first-apply. Counting goes through the same plain object +
 * stable-sort as always, so tie-breaking (including integer-like key
 * reordering by Object.entries) is byte-identical to majorityVote.
 * Empty-string labels are skipped.
 */
export function majorityVoteBy<T>(
  items: readonly T[],
  labelOf: (item: T) => string
): {
  label: string;
  multiple: boolean;
} {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const l = labelOf(item);
    if (l !== '') {
      counts[l] = (counts[l] ?? 0) + 1;
    }
  }
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return { label: '', multiple: false };
  }
  entries.sort((a, b) => b[1] - a[1]);
  const [label] = entries[0];
  return { label, multiple: entries.length > 1 };
}

export function majorityVote(labels: string[]): {
  label: string;
  multiple: boolean;
} {
  return majorityVoteBy(labels, (l) => l);
}
