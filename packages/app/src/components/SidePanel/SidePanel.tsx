import { Box } from '@mui/material';
import React from 'react';
import type { DatasetEntry } from '../../datasets/catalog';
import type { FeatureSearchDeps } from '../../hooks/useFeatureSearch';
import type { Dataset } from '../../types/datasetTypes';
import type { KnnGraph } from '../../types/graphTypes';
import type { SliderSettings } from '../InterestTabSliders';
import SidePanelContent from './SidePanelContent';
import SidePanelTabs from './SidePanelTabs';

interface SidePanelProps {
  activeTab: number;
  showLabelingTab: boolean;
  /** Embedded (anywidget) mode: the dataset comes from the host, so the selector tab is hidden. */
  hideDatasetTab?: boolean;
  onTabChange: (event: React.SyntheticEvent, newValue: number) => void;
  tabButtonWidth: number;
  sidePanelContentWidth: number;
  handleDatasetSelected: (dataset: Dataset) => void;
  /** Issue #315 G4 slice 2: fired at CLICK time when a predefined internal
   * dataset is picked (before its download) so the aggregate-first base can
   * boot early. Optional — absent in embedded/widget mode. */
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

const SidePanel: React.FC<SidePanelProps> = ({
  activeTab,
  showLabelingTab,
  hideDatasetTab = false,
  onTabChange,
  tabButtonWidth,
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
  const panelWidth = tabButtonWidth + sidePanelContentWidth;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'row', position: 'relative', width: panelWidth }}>
      <SidePanelTabs activeTab={activeTab} showLabelingTab={showLabelingTab} hideDatasetTab={hideDatasetTab} onTabChange={onTabChange} tabButtonWidth={tabButtonWidth} />
      <SidePanelContent
        activeTab={activeTab}
        showLabelingTab={showLabelingTab}
        hideDatasetTab={hideDatasetTab}
        sidePanelContentWidth={sidePanelContentWidth}
        handleDatasetSelected={handleDatasetSelected}
        onPredefinedPickStart={onPredefinedPickStart}
        sliderSettings={sliderSettings}
        handlePropagationSliderChange={handlePropagationSliderChange}
        handlePropagationSliderFinalChange={handlePropagationSliderFinalChange}
        featureSearchDeps={featureSearchDeps}
        isReclustering={isReclustering}
        applyProjection={applyProjection}
        restoreOriginalProjection={restoreOriginalProjection}
        canRestoreProjection={canRestoreProjection}
      />
    </Box>
  );
};

// Memoized: App re-renders on every settled zoom tick (zoomTransform state);
// all props here are identity-stable during zoom, so the MUI panel tree
// (the dominant sx-recompute cost in zoom profiles) skips those re-renders.
export default React.memo(SidePanel);
