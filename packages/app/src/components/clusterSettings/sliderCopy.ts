/**
 * sliderCopy.ts
 *
 * Single source of truth for setting labels, tooltips, and value formatters
 * that appear on MORE THAN ONE surface (Workflow tab and Advanced panel).
 * Issue #261's two-surface rule: outcome controls on Workflow, mechanism
 * controls in Advanced, and one label per Redux key everywhere — sharing the
 * copy here makes cross-surface drift structurally impossible. Explanatory
 * text lives ONLY in tooltips; the surfaces themselves stay caption-free.
 */

/** Formatter for view-area fractions: 0.024 → "2.4%". */
export const formatViewAreaPercent = (v: number): string => {
  const pct = v * 100;
  return `${pct.toFixed(pct % 1 === 0 ? 0 : 1)}%`;
};

/** Formatter for sliders where 0 disables the feature. */
export const formatOffAtZero = (v: number): string => (v === 0 ? "off" : `${v}`);

/** clusterSettings.maxActiveClusters */
export const BUDGET_LABEL = "Cluster budget";
export const budgetTooltip = (chainRescueBudget: number): string =>
  chainRescueBudget > 0
    ? `Hard cap on annotated clusters (insets and labels); 0 hides all annotations. Up to ${chainRescueBudget} of these slots are reserved for chain fragments during a selection — see "Chain slots".`
    : "Hard cap on annotated clusters (insets and labels); 0 hides all annotations.";

/** clusterSettings.splitThresholdFraction */
export const BASE_SPLIT_LABEL = "Base split size (% of view)";
export const BASE_SPLIT_TOOLTIP =
  "A cluster splits into sub-clusters once its screen footprint exceeds this fraction of the current view area, so the setting behaves the same across screen sizes. During a selection, the chain features can split smaller clusters too.";

/** clusterSettings.chainRescueBudget */
export const CHAIN_SLOTS_LABEL = "Chain slots (reserved)";
export const CHAIN_SLOTS_TOOLTIP =
  "Annotation slots reserved within the cluster budget for chain-rescued fragments along selected trajectories. They displace the lowest-ranked base clusters; unused slots return to the base pool. 0 = off.";

/** clusterSettings.relationInsetBudget */
export const DIFF_BUDGET_LABEL = "Edge inset budget";
export const DIFF_BUDGET_TOOLTIP =
  "Max number of edge (difference) insets shown between annotated clusters, strongest transitions first. 0 hides edge insets entirely.";
