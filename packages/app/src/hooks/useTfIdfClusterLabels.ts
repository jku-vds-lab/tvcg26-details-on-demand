import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useDataRef } from "src/contexts/DataContext";
import { areRowsResident } from "src/dataPreprocessing/lazyRows";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { parseClusterUid } from "src/models/VisualElement";
import type { RootState } from "src/store";
import { setTfIdfLabels } from "src/store";
import { buildClusterCorpus, computeTfIdfLabels } from "src/utils/tfidf";

/** Maps dataset type string to its default annotation column. */
function getDefaultAnnotationColumn(datasetType: string): string {
  switch (datasetType) {
    case "rubik": return "cp";
    case "chess": return "algo";
    case "mnist": return "digit";
    case "cctv": return "label";
    default: return "label";
  }
}

/**
 * Computes TF-IDF labels for visible clusters and stores them in Redux.
 * No-ops when strategy is "majority-vote".
 *
 * Called from ClusterVisualizations with the current visible cluster items.
 * "full-dataset" scope builds its corpus lazily from all loaded data points
 * (cached until the raw data reference changes).
 */
export function useTfIdfClusterLabels(
  annotationItems: ClusterItem[],
  insetItems: ClusterItem[],
): void {
  const dispatch = useDispatch();
  const strategy = useSelector((s: RootState) => s.visualizationSettings.clusterLabelStrategy);
  const corpusScope = useSelector((s: RootState) => s.visualizationSettings.tfidfCorpusScope);
  const annotationLabelFeature = useSelector((s: RootState) => s.visualizationSettings.annotationLabelFeature);
  const delimiter = useSelector((s: RootState) => s.visualizationSettings.annotationTagDelimiter);
  const datasetType = useSelector((s: RootState) => s.dataset.datasetType);
  const dataRef = useDataRef();

  // Track last dispatched labels so we only dispatch when content changes.
  const prevLabelsRef = useRef<Record<string, string>>({});

  // Cache full-dataset corpus by data array reference so we only recompute on load.
  const fullDatasetCacheRef = useRef<{
    data: typeof dataRef.current;
    column: string;
    delimiter: string;
    labels: Record<string, string>;
  } | null>(null);

  useEffect(() => {
    function maybeDispatch(next: Record<string, string>) {
      const prev = prevLabelsRef.current;
      const nextKeys = Object.keys(next);
      if (
        nextKeys.length === Object.keys(prev).length &&
        nextKeys.every((k) => prev[k] === next[k])
      ) return;
      prevLabelsRef.current = next;
      dispatch(setTfIdfLabels(next));
    }

    if (strategy !== "tfidf") {
      maybeDispatch({});
      return;
    }

    const column = annotationLabelFeature ?? getDefaultAnnotationColumn(datasetType);

    let items: ClusterItem[];
    if (corpusScope === "visible" || corpusScope === "doi-active") {
      // Inset overlays also resolve labels via TF-IDF, and a cluster may exist
      // only in the inset layer (no annotation sibling at lower DOI), so both
      // layers must contribute corpora. Dedup happens below by parseClusterUid.
      items = [...annotationItems, ...insetItems];
    } else {
      // "full-dataset": build corpus from all loaded data points, grouped by cluster ID.
      const data = dataRef.current;
      // Row-lazy lane (issue #315 R1b): this scope keys on the PER-POINT
      // cluster ids, which the server lane stopped stamping in R1a step 5 —
      // materializing a million rows to read a property that is guaranteed
      // undefined would buy nothing, so the scope yields no labels there, the
      // same result the walk would produce. Overlay scopes are unaffected.
      if (!areRowsResident(data)) {
        maybeDispatch({});
        return;
      }
      const cache = fullDatasetCacheRef.current;
      if (cache && cache.data === data && cache.column === column && cache.delimiter === delimiter) {
        maybeDispatch(cache.labels);
        return;
      }

      // Build a corpus per cluster-id field. Inset overlays look up via
      // insetClusterId, annotation overlays via annotationClusterId — without
      // contributing both, one of the two layers always misses and falls back
      // to the placeholder. Coerce to string so the keys match parseClusterUid,
      // and so cluster id 0 (a falsy number) isn't dropped.
      const labels: Record<string, string> = {};
      for (const field of ["annotationClusterId", "insetClusterId"] as const) {
        const byCluster = new Map<string, typeof data>();
        for (const pt of data) {
          const raw = pt[field];
          if (raw === undefined || raw === null) continue;
          const cid = String(raw);
          const arr = byCluster.get(cid);
          if (arr) arr.push(pt);
          else byCluster.set(cid, [pt]);
        }
        const corpora = Array.from(byCluster.entries()).map(([cid, pts]) =>
          buildClusterCorpus(cid, pts, column, delimiter)
        );
        Object.assign(labels, computeTfIdfLabels(corpora));
      }

      fullDatasetCacheRef.current = { data, column, delimiter, labels };
      maybeDispatch(labels);
      return;
    }

    // Deduplicate by cluster UID. element.id has the form "kind-type-{uid}::hN";
    // parseClusterUid extracts just the uid so it matches firstSample.annotationClusterId
    // used by resolveViaTfIdf for the store lookup.
    const seen = new Set<string>();
    const corpora = [];
    for (const { element } of items) {
      const uid = parseClusterUid(element.id);
      if (seen.has(uid)) continue;
      seen.add(uid);
      corpora.push(buildClusterCorpus(uid, element.samples, column, delimiter));
    }

    maybeDispatch(computeTfIdfLabels(corpora));
  }, [strategy, corpusScope, annotationLabelFeature, delimiter, datasetType, annotationItems, insetItems, dataRef, dispatch]);
}
