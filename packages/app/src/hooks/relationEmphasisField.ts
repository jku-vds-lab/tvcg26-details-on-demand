import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";

/**
 * Build a WebGL emphasis field that marks the endpoint nodes of a relation:
 * - Endpoint nodes (edgeStart.id / edgeEnd.id in each sample) → 1.0
 * - All other nodes → 0.0 (no emphasis)
 * - Unknown ids (not in indexById) are silently skipped.
 *
 * Endpoint ids come from edgeStart.id / edgeEnd.id — NOT sample.id.
 * (sample.id equals edgeStart.id; edgeEnd is the other cluster's node.)
 *
 * Pair with useRelationSpotlight: the emphasis field feeds the renderer's
 * per-node size channel (u_emphasisScale * a_emphasisField) so highlighted
 * endpoint nodes and their trajectory edges grow during the spotlight tween.
 *
 * Pure function — no side effects, independently testable.
 *
 * @param samples   EdgeAugmentedPoints from ClusterItem.element.samples.
 * @param indexById Map from DataPoint.id → index into the nodes array.
 * @param length    Length of the nodes array (= size of the returned Float32Array).
 */
export function relationEmphasisField(
  samples: EdgeAugmentedPoint[],
  indexById: Map<number, number>,
  length: number,
): Float32Array {
  const field = new Float32Array(length); // zeros by default
  for (const s of samples) {
    if (s.edgeStart !== undefined) {
      const i = indexById.get(s.edgeStart.id);
      if (i !== undefined) field[i] = 1;
    }
    if (s.edgeEnd !== undefined) {
      const i = indexById.get(s.edgeEnd.id);
      if (i !== undefined) field[i] = 1;
    }
  }
  return field;
}
