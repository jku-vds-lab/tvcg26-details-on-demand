import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SyncIcon from '@mui/icons-material/Sync';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Button,
  Typography,
} from '@mui/material';
import React from 'react';
import { initialClusterSettings } from 'src/store';
import { CLUSTER_SETTINGS_PANEL_UI } from 'src/utils/constants';
import LabeledSlider from '../controls/LabeledSlider';
import SettingsSegmentedControl from '../controls/SettingsSegmentedControl';
import type { ClusterSettingKey, ClusterSettingsState } from '../types';

type Props = {
  cluster: ClusterSettingsState;
  onClusterChange: (key: ClusterSettingKey) => (event: Event, value: number | number[]) => void;
  onRelationLeaderWidthToggle: (enabled: boolean) => void;
  onRelationArrowSizeRange: (event: Event, value: number | number[]) => void;
  onRelationLeaderShadowToggle: (enabled: boolean) => void;
  onSyncRelationLeaders: () => void;
};

const RelationLeadersSection: React.FC<Props> = ({
  cluster,
  onClusterChange,
  onRelationLeaderWidthToggle,
  onRelationArrowSizeRange,
  onRelationLeaderShadowToggle,
  onSyncRelationLeaders,
}) => {
  const cfg = CLUSTER_SETTINGS_PANEL_UI.RELATION_LEADERS;
  const leaderCfg = CLUSTER_SETTINGS_PANEL_UI.LEADER_LINES;

  return (
    <Accordion>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle2">Relation Leaders</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <SettingsSegmentedControl<'on' | 'off'>
          label="Width encodes strength"
          value={cluster.relationLeaderWidthEncodesStrength ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Off (arrow only)' },
            { value: 'on',  label: 'On (arrow + width)' },
          ]}
          onChange={(next) => onRelationLeaderWidthToggle(next === 'on')}
          helperText="Off: line width is constant; direction strength is shown by arrowhead size only. On: line width also scales with strength (floor = Min Width)."
        />
        <LabeledSlider
          label="Arrow Size (min / max)"
          value={[cluster.relationArrowMinSize, cluster.relationArrowMaxSize]}
          onChange={onRelationArrowSizeRange}
          config={cfg.ARROW_SIZE_RANGE}
          defaultValue={[initialClusterSettings.relationArrowMinSize, initialClusterSettings.relationArrowMaxSize]}
          disableSwap
        />
        <LabeledSlider
          label="Min Width (strength=0)"
          value={cluster.relationLeaderMinWidth}
          onChange={onClusterChange('relationLeaderMinWidth')}
          config={cfg.LEADER_MIN_WIDTH}
          defaultValue={initialClusterSettings.relationLeaderMinWidth}
          disabled={!cluster.relationLeaderWidthEncodesStrength}
        />
        <LabeledSlider
          label="Thickness"
          value={cluster.relationLeaderThickness}
          onChange={onClusterChange('relationLeaderThickness')}
          config={leaderCfg.THICKNESS}
          defaultValue={initialClusterSettings.relationLeaderThickness}
        />
        <LabeledSlider
          label="Outline Thickness"
          value={cluster.relationLeaderOutlineThickness}
          onChange={onClusterChange('relationLeaderOutlineThickness')}
          config={leaderCfg.OUTLINE_THICKNESS}
          defaultValue={initialClusterSettings.relationLeaderOutlineThickness}
        />
        <LabeledSlider
          label="Shade"
          value={cluster.relationLeaderGray}
          onChange={onClusterChange('relationLeaderGray')}
          config={leaderCfg.SHADE}
          defaultValue={initialClusterSettings.relationLeaderGray}
        />
        <LabeledSlider
          label="Dash Length"
          value={cluster.relationLeaderDashLength}
          onChange={onClusterChange('relationLeaderDashLength')}
          config={leaderCfg.DASH_LENGTH}
          defaultValue={initialClusterSettings.relationLeaderDashLength}
        />
        <LabeledSlider
          label="Dash Gap"
          value={cluster.relationLeaderDashGap}
          onChange={onClusterChange('relationLeaderDashGap')}
          config={leaderCfg.DASH_GAP}
          defaultValue={initialClusterSettings.relationLeaderDashGap}
        />
        <SettingsSegmentedControl<'on' | 'off'>
          label="Drop shadow"
          value={cluster.relationLeaderShadow ? 'on' : 'off'}
          options={[
            { value: 'on',  label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(next) => onRelationLeaderShadowToggle(next === 'on')}
        />
        <LabeledSlider
          label="Shadow intensity"
          value={cluster.relationLeaderShadowIntensity}
          onChange={onClusterChange('relationLeaderShadowIntensity')}
          config={cfg.SHADOW_INTENSITY}
          defaultValue={initialClusterSettings.relationLeaderShadowIntensity}
          disabled={!cluster.relationLeaderShadow}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<SyncIcon />}
          onClick={onSyncRelationLeaders}
          sx={{ mt: 0.5 }}
          fullWidth
        >
          Match Leader Lines
        </Button>
      </AccordionDetails>
    </Accordion>
  );
};

export default RelationLeadersSection;
