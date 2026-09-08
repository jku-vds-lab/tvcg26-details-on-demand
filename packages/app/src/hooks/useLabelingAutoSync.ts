import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useDataRef } from "../contexts/DataContext";
import type { AppDispatch, RootState } from "../store";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident } from "../dataPreprocessing/lazyRows";
import { ensureResidentRowsWithChip } from "../utils/rowResidency";
import { selectLabelFeatureName } from "../slices/labelingSelectors";
import {
  syncAssignmentsFromFeaturesImpl,
  syncAssignmentsIntoVisualizationImpl,
} from "./useLabeling";

/**
 * Runs syncAssignmentsFromFeatures whenever labeling mode transitions
 * false → true, or whenever the resolved label feature column changes while
 * enabled. Must be mounted at the app root so it sees the transition
 * (LabelingPanel is only rendered while enabled, so it cannot observe it).
 *
 * A column change on the SAME rows (either input, issue #352) additionally
 * rewrites the per-row `__assignedLabel` overrides from the re-imported
 * assignments — the renderers prefer those overrides, so without the rewrite
 * the clusters keep the labels of the previous column. Fresh rows carry no
 * overrides, so a dataset switch or the first run skips that pass.
 */
export function useLabelingAutoSync(): void {
  const dispatch = useDispatch<AppDispatch>();
  const dataRef = useDataRef();
  const isEnabled = useSelector((s: RootState) => s.labeling.isEnabled);
  const column = useSelector(selectLabelFeatureName);
  const lastSyncRef = useRef<{ points: DataPoint[]; column: string } | null>(null);

  useEffect(() => {
    if (!isEnabled) return;
    const points = dataRef.current;
    const last = lastSyncRef.current;
    const rewriteOverrides = last !== null && last.points === points && last.column !== column;
    lastSyncRef.current = { points, column };
    const sync = () => {
      syncAssignmentsFromFeaturesImpl(points, dispatch, column);
      if (rewriteOverrides) syncAssignmentsIntoVisualizationImpl(points, dispatch, column);
    };
    // Labeling is THE row-contract member (issue #315 R1b): the sync reads a
    // label off every row and the assignment write-back creates a `features`
    // bag on rows that never had one. Enabling labeling is therefore the cause
    // that materializes a row-lazy dataset — with a chip, once, here, so every
    // downstream labeling path (assign, preview, write-back) finds real rows.
    // On every other lane the rows are already resident and this stays the
    // synchronous call it has always been.
    if (areRowsResident(points)) {
      sync();
      return;
    }
    let cancelled = false;
    void ensureResidentRowsWithChip(points, "Preparing rows for labeling")
      .then(() => {
        if (!cancelled) sync();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isEnabled, column, dataRef, dispatch]);
}
