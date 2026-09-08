import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Typography } from '@mui/material';
import React from 'react';
import { initialClusterSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import { ClusterSettingKey, ClusterSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
};

const ContoursSection: React.FC<Props> = ({ cluster, onClusterChange }) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.CONTOURS;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Contours</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <LabeledSlider
          label="Thickness"
          value={cluster.contourThickness}
          onChange={onClusterChange('contourThickness')}
          config={cfg.THICKNESS}
          defaultValue={initialClusterSettings.contourThickness}
        />
        <LabeledSlider
          label="Shade"
          value={cluster.contourGray}
          onChange={onClusterChange('contourGray')}
          config={cfg.SHADE}
          defaultValue={initialClusterSettings.contourGray}
        />
        <LabeledSlider
          label="Stippling"
          value={cluster.contourStippling}
          onChange={onClusterChange('contourStippling')}
          config={cfg.STIPPLING}
          defaultValue={initialClusterSettings.contourStippling}
        />
        <LabeledSlider
          label="Outline Thickness"
          value={cluster.contourOutlineThickness}
          onChange={onClusterChange('contourOutlineThickness')}
          config={cfg.OUTLINE_THICKNESS}
          defaultValue={initialClusterSettings.contourOutlineThickness}
        />
        <LabeledSlider
          label="Offset (factor)"
          value={cluster.hullPaddingFactor}
          onChange={onClusterChange('hullPaddingFactor')}
          config={cfg.OFFSET_FACTOR}
          defaultValue={initialClusterSettings.hullPaddingFactor}
        />
        <LabeledSlider
          label="Offset (px)"
          value={cluster.hullPaddingPx}
          onChange={onClusterChange('hullPaddingPx')}
          config={cfg.OFFSET_PX}
          defaultValue={initialClusterSettings.hullPaddingPx}
        />
      </AccordionDetails>
    </Accordion>
  );
};

export default ContoursSection;
