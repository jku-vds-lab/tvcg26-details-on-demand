import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Typography,
} from '@mui/material';
import React from 'react';
import { initialClusterSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import { DIFF_BUDGET_LABEL, DIFF_BUDGET_TOOLTIP, formatOffAtZero } from '../sliderCopy';
import type { ClusterSettingKey, ClusterSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
};

const EdgeAnnotationsSection: React.FC<Props> = ({
  cluster,
  onClusterChange,
}) => (
  <Accordion>
    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
      <Typography variant="subtitle2">Edge Annotations</Typography>
    </AccordionSummary>
    <AccordionDetails>
      <LabeledSlider
        label={DIFF_BUDGET_LABEL}
        tooltip={DIFF_BUDGET_TOOLTIP}
        value={cluster.relationInsetBudget}
        onChange={onClusterChange('relationInsetBudget')}
        config={CLUSTER_SETTINGS_PANEL_UI.EDGE_ANNOTATIONS.BUDGET}
        defaultValue={initialClusterSettings.relationInsetBudget}
        valueLabelFormat={formatOffAtZero}
      />
      <LabeledSlider
        label="Hover scale"
        value={cluster.insetHoverScale}
        onChange={onClusterChange('insetHoverScale')}
        config={CLUSTER_SETTINGS_PANEL_UI.EDGE_ANNOTATIONS.HOVER_SCALE}
        defaultValue={initialClusterSettings.insetHoverScale}
      />
      <LabeledSlider
        label="Spotlight emphasis"
        value={cluster.spotlightEmphasisScale}
        onChange={onClusterChange('spotlightEmphasisScale')}
        config={CLUSTER_SETTINGS_PANEL_UI.EDGE_ANNOTATIONS.SPOTLIGHT_EMPHASIS}
        defaultValue={initialClusterSettings.spotlightEmphasisScale}
      />
    </AccordionDetails>
  </Accordion>
);

export default EdgeAnnotationsSection;
