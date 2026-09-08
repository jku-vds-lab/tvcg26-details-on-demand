import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Box,
    Divider,
    Typography,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import React from 'react';
import type { FeatureSearchDeps } from '../../hooks/useFeatureSearch';
import { initialClusterSettings } from '../../store';
import { CLUSTER_SETTINGS_PANEL_UI } from '../../utils/constants';
import FeatureSearchInput from '../FeatureSearchInput';
import InterestTabSliders, { SliderSettings } from '../InterestTabSliders';
import SelectionModeToggles from '../SelectionModeToggles';
import ClusterBudgetControl from '../clusterSettings/ClusterBudgetControl';
import LabeledSlider from '../clusterSettings/controls/LabeledSlider';
import {
    BASE_SPLIT_LABEL,
    BASE_SPLIT_TOOLTIP,
    CHAIN_SLOTS_LABEL,
    CHAIN_SLOTS_TOOLTIP,
    DIFF_BUDGET_LABEL,
    DIFF_BUDGET_TOOLTIP,
    formatOffAtZero,
    formatViewAreaPercent,
} from '../clusterSettings/sliderCopy';
import { useClusterSettingsController } from '../clusterSettings/useClusterSettingsController';

interface WorkflowTabPanelProps {
  sliderSettings: SliderSettings;
  handlePropagationSliderChange: (newSettings: SliderSettings) => void;
  handlePropagationSliderFinalChange: (newSettings: SliderSettings) => void;
  featureSearchDeps: FeatureSearchDeps;
}

const sectionTitleSx = {
  fontWeight: 600,
  mb: 0.25,
} as const;

const sectionHintSx = {
  color: 'text.secondary',
  mb: 1.5,
} as const;

const accordionCardSx: SxProps<Theme> = {
  borderRadius: 2,
  border: 'none',
  boxShadow: 'none',
  '&:before': { display: 'none' },
};

const WorkflowTabPanel: React.FC<WorkflowTabPanelProps> = ({
  sliderSettings,
  handlePropagationSliderChange,
  handlePropagationSliderFinalChange,
  featureSearchDeps,
}) => {
  const {
    cluster,
    localMaxActive,
    localSplitThreshold,
    handleMaxActiveChange,
    handleMaxActiveCommit,
    handleSplitThresholdChange,
    handleSplitThresholdCommit,
    handleClusterChange,
  } = useClusterSettingsController();

  return (
    <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Accordion defaultExpanded disableGutters sx={accordionCardSx}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 1, py: 1 }}>
          <Box>
            <Typography variant="subtitle1" sx={sectionTitleSx}>
              Core Workflow
            </Typography>
            <Typography variant="body2" sx={{ ...sectionHintSx, mb: 0 }}>
              Controls to search features and tune interest propagation.
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 1, pb: 0, '& > *:last-child': { mb: 0 } }}>
          <FeatureSearchInput featureSearchDeps={featureSearchDeps} compact />

          <Divider sx={{ my: 1.5 }} />

          <Box sx={{ mb: 1.5 }}>
            <SelectionModeToggles />
          </Box>

          <InterestTabSliders
            initialProximity={sliderSettings.proximitySlider}
            initialPast={sliderSettings.pastSlider}
            initialFuture={sliderSettings.futureSlider}
            initialDoiThresholds={[
              sliderSettings.grayOutDoiThreshold,
              sliderSettings.annotationDoiThreshold,
              sliderSettings.insetDoiThreshold,
            ]}
            onSliderChange={handlePropagationSliderChange}
            onSliderChangeCommitted={handlePropagationSliderFinalChange}
            featureSearchDeps={featureSearchDeps}
            hideFeatureSearch
            compact
          />

          <Divider sx={{ my: 1.5 }} />

          <ClusterBudgetControl
            value={localMaxActive}
            onChange={handleMaxActiveChange}
            onChangeCommitted={handleMaxActiveCommit}
            chainRescueBudget={cluster.chainRescueBudget}
            unfold={
              <>
                <LabeledSlider
                  label={BASE_SPLIT_LABEL}
                  tooltip={BASE_SPLIT_TOOLTIP}
                  value={localSplitThreshold}
                  onChange={handleSplitThresholdChange}
                  onChangeCommitted={handleSplitThresholdCommit}
                  config={CLUSTER_SETTINGS_PANEL_UI.SEMANTIC_ZOOM.SPLIT_THRESHOLD_FRACTION}
                  defaultValue={initialClusterSettings.splitThresholdFraction}
                  valueLabelFormat={formatViewAreaPercent}
                />
                <LabeledSlider
                  label={CHAIN_SLOTS_LABEL}
                  tooltip={CHAIN_SLOTS_TOOLTIP}
                  value={cluster.chainRescueBudget}
                  onChange={handleClusterChange('chainRescueBudget')}
                  config={CLUSTER_SETTINGS_PANEL_UI.SEMANTIC_ZOOM.CHAIN_RESCUE_BUDGET}
                  defaultValue={initialClusterSettings.chainRescueBudget}
                  valueLabelFormat={formatOffAtZero}
                />
              </>
            }
          />

          <LabeledSlider
            label={DIFF_BUDGET_LABEL}
            tooltip={DIFF_BUDGET_TOOLTIP}
            value={cluster.relationInsetBudget}
            onChange={handleClusterChange('relationInsetBudget')}
            config={CLUSTER_SETTINGS_PANEL_UI.EDGE_ANNOTATIONS.BUDGET}
            defaultValue={initialClusterSettings.relationInsetBudget}
            valueLabelFormat={formatOffAtZero}
          />
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default WorkflowTabPanel;
