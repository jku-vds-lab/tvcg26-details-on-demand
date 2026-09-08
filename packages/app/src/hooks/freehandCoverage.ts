import { groupSharesAnyId } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

/**
 * True when an automated cluster item shares ANY sample with the freehand
 * member union. Such clusters must not be annotated/inset by the automated
 * pipeline: the user freehand-pinned those points ("visualize at this
 * granularity"), so automated clusters overlapping the pinned selection
 * would fight it.
 */
export function sharesFreehandMembers(
  samples: readonly DataPoint[],
  freehandMemberIds: ReadonlySet<number>
): boolean {
  if (freehandMemberIds.size === 0) return false;
  // Index-backed groups (issue #315 R1c) hold no rows — `.some` would skip
  // every holey slot and silently answer false; the spec reads the id
  // column at the member indices instead.
  const bySpec = groupSharesAnyId(samples, freehandMemberIds);
  if (bySpec !== null) return bySpec;
  return samples.some((s) => freehandMemberIds.has(s.id));
}
