import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Typography } from '@mui/material';
import React, { useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SliderConfig } from 'src/utils/constants';
import { RootState, initialVisualizationSettings, updateSettings } from '../store';
import LabeledSlider from './clusterSettings/controls/LabeledSlider';
import SettingsSegmentedControl from './clusterSettings/controls/SettingsSegmentedControl';

type OptimizationWeightKey =
  | 'optimizationWeightD'
  | 'optimizationWeightM'
  | 'optimizationWeightL'
  | 'optimizationWeightOS'
  | 'optimizationWeightDS'
  | 'optimizationWeightOI'
  | 'optimizationWeightDI'
  | 'optimizationWeightRTree'
  | 'hardInsetOverlapPenalty'
  | 'hardLeaderCrossingPenalty'
  | 'hardScatterOverlapPenalty'
  | 'hardForeignContourOverlapPenalty'
  | 'contourTargetRadiusMultiplier';

type AnnealingKey =
  | 'insetOptimizationIterations'
  | 'insetOptimizationCoolingRate'
  | 'insetOptimizationJitterStrength';

type PositioningMode = 'annealing' | 'cartographic';

type OptimizationSettingKey = OptimizationWeightKey | AnnealingKey;

const WEIGHT_SLIDER_CONFIG: SliderConfig = {
  step: 0.1,
  min: 0,
  max: 5,
  marks: [{ value: 0, label: '0' }, { value: 5, label: '5' }],
};

const HARD_PENALTY_SLIDER_CONFIG: SliderConfig = {
  step: 100,
  min: 0,
  max: 10000,
  marks: [{ value: 0, label: '0' }, { value: 5000, label: '5k' }, { value: 10000, label: '10k' }],
};

const CONTOUR_TARGET_SLIDER_CONFIG: SliderConfig = {
  step: 0.1,
  min: 0.5,
  max: 4,
  marks: [{ value: 0.5, label: '0.5' }, { value: 1.8, label: '1.8' }, { value: 4, label: '4' }],
};

const weightOptions: Array<{ label: string; key: OptimizationWeightKey; config: SliderConfig }> = [
  { label: 'Distance Weight', key: 'optimizationWeightD', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Movement Weight', key: 'optimizationWeightM', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Leader Weight', key: 'optimizationWeightL', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Overlap Source Weight', key: 'optimizationWeightOS', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Distance Contour Weight', key: 'optimizationWeightDS', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Overlap Inset Weight', key: 'optimizationWeightOI', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Distance Inset Weight', key: 'optimizationWeightDI', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Overlap Scatterplot Weight', key: 'optimizationWeightRTree', config: WEIGHT_SLIDER_CONFIG },
  { label: 'Hard Inset Overlap Penalty', key: 'hardInsetOverlapPenalty', config: HARD_PENALTY_SLIDER_CONFIG },
  { label: 'Hard Leader Crossing Penalty', key: 'hardLeaderCrossingPenalty', config: HARD_PENALTY_SLIDER_CONFIG },
  { label: 'Hard Scatter Overlap Penalty', key: 'hardScatterOverlapPenalty', config: HARD_PENALTY_SLIDER_CONFIG },
  { label: 'Hard Foreign Contour Overlap Penalty', key: 'hardForeignContourOverlapPenalty', config: HARD_PENALTY_SLIDER_CONFIG },
  { label: 'Contour Target Radius (x inset radius)', key: 'contourTargetRadiusMultiplier', config: CONTOUR_TARGET_SLIDER_CONFIG },
];

const annealingOptions: Array<{ label: string; key: AnnealingKey; config: SliderConfig }> = [
  {
    label: 'Iterations',
    key: 'insetOptimizationIterations',
    config: { min: 50, max: 4000, step: 50, marks: [{ value: 50, label: '50' }, { value: 4000, label: '4000' }] },
  },
  {
    label: 'Cooling Rate',
    key: 'insetOptimizationCoolingRate',
    config: { min: 0.7, max: 0.999, step: 0.001, marks: [{ value: 0.7, label: '0.7' }, { value: 0.999, label: '0.999' }] },
  },
  {
    label: 'Jitter Strength',
    key: 'insetOptimizationJitterStrength',
    config: { min: 0, max: 80, step: 1, marks: [{ value: 0, label: '0' }, { value: 80, label: '80' }] },
  },
];

const WEIGHT_DEFAULTS: Pick<RootState['visualizationSettings'], OptimizationWeightKey> = {
  optimizationWeightD: initialVisualizationSettings.optimizationWeightD,
  optimizationWeightM: initialVisualizationSettings.optimizationWeightM,
  optimizationWeightL: initialVisualizationSettings.optimizationWeightL,
  optimizationWeightOS: initialVisualizationSettings.optimizationWeightOS,
  optimizationWeightDS: initialVisualizationSettings.optimizationWeightDS,
  optimizationWeightOI: initialVisualizationSettings.optimizationWeightOI,
  optimizationWeightDI: initialVisualizationSettings.optimizationWeightDI,
  optimizationWeightRTree: initialVisualizationSettings.optimizationWeightRTree,
  hardInsetOverlapPenalty: initialVisualizationSettings.hardInsetOverlapPenalty,
  hardLeaderCrossingPenalty: initialVisualizationSettings.hardLeaderCrossingPenalty,
  hardScatterOverlapPenalty: initialVisualizationSettings.hardScatterOverlapPenalty,
  hardForeignContourOverlapPenalty: initialVisualizationSettings.hardForeignContourOverlapPenalty,
  contourTargetRadiusMultiplier: initialVisualizationSettings.contourTargetRadiusMultiplier,
};

const accordionCardSx = {
  borderRadius: 2,
  '&:before': { display: 'none' },
  '&.Mui-expanded': { margin: 0 },
} as const;

const InsetOptimizationSettings: React.FC = () => {
  const dispatch = useDispatch();
  const s = useSelector((state: RootState) => state.visualizationSettings);
  const isAnnealingMode = s.clusterPositioningMode === 'annealing';

  const handleChange = useCallback(
    (key: OptimizationSettingKey) => (_: Event, val: number | number[]) => {
      const v = Array.isArray(val) ? val[0] : val;
      dispatch(updateSettings({ [key]: v }));
    },
    [dispatch]
  );

  const resetWeights = () => {
    dispatch(updateSettings(WEIGHT_DEFAULTS));
  };

  const handlePositioningModeChange = useCallback(
    (nextMode: PositioningMode) => {
      dispatch(updateSettings({ clusterPositioningMode: nextMode }));
    },
    [dispatch]
  );

  return (
    <Accordion disableGutters sx={accordionCardSx}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Inset Optimization</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Accordion disableGutters sx={{ ...accordionCardSx, mb: 1 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">Positioning Strategy</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <SettingsSegmentedControl<PositioningMode>
              label="Label Placement Mode"
              value={s.clusterPositioningMode}
              options={[
                { value: 'annealing', label: 'Annealed labeling' },
                { value: 'cartographic', label: 'Direct labeling' },
              ]}
              onChange={handlePositioningModeChange}
              helperText="Direct labeling anchors annotations and insets at their cluster sources and skips annealing."
            />
          </AccordionDetails>
        </Accordion>

        <Accordion disableGutters sx={{ ...accordionCardSx, mb: 1 }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">Cost Function</Typography>
          </AccordionSummary>
          <AccordionDetails>
            {weightOptions.map(({ label, key, config }) => (
              <LabeledSlider
                key={key}
                label={label}
                value={s[key]}
                onChange={handleChange(key)}
                config={config}
                defaultValue={initialVisualizationSettings[key]}
              />
            ))}
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1 }}>
              <Button variant="outlined" onClick={resetWeights}>Reset Weights</Button>
            </Box>
          </AccordionDetails>
        </Accordion>

        <Accordion disableGutters sx={accordionCardSx}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle2">Simulated Annealing</Typography>
          </AccordionSummary>
          <AccordionDetails>
            {!isAnnealingMode && (
              <Typography variant="caption" sx={{ display: 'block', mb: 1, color: 'text.secondary' }}>
                Annealing parameters are currently inactive because Direct labeling is selected.
              </Typography>
            )}
            {annealingOptions.map(({ label, key, config }) => (
              <LabeledSlider
                key={key}
                label={label}
                value={s[key]}
                onChange={handleChange(key)}
                config={config}
                defaultValue={initialVisualizationSettings[key]}
                disabled={!isAnnealingMode}
              />
            ))}
          </AccordionDetails>
        </Accordion>
      </AccordionDetails>
    </Accordion>
  );
};

export default InsetOptimizationSettings;
