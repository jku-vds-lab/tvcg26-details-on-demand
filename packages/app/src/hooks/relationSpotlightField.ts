import type { EdgeAugmentedPoint } from "src/hooks/useCreateRelationInsetElements";

/**
 * Opacity value for non-spotlight nodes during a diff-inset hover (D2).
 * Low but non-zero so the overall embedding structure stays legible.
 */
export const SPOTLIGHT_DIM = 0.15;

/**
 * Build a WebGL opacity field that spotlights the endpoint nodes of a relation:
 * - Endpoint nodes (edgeStart.id / edgeEnd.id in each sample) → 1.0
 * - All other nodes → SPOTLIGHT_DIM
 * - Unknown ids (not in indexById) are silently skipped (left at DIM).
 *
 * Pure function — no side effects, independently testable.
 *
 * @param samples   EdgeAugmentedPoints from ClusterItem.element.samples for the relation.
 * @param indexById Map from DataPoint.id → index into the nodes array (from getPropagationPrecomputation).
 * @param length    Length of the nodes array (= size of the returned Float32Array).
 */
export function relationSpotlightField(
  samples: EdgeAugmentedPoint[],
  indexById: Map<number, number>,
  length: number,
): Float32Array {
  const field = new Float32Array(length).fill(SPOTLIGHT_DIM);
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
