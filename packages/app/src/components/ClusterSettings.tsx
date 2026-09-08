import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Typography,
} from '@mui/material';
import React from 'react';

import ClusterBudgetControl from './clusterSettings/ClusterBudgetControl';
import AnimationsSection from './clusterSettings/sections/AnimationsSection';
import ClusterScalingSection from './clusterSettings/sections/ClusterScalingSection';
import ContoursSection from './clusterSettings/sections/ContoursSection';
import EdgeAnnotationsSection from './clusterSettings/sections/EdgeAnnotationsSection';
import LeaderLinesSection from './clusterSettings/sections/LeaderLinesSection';
import RelationLeadersSection from './clusterSettings/sections/RelationLeadersSection';
import SemanticZoomSection from './clusterSettings/sections/SemanticZoomSection';
import { useClusterSettingsController } from './clusterSettings/useClusterSettingsController';

const ClusterSettings: React.FC = () => {
  const {
    cluster,
    viz,
    localMaxActive,
    localSplitThreshold,
    handleMaxActiveChange,
    handleMaxActiveCommit,
    handleSplitThresholdChange,
    handleSplitThresholdCommit,
    handleClusterChange,
    handleScaleRange,
    handleEdgeInsetScaleRange,
    handleEdgeScaleExponentChange,
    handleEaseChange,
    handleRelationLeaderWidthToggle,
    handleRelationArrowSizeRange,
    handleLeaderShadowToggle,
    handleRelationLeaderShadowToggle,
    handleSyncRelationLeaders,
  } = useClusterSettingsController();

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Clusters</Typography>
      </AccordionSummary>

      <AccordionDetails>
        <ClusterBudgetControl
          value={localMaxActive}
          onChange={handleMaxActiveChange}
          onChangeCommitted={handleMaxActiveCommit}
          chainRescueBudget={cluster.chainRescueBudget}
        />

        <ContoursSection cluster={cluster} onClusterChange={handleClusterChange} />
        <LeaderLinesSection
          cluster={cluster}
          onClusterChange={handleClusterChange}
          onLeaderShadowToggle={handleLeaderShadowToggle}
        />

        <ClusterScalingSection
          cluster={cluster}
          viz={viz}
          onClusterChange={handleClusterChange}
          onNodeInsetScaleRange={handleScaleRange}
          onEdgeInsetScaleRange={handleEdgeInsetScaleRange}
          onEdgeScaleExponentChange={handleEdgeScaleExponentChange}
        />

        <AnimationsSection
          cluster={cluster}
          onClusterChange={handleClusterChange}
          onEaseChange={handleEaseChange}
        />

        <EdgeAnnotationsSection
          cluster={cluster}
          onClusterChange={handleClusterChange}
        />

        <RelationLeadersSection
          cluster={cluster}
          onClusterChange={handleClusterChange}
          onRelationLeaderWidthToggle={handleRelationLeaderWidthToggle}
          onRelationArrowSizeRange={handleRelationArrowSizeRange}
          onRelationLeaderShadowToggle={handleRelationLeaderShadowToggle}
          onSyncRelationLeaders={handleSyncRelationLeaders}
        />

        <SemanticZoomSection
          cluster={cluster}
          localSplitThreshold={localSplitThreshold}
          onClusterChange={handleClusterChange}
          onSplitThresholdChange={handleSplitThresholdChange}
          onSplitThresholdCommit={handleSplitThresholdCommit}
        />
      </AccordionDetails>
    </Accordion>
  );
};

export default ClusterSettings;
