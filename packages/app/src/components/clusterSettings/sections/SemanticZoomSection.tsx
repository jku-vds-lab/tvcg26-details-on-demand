/**
 * SemanticZoomSection.tsx
 *
 * Accordion section in the Cluster Settings panel that exposes all
 * configurable parameters of the semantic-zoom pipeline.
 *
 * Structure (issue #261): three subgroups so the panel reflects the model —
 *   - Overview: always-active disclosure controls
 *   - Focus & chains: selection-only controls (gap disclosure, chain rescue)
 *   - Advanced: ranking weights + hysteresis, collapsed by default
 * Labels are UI-only; the underlying Redux setting keys are unchanged.
 */
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Divider,
  Typography,
} from "@mui/material";
import React, { type SyntheticEvent } from "react";
import { initialClusterSettings } from "src/store";
import { CLUSTER_SETTINGS_PANEL_UI } from "src/utils/constants";
import LabeledSlider from "../controls/LabeledSlider";
import {
  BASE_SPLIT_LABEL,
  BASE_SPLIT_TOOLTIP,
  CHAIN_SLOTS_LABEL,
  CHAIN_SLOTS_TOOLTIP,
  formatOffAtZero,
  formatViewAreaPercent,
} from "../sliderCopy";
import type { ClusterSettingKey, ClusterSettingsState } from "../types";

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (
    key: ClusterSettingKey
  ) => (event: Event, value: number | number[]) => void;
  localSplitThreshold?: number;
  onSplitThresholdChange?: (event: Event, value: number | number[]) => void;
  onSplitThresholdCommit?: (event: Event | SyntheticEvent, value: number | number[]) => void;
};

const SubgroupHeader: React.FC<{ title: string; caption?: string }> = ({
  title,
  caption,
}) => (
  <>
    <Divider sx={{ mb: 1 }} />
    <Typography variant="caption" sx={{ fontWeight: 600, display: "block" }}>
      {title}
    </Typography>
    {caption && (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1.5 }}
      >
        {caption}
      </Typography>
    )}
    {!caption && <span style={{ display: "block", marginBottom: 12 }} />}
  </>
);

const SemanticZoomSection: React.FC<Props> = ({
  cluster,
  onClusterChange,
  localSplitThreshold,
  onSplitThresholdChange,
  onSplitThresholdCommit,
}) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.SEMANTIC_ZOOM;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Semantic Zoom</Typography>
      </AccordionSummary>
      <AccordionDetails>

        {/* ── Overview: always-active disclosure ─────────────────────────── */}
        <LabeledSlider
          label={BASE_SPLIT_LABEL}
          tooltip={BASE_SPLIT_TOOLTIP}
          value={localSplitThreshold ?? cluster.splitThresholdFraction}
          onChange={onSplitThresholdChange ?? onClusterChange("splitThresholdFraction")}
          onChangeCommitted={onSplitThresholdCommit}
          config={cfg.SPLIT_THRESHOLD_FRACTION}
          defaultValue={initialClusterSettings.splitThresholdFraction}
          valueLabelDisplay="auto"
          valueLabelFormat={formatViewAreaPercent}
        />

        <LabeledSlider
          label="Min annotation size (× base)"
          tooltip="Fraction of the base split size a cluster must cover on screen to be annotated. Chain rescue can bypass this for fragments along selected trajectories."
          value={cluster.labelMinFraction}
          onChange={onClusterChange("labelMinFraction")}
          config={cfg.LABEL_MIN_THRESHOLD_PX}
          defaultValue={initialClusterSettings.labelMinFraction}
          valueLabelDisplay="auto"
        />

        {/* ── Focus & chains: selection-only ─────────────────────────────── */}
        <SubgroupHeader
          title="Focus & chains — selection only"
          caption="Only active while a selection focuses interest; discloses and rescues small clusters along selected trajectories."
        />

        <LabeledSlider
          label="Gap disclosure (px)"
          tooltip="Splits a cluster when its children are separated by at least this much empty screen space — this is why small chain clusters can appear below the base split size. 0 = off."
          value={cluster.gapDisclosurePx}
          onChange={onClusterChange("gapDisclosurePx")}
          config={cfg.GAP_DISCLOSURE_PX}
          defaultValue={initialClusterSettings.gapDisclosurePx}
          valueLabelDisplay="auto"
          valueLabelFormat={formatOffAtZero}
        />

        <LabeledSlider
          label="Chain rescue DoI threshold"
          tooltip="Minimum mean member interest (DoI) for a too-small cluster to stay annotatable along a selected trajectory."
          value={cluster.chainDoiThreshold}
          onChange={onClusterChange("chainDoiThreshold")}
          config={cfg.CHAIN_DOI_THRESHOLD}
          defaultValue={initialClusterSettings.chainDoiThreshold}
          valueLabelDisplay="auto"
        />

        <LabeledSlider
          label={CHAIN_SLOTS_LABEL}
          tooltip={CHAIN_SLOTS_TOOLTIP}
          value={cluster.chainRescueBudget}
          onChange={onClusterChange("chainRescueBudget")}
          config={cfg.CHAIN_RESCUE_BUDGET}
          defaultValue={initialClusterSettings.chainRescueBudget}
          valueLabelDisplay="auto"
          valueLabelFormat={formatOffAtZero}
        />

        <LabeledSlider
          label="DoI density weight"
          tooltip="Ranking boost for clusters whose members are mostly selected (mean DoI). Only applies while the selection's interest is non-uniform."
          value={cluster.doiDensityWeight}
          onChange={onClusterChange("doiDensityWeight")}
          config={cfg.DOI_DENSITY_WEIGHT}
          defaultValue={initialClusterSettings.doiDensityWeight}
          valueLabelDisplay="auto"
        />

        {/* ── Advanced: ranking weights + hysteresis ─────────────────────── */}
        <Accordion sx={{ mt: 1 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              Advanced ranking &amp; hysteresis
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <LabeledSlider
              label="Stability weight"
              tooltip="Ranking weight for HDBSCAN cluster persistence (long-lived clusters)."
              value={cluster.stabilityWeight}
              onChange={onClusterChange("stabilityWeight")}
              config={cfg.STABILITY_WEIGHT}
              defaultValue={initialClusterSettings.stabilityWeight}
              valueLabelDisplay="auto"
            />

            <LabeledSlider
              label="DoI mass weight"
              tooltip="Ranking weight for total member interest (sum of DoI)."
              value={cluster.doiMassWeight}
              onChange={onClusterChange("doiMassWeight")}
              config={cfg.DOI_MASS_WEIGHT}
              defaultValue={initialClusterSettings.doiMassWeight}
              valueLabelDisplay="auto"
            />

            <LabeledSlider
              label="Footprint weight"
              tooltip="Ranking weight for on-screen size."
              value={cluster.footprintWeight}
              onChange={onClusterChange("footprintWeight")}
              config={cfg.FOOTPRINT_WEIGHT}
              defaultValue={initialClusterSettings.footprintWeight}
              valueLabelDisplay="auto"
            />

            <LabeledSlider
              label="Hysteresis activate (×)"
              tooltip="Border-score multiplier a new cluster must exceed to activate (suppresses label flicker)."
              value={cluster.hysteresisActivateFactor}
              onChange={onClusterChange("hysteresisActivateFactor")}
              config={cfg.HYSTERESIS_ACTIVATE}
              defaultValue={initialClusterSettings.hysteresisActivateFactor}
              valueLabelDisplay="auto"
            />

            <LabeledSlider
              label="Hysteresis deactivate (×)"
              tooltip="Border-score multiplier below which an active cluster deactivates."
              value={cluster.hysteresisDeactivateFactor}
              onChange={onClusterChange("hysteresisDeactivateFactor")}
              config={cfg.HYSTERESIS_DEACTIVATE}
              defaultValue={initialClusterSettings.hysteresisDeactivateFactor}
              valueLabelDisplay="auto"
            />
          </AccordionDetails>
        </Accordion>

      </AccordionDetails>
    </Accordion>
  );
};

export default SemanticZoomSection;
