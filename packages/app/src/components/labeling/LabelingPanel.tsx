import { alpha, useTheme } from "@mui/material/styles";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useLabeledExport } from "../../hooks/useLabeledExport";
import { useLabeling } from "../../hooks/useLabeling";
import { useUndoRedoAndSessions } from "../../hooks/useUndoRedoAndSessions";
import { setUnlabeledOnlyMode } from "../../slices/labelingSlice";
import { getDefaultLabelFeature, selectUnlabeledOnlyMode } from "../../slices/labelingSelectors";
import type { RootState } from "../../store";
import { LabelFeatureNameInput } from "./LabelFeatureNameInput";
import styles from "./LabelingPanel.module.css";

/**
 * Main UI component for cluster labeling.
 * Provides:
 * - Label input with validation
 * - Progress bar & statistics
 * - Quick selection filters
 * - Export controls
 * - Auto-save to browser storage
 */
export const LabelingPanel: React.FC = () => {
  const labeling = useLabeling();
  const { enableAutosave } = useUndoRedoAndSessions();
  const dispatch = useDispatch();
  const theme = useTheme();
  const datasetPath = useSelector((state: RootState) => state.dataset.datasetPath);
  const datasetType = useSelector((state: RootState) => state.dataset.datasetType);
  const unlabeledOnlyMode = useSelector(selectUnlabeledOnlyMode);
  const inputRef = useRef<HTMLInputElement>(null);

  const { isExporting, progress: exportProgress, error: exportError, startLabeledExport } = useLabeledExport();

  const hasLabels = Object.keys(labeling.assignments).length > 0;

  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showAllDistributions, setShowAllDistributions] = useState(false);
  const filteredLabels = labeling.existingLabels.filter((label: string) =>
    label.includes(labeling.inputLabel.toLowerCase())
  );

  const labelDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    (Object.entries(labeling.assignments) as Array<[string, string]>).forEach(([, label]) => {
      counts.set(label, (counts.get(label) || 0) + 1);
    });

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [labeling.assignments]);

  const MAX_VISIBLE_DISTRIBUTIONS = 12;
  const visibleLabelDistribution = showAllDistributions
    ? labelDistribution
    : labelDistribution.slice(0, MAX_VISIBLE_DISTRIBUTIONS);
  const hiddenDistributionCount = Math.max(0, labelDistribution.length - visibleLabelDistribution.length);

  const datasetDisplayName = useMemo(() => {
    const rawName = labeling.metadata.datasetName?.trim();
    if (rawName && rawName.toLowerCase() !== "unknown") {
      return rawName;
    }

    if (datasetPath) {
      const normalized = datasetPath.replace(/\\/g, "/");
      const basename = normalized.split("/").pop();
      if (basename) return basename;
    }

    return datasetType || "Current dataset";
  }, [datasetPath, datasetType, labeling.metadata.datasetName]);

  const panelThemeVars = useMemo(
    () => ({
      "--lp-surface": alpha(theme.palette.background.paper, 0.9),
      "--lp-surface-soft": alpha(theme.palette.background.paper, 0.72),
      "--lp-border": theme.palette.divider,
      "--lp-text": theme.palette.text.primary,
      "--lp-text-muted": theme.palette.text.secondary,
      "--lp-accent": theme.palette.primary.main,
      "--lp-accent-contrast": theme.palette.primary.contrastText,
      "--lp-accent-soft": alpha(theme.palette.primary.main, 0.12),
      "--lp-danger": theme.palette.error.main,
      "--lp-danger-soft": alpha(theme.palette.error.main, 0.12),
      "--lp-hover": alpha(theme.palette.action.hover, 0.3),
      "--lp-radius": `${theme.shape.borderRadius}px`,
      "--lp-font": theme.typography.fontFamily,
    }) as React.CSSProperties,
    [theme]
  );

  // Focus input when first rendered
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Enable auto-save every 30 seconds
  useEffect(() => {
    // Convert assignments object to Map format for session autosave.
    const assignmentsMap = new Map<
      import("../../types/labeling").ClusterId,
      string
    >(
      Object.entries(labeling.assignments).map(([k, v]) => [
        k as import("../../types/labeling").ClusterId,
        v,
      ])
    );

    const cleanup = enableAutosave(
      assignmentsMap,
      labeling.metadata.datasetKey,
      labeling.metadata.datasetName,
      labeling.progress.total,
      30000 // 30 seconds
    );
    return cleanup;
  }, [
    enableAutosave,
    labeling.assignments,
    labeling.metadata.datasetKey,
    labeling.metadata.datasetName,
    labeling.progress.total,
  ]);

  // Handle label submission
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (labeling.assignableCount === 0) {
      labeling.updateInputLabel("");
      return;
    }
    if (labeling.assignLabel(labeling.inputLabel)) {
      labeling.clearSelection();
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      labeling.updateInputLabel("");
      labeling.clearSelection();
    }
    if (e.key === "ArrowDown" && filteredLabels.length > 0) {
      e.preventDefault();
      setShowAutocomplete(true);
    }
  };

  const handleAutocompleteClick = (label: string) => {
    labeling.updateInputLabel(label);
    inputRef.current?.focus();
    setShowAutocomplete(false);
  };

  const handlePreviewMouseEnter = () => {
    labeling.setLabeledOpacityPreview(true);
  };

  const handlePreviewMouseLeave = () => {
    labeling.setLabeledOpacityPreview(false);
  };

  const handlePreviewToggle = () => {
    labeling.togglePinnedLabeledDoiMode();
  };

  const handleUnlabeledOnlyToggle = () => {
    dispatch(setUnlabeledOnlyMode(!unlabeledOnlyMode));
  };

  return (
    <div className={styles.panel} style={panelThemeVars}>
      <div className={styles.header}>
        <h2>Labeling</h2>
      </div>

      {/* Dataset info */}
      <div className={styles.info}>
        <div className={styles.infoRow}>
          <span className={styles.datasetName} title={datasetDisplayName}>{datasetDisplayName}</span>
        </div>
        <div className={styles.infoRow}>
          <label className={styles.featureLabel} htmlFor="label-feature-name">
            Feature name
          </label>
          <LabelFeatureNameInput
            value={labeling.labelFeatureName}
            placeholder={getDefaultLabelFeature(datasetType)}
            className={styles.featureInput}
            onCommit={labeling.updateLabelFeatureName}
          />
        </div>
      </div>

      {/* Progress bar */}
      <div className={styles.progressContainer}>
        <div className={styles.progressLabel}>
          <span>
            {labeling.progress.labeled} / {labeling.progress.total}
          </span>
          <span className={styles.percentage}>
            {Math.round(labeling.progress.percentage)}%
          </span>
        </div>
        <div className={styles.progressBar}>
          <div
            className={styles.progressFill}
            style={{ width: `${labeling.progress.percentage}%` }}
          />
        </div>
      </div>

      <div className={styles.previewControls}>
        <button
          className={`${styles.controlBtn} ${labeling.isLabeledOpacityPreviewActive ? styles.previewActiveBtn : ""}`}
          type="button"
          onMouseEnter={handlePreviewMouseEnter}
          onMouseLeave={handlePreviewMouseLeave}
          onClick={handlePreviewToggle}
          title="Hover to preview labeled vs unlabeled opacity. Click to lock/unlock."
        >
          {labeling.isLabeledOpacityPreviewPinned ? "Visibility Preview Pinned" : labeling.isLabeledOpacityPreviewActive ? "Visibility Preview On" : "Visibility Preview"}
        </button>
        <button
          className={`${styles.controlBtn} ${unlabeledOnlyMode ? styles.previewActiveBtn : ""}`}
          type="button"
          onClick={handleUnlabeledOnlyToggle}
          title="When active, already-labeled nodes are excluded from clustering and annotation. Use this to focus the DoI workflow on what still needs labeling."
        >
          {unlabeledOnlyMode ? "Unlabeled Only: On" : "Unlabeled Only"}
        </button>
      </div>
      {unlabeledOnlyMode && labeling.progress.labeled > 0 && (
        <div className={styles.unlabeledOnlyNote}>
          {labeling.progress.labeled} labeled {labeling.progress.labeled === 1 ? "node" : "nodes"} hidden from pipeline
        </div>
      )}

      {/* Input form */}
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.inputContainer}>
          <input
            ref={inputRef}
            type="text"
            value={labeling.inputLabel}
            onChange={(e) => {
              labeling.updateInputLabel(e.target.value);
              setShowAutocomplete(true);
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setShowAutocomplete(false), 200)}
            placeholder="Enter label..."
            className={styles.input}
          />
          <button
            type="submit"
            className={styles.submitBtn}
            disabled={labeling.assignableCount === 0}
            title="Assign label to nodes in the top DoI bucket (DoI >= inset threshold)"
          >
            Assign
          </button>
        </div>

        {/* Error message */}
        {labeling.inputError && (
          <div className={styles.error}>{labeling.inputError}</div>
        )}

        {/* Autocomplete dropdown */}
        {showAutocomplete && filteredLabels.length > 0 && (
          <ul className={styles.autocomplete}>
            {filteredLabels.map((label: string) => (
              <li
                key={label}
                onClick={() => handleAutocompleteClick(label)}
                className={styles.autocompleteItem}
              >
                {label}
              </li>
            ))}
          </ul>
        )}
      </form>

      {/* Label statistics */}
      {labelDistribution.length > 0 && (
        <div className={styles.stats}>
          <h3>Label Distribution</h3>
          <div className={styles.statsList}>
            {visibleLabelDistribution.map(([label, count]: [string, number]) => (
              <div key={label} className={styles.statItem}>
                <span>{label}</span>
                <span className={styles.statCount}>{count}</span>
              </div>
            ))}
          </div>
          {hiddenDistributionCount > 0 && (
            <button
              type="button"
              className={styles.showMoreBtn}
              onClick={() => setShowAllDistributions(true)}
              title="Show full label distribution"
            >
              Show {hiddenDistributionCount} more labels
            </button>
          )}
          {showAllDistributions && labelDistribution.length > MAX_VISIBLE_DISTRIBUTIONS && (
            <button
              type="button"
              className={styles.showMoreBtn}
              onClick={() => setShowAllDistributions(false)}
              title="Collapse label distribution"
            >
              Show fewer labels
            </button>
          )}
        </div>
      )}

      {/* Controls */}
      <div className={styles.controls}>
        <button
          className={styles.controlBtn}
          onClick={startLabeledExport}
          disabled={isExporting || !datasetPath || !hasLabels}
          title="Download dataset with assigned labels injected into the data"
        >
          {isExporting ? `Exporting… ${Math.round(exportProgress)}%` : "Download"}
        </button>
        <button
          className={styles.controlBtn}
          onClick={labeling.resetAllLabels}
          title="Clear all labels (cannot undo)"
        >
          Reset All
        </button>
      </div>
      {exportError && (
        <div className={styles.error} title={exportError}>
          Export failed: {exportError}
        </div>
      )}
    </div>
  );
};
