import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Typography } from '@mui/material';
import React from 'react';
import { initialClusterSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import SettingsSegmentedControl from '../controls/SettingsSegmentedControl';
import { ClusterSettingKey, ClusterSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
  onLeaderShadowToggle: (enabled: boolean) => void;
};

const LeaderLinesSection: React.FC<Props> = ({ cluster, onClusterChange, onLeaderShadowToggle }) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.LEADER_LINES;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Leader Lines</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <LabeledSlider
          label="Outline Thickness"
          value={cluster.leaderOutlineThickness}
          onChange={onClusterChange('leaderOutlineThickness')}
          config={cfg.OUTLINE_THICKNESS}
          defaultValue={initialClusterSettings.leaderOutlineThickness}
        />
        <LabeledSlider
          label="Thickness"
          value={cluster.leaderThickness}
          onChange={onClusterChange('leaderThickness')}
          config={cfg.THICKNESS}
          defaultValue={initialClusterSettings.leaderThickness}
        />
        <LabeledSlider
          label="Shade"
          value={cluster.leaderGray}
          onChange={onClusterChange('leaderGray')}
          config={cfg.SHADE}
          defaultValue={initialClusterSettings.leaderGray}
        />
        <LabeledSlider
          label="Dash Length"
          value={cluster.leaderDashLength}
          onChange={onClusterChange('leaderDashLength')}
          config={cfg.DASH_LENGTH}
          defaultValue={initialClusterSettings.leaderDashLength}
        />
        <LabeledSlider
          label="Dash Gap"
          value={cluster.leaderDashGap}
          onChange={onClusterChange('leaderDashGap')}
          config={cfg.DASH_GAP}
          defaultValue={initialClusterSettings.leaderDashGap}
        />
        <SettingsSegmentedControl<'on' | 'off'>
          label="Drop shadow"
          value={cluster.leaderShadow ? 'on' : 'off'}
          options={[
            { value: 'on',  label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(next) => onLeaderShadowToggle(next === 'on')}
        />
        <LabeledSlider
          label="Shadow intensity"
          value={cluster.leaderShadowIntensity}
          onChange={onClusterChange('leaderShadowIntensity')}
          config={cfg.SHADOW_INTENSITY}
          defaultValue={initialClusterSettings.leaderShadowIntensity}
          disabled={!cluster.leaderShadow}
        />
      </AccordionDetails>
    </Accordion>
  );
};

export default LeaderLinesSection;
