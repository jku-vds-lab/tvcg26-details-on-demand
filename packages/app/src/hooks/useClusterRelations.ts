import { useMemo } from "react";
import { useSelector } from "react-redux";
import type { TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";
import type { ConsolidatedRelation } from "src/clustering/clusterRelations";
import { consolidateRelations, extractClusterRelations } from "src/clustering/clusterRelations";
import type { RootState } from "src/store";

const EMPTY_CLUSTERS: never[] = [];

/**
 * Derive cluster-conditioned edge relations from visible trajectory midpoints.
 *
 * Returns consolidated unordered-pair relations sorted by combined score
 * descending. Each {@link ConsolidatedRelation} represents all one-hop
 * transitions between two distinct active node clusters, merging the A→B and
 * B→A directions into a single record.
 */
export function useClusterRelations(
  midpoints: TrajectoryMidpoint[]
): ConsolidatedRelation[] {
  const insetActiveClusters = useSelector(
    (s: RootState) =>
      s.clustering.insetClusteringResults?.activeClusters ?? EMPTY_CLUSTERS
  );
  const annotationActiveClusters = useSelector(
    (s: RootState) =>
      s.clustering.annotationClusteringResults?.activeClusters ?? EMPTY_CLUSTERS
  );

  const activeInsetUids = useMemo(
    () => new Set(insetActiveClusters.map((c) => c.uid)),
    [insetActiveClusters]
  );
  const activeAnnotationUids = useMemo(
    () => new Set(annotationActiveClusters.map((c) => c.uid)),
    [annotationActiveClusters]
  );
  // Freehand-pinned points relate as their freehand cluster (priority over
  // the automated assignment) so edge insets also form between freehand
  // insets connected by trajectories.
  const freehandInsets = useSelector((s: RootState) => s.freehand.insets);
  const freehandAssignments = useMemo(() => {
    const m = new Map<number, string>();
    for (const inset of freehandInsets) {
      for (const id of inset.memberIds) m.set(id, inset.id);
    }
    return m;
  }, [freehandInsets]);

  const clusterSizes = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of insetActiveClusters) m.set(c.uid, c.size);
    for (const c of annotationActiveClusters) m.set(c.uid, c.size);
    for (const inset of freehandInsets) m.set(inset.id, inset.memberIds.length);
    return m;
  }, [insetActiveClusters, annotationActiveClusters, freehandInsets]);

  return useMemo(
    () =>
      consolidateRelations(
        extractClusterRelations(
          midpoints,
          activeInsetUids,
          activeAnnotationUids,
          clusterSizes,
          freehandAssignments
        )
      ),
    [midpoints, activeInsetUids, activeAnnotationUids, clusterSizes, freehandAssignments]
  );
}
