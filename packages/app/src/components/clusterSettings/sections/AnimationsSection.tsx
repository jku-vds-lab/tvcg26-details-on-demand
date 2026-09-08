import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import React from 'react';
import { initialClusterSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import type { ClusterSettingKey, ClusterSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
  onEaseChange: (ease: string) => void;
};

const AnimationsSection: React.FC<Props> = ({ cluster, onClusterChange, onEaseChange }) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.ANIMATIONS;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Animations</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <LabeledSlider
          label="Duration (seconds)"
          value={cluster.duration}
          onChange={onClusterChange('duration')}
          config={cfg.DURATION_SECONDS}
          defaultValue={initialClusterSettings.duration}
        />
        <FormControl fullWidth>
          <InputLabel id="ease-select-label">Easing</InputLabel>
          <Select
            labelId="ease-select-label"
            value={cluster.ease}
            label="Easing"
            onChange={(e) => onEaseChange(e.target.value as string)}
          >
            <MenuItem value="linear">linear</MenuItem>
            <MenuItem value="easeIn">easeIn</MenuItem>
            <MenuItem value="easeOut">easeOut</MenuItem>
            {/* … other easing options … */}
          </Select>
        </FormControl>
      </AccordionDetails>
    </Accordion>
  );
};

export default AnimationsSection;
