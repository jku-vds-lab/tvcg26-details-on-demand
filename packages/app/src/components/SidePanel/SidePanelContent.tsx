import { Box, Paper } from '@mui/material';
import { alpha } from '@mui/material/styles';
import React from 'react';
import { useSelector } from 'react-redux';
import type { DatasetEntry } from '../../datasets/catalog';
import type { FeatureSearchDeps } from '../../hooks/useFeatureSearch';
import type { RootState } from '../../store';
import type { Dataset } from '../../types/datasetTypes';

import AnnotationLabelSettings from '../AnnotationLabelSettings';
import ColorEncodingSettings from '../ColorEncodingSettings';
import DatasetTabPanel from '../DatasetTabPanel';
import InlineBusyBadge from '../InlineBusyBadge';
import { SliderSettings } from '../InterestTabSliders';
import NodeTrajectorySettings from '../NodeTrajectorySettings';
import { LabelingPanelContainer } from '../labeling/LabelingPanelContainer';
import type { KnnGraph } from '../../types/graphTypes';
import AdvancedSettingsPanel from './AdvancedSettingsPanel';
import ProjectionTabPanel from './ProjectionTabPanel';
import WorkflowTabPanel from './WorkflowTabPanel';

interface SidePanelContentProps {
  activeTab: number;
  showLabelingTab: boolean;
  hideDatasetTab?: boolean;
  sidePanelContentWidth: number;
  handleDatasetSelected: (dataset: Dataset) => void;
  /** Issue #315 G4 slice 2: fired at click time for early aggregate boot. */
  onPredefinedPickStart?: (entry: DatasetEntry) => void;
  sliderSettings: SliderSettings;
  handlePropagationSliderChange: (newSettings: SliderSettings) => void;
  handlePropagationSliderFinalChange: (newSettings: SliderSettings) => void;
  featureSearchDeps: FeatureSearchDeps;
  isReclustering: boolean;
  applyProjection: (coords: Float32Array, knnGraph: KnnGraph) => void;
  restoreOriginalProjection: () => void;
  canRestoreProjection: boolean;
}

const SidePanelContent: React.FC<SidePanelContentProps> = ({
  activeTab,
  showLabelingTab,
  hideDatasetTab = false,
  sidePanelContentWidth,
  handleDatasetSelected,
  onPredefinedPickStart,
  sliderSettings,
  handlePropagationSliderChange,
  handlePropagationSliderFinalChange,
  featureSearchDeps,
  isReclustering,
  applyProjection,
  restoreOriginalProjection,
  canRestoreProjection,
}) => {
  const sidePanelBgColor = useSelector((s: RootState) => s.visualizationSettings.sidePanelBgColor);

  return (
    // id: stable anchor for the deep-link demo spotlight (deepLinkDemo.ts).
    <Box id="side-panel-content" sx={{ width: sidePanelContentWidth, borderRight: (theme) => `1px solid ${theme.palette.divider}`, overflow: 'hidden', backgroundColor: sidePanelBgColor }}>
      <Paper
        sx={{
          height: '100%',
          overflow: 'auto',
          position: 'relative',
          backgroundColor: sidePanelBgColor,
          scrollbarColor: (theme) => `${theme.palette.divider} ${sidePanelBgColor}`,
          '&::-webkit-scrollbar': {
            width: 10,
          },
          '&::-webkit-scrollbar-track': {
            backgroundColor: sidePanelBgColor,
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: 'rgba(120,120,120,0.45)',
            borderRadius: 8,
          },
          '& .MuiPaper-outlined': {
            backgroundColor: alpha(sidePanelBgColor, 0.72),
            borderColor: (theme) => alpha(theme.palette.divider, 0.65),
          },
        }}
      >
        <Box sx={{ position: 'absolute', top: 4, right: 8 }}>
          <InlineBusyBadge open={isReclustering} label="Updating clusters…" />
        </Box>

        {activeTab !== 2 && (
          <Box sx={{ display: 'none' }} aria-hidden>
            <ColorEncodingSettings nested hideAccordion />
          </Box>
        )}

        {activeTab === 0 && (
          <WorkflowTabPanel
            sliderSettings={sliderSettings}
            handlePropagationSliderChange={handlePropagationSliderChange}
            handlePropagationSliderFinalChange={handlePropagationSliderFinalChange}
            featureSearchDeps={featureSearchDeps}
          />
        )}

        {!hideDatasetTab && (
          <Box sx={{ display: activeTab === 1 ? 'block' : 'none', height: '100%' }}>
            <DatasetTabPanel onDataSelected={handleDatasetSelected} onPredefinedPickStart={onPredefinedPickStart} />
          </Box>
        )}

        {activeTab === 2 && (
          <Box sx={{
            p: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            '& .MuiAccordion-root': {
              boxShadow: 'none',
              border: 'none',
              '&:before': { display: 'none' },
            },
            '& .MuiAccordionSummary-root': { px: 1 },
            '& .MuiAccordionDetails-root': { px: 1 },
          }}>
            <ColorEncodingSettings defaultExpanded />
            <AnnotationLabelSettings />
            <NodeTrajectorySettings showColorEncoding={false} defaultExpanded={false} />
          </Box>
        )}

        {activeTab === 3 && <AdvancedSettingsPanel />}

        {showLabelingTab && activeTab === 4 && <LabelingPanelContainer embedded />}

        {/* Kept mounted (like the Dataset tab) so a running projection
            survives tab switches. */}
        <Box sx={{ display: activeTab === 5 ? 'block' : 'none' }}>
          <ProjectionTabPanel
            applyProjection={applyProjection}
            restoreOriginalProjection={restoreOriginalProjection}
            canRestoreProjection={canRestoreProjection}
          />
        </Box>
      </Paper>
    </Box>
  );
};

export default SidePanelContent;
