import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { columnsOf, indexOfId } from "../dataPreprocessing/pointColumns";

/**
 * Apply the freehand-mode DoI rule — a boost with NO propagation:
 * members of any freehand inset get DoI 1; every other node keeps its
 * current DoI untouched (the existing distribution — uniform or propagated —
 * must never be disturbed by a freehand lasso).
 *
 * When a normal selection is active, the caller re-runs the field
 * propagation beforehand so boosts from replaced/removed freehand insets
 * don't linger (#337: `runLocalFieldPropagation` with the members as pins).
 */
export function applyFreehandDoiBoost(
  nodes: DataPoint[],
  memberIds: ReadonlySet<number>
): void {
  if (!memberIds.size) return;
  const cols = columnsOf(nodes);
  if (cols) {
    // O(selection): resolve each member id to its canonical index and write
    // the DoI column directly — same column the accessor reads, so semantics
    // match the scan below. Ids not in the dataset resolve to undefined.
    for (const id of memberIds) {
      const idx = indexOfId(nodes, id);
      if (idx !== undefined) cols.doi[idx] = 1;
    }
    return;
  }
  for (const node of nodes) {
    if (memberIds.has(node.id)) {
      node.DoI = 1;
    }
  }
}
