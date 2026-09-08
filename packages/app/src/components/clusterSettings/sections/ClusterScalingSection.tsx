import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Typography } from '@mui/material';
import React from 'react';
import { initialClusterSettings, initialVisualizationSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import { ClusterSettingKey, ClusterSettingsState, VisualizationSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  viz: VisualizationSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
  onNodeInsetScaleRange: (event: Event, value: number | number[]) => void;
  onEdgeInsetScaleRange: (event: Event, value: number | number[]) => void;
  onEdgeScaleExponentChange: (event: Event, value: number | number[]) => void;
};

const ClusterScalingSection: React.FC<Props> = ({
  cluster,
  viz,
  onClusterChange,
  onNodeInsetScaleRange,
  onEdgeInsetScaleRange,
  onEdgeScaleExponentChange,
}) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.CLUSTER_SCALING;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Cluster Scaling</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <LabeledSlider
          label="Node Inset Size Range"
          value={[cluster.insetMinScale, cluster.insetMaxScale]}
          onChange={onNodeInsetScaleRange}
          config={cfg.NODE_INSET_SIZE_RANGE}
          defaultValue={[initialClusterSettings.insetMinScale, initialClusterSettings.insetMaxScale]}
        />
        <LabeledSlider
          label="Node Scale Exponent"
          value={cluster.scaleExponent}
          onChange={onClusterChange('scaleExponent')}
          config={cfg.NODE_SCALE_EXPONENT}
          defaultValue={initialClusterSettings.scaleExponent}
        />
        <LabeledSlider
          label="Edge Inset Size Range"
          value={[viz.edgeInsetMinScale, viz.edgeInsetMaxScale]}
          onChange={onEdgeInsetScaleRange}
          config={cfg.EDGE_INSET_SIZE_RANGE}
          defaultValue={[initialVisualizationSettings.edgeInsetMinScale, initialVisualizationSettings.edgeInsetMaxScale]}
        />
        <LabeledSlider
          label="Edge Scale Exponent"
          value={viz.edgeScaleExponent}
          onChange={onEdgeScaleExponentChange}
          config={cfg.EDGE_SCALE_EXPONENT}
          defaultValue={initialVisualizationSettings.edgeScaleExponent}
        />
      </AccordionDetails>
    </Accordion>
  );
};

export default ClusterScalingSection;
