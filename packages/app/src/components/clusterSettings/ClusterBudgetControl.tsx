/**
 * ClusterBudgetControl.tsx
 *
 * The cluster-budget pair — "Cluster budget" slider and the live
 * ActiveClusterReadout — as one shared component, mounted on BOTH the
 * Workflow tab (the 90% surface) and the Advanced panel's ClusterSettings,
 * so the two surfaces can never drift apart (issue #261). All explanation
 * lives in the tooltip; the optional `unfold` (Workflow only) reveals the
 * related sub-sliders via the slider's inline arrow.
 */
import React, { type SyntheticEvent } from "react";
import { initialClusterSettings } from "src/store";
import { CLUSTER_SETTINGS_PANEL_UI } from "src/utils/constants";
import ActiveClusterReadout from "./ActiveClusterReadout";
import LabeledSlider from "./controls/LabeledSlider";
import { BUDGET_LABEL, budgetTooltip, formatOffAtZero } from "./sliderCopy";

type Props = {
  value: number;
  onChange: (event: Event, value: number | number[]) => void;
  onChangeCommitted?: (
    event: Event | SyntheticEvent,
    value: number | number[]
  ) => void;
  /** Current clusterSettings.chainRescueBudget, for the tooltip. */
  chainRescueBudget: number;
  /** Optional sub-controls behind the slider's inline unfold arrow. */
  unfold?: React.ReactNode;
};

const ClusterBudgetControl: React.FC<Props> = ({
  value,
  onChange,
  onChangeCommitted,
  chainRescueBudget,
  unfold,
}) => (
  <>
    <LabeledSlider
      label={BUDGET_LABEL}
      tooltip={budgetTooltip(chainRescueBudget)}
      value={value}
      onChange={onChange}
      onChangeCommitted={onChangeCommitted}
      config={CLUSTER_SETTINGS_PANEL_UI.MAX_ACTIVE_CLUSTERS.SLIDER}
      defaultValue={initialClusterSettings.maxActiveClusters}
      valueLabelFormat={formatOffAtZero}
      unfold={unfold}
    />
    <ActiveClusterReadout />
  </>
);

export default ClusterBudgetControl;
