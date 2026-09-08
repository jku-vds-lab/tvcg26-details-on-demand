import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Box, Button, Tooltip, Typography } from '@mui/material';
import React from 'react';
import { useDispatch } from 'react-redux';
import {
  clearFeatureSearchQuery,
  initialClusterSettings,
  initialVisualizationSettings,
  setSelectedNodes,
  updateClusterSettings,
  updateSettings,
} from '../store';
import ClusterSettings from './ClusterSettings';
import InsetOptimizationSettings from './InsetOptimizationSettings';
import NodeTrajectorySettings from './NodeTrajectorySettings';

const VisualEncodingSettings: React.FC<{ width: number }> = ({ width }) => {
  const dispatch = useDispatch();
  const handleReset = () => {
    if (window.confirm('Reset all settings to defaults?')) {
      dispatch(updateSettings(initialVisualizationSettings));
      dispatch(updateClusterSettings(initialClusterSettings));
      dispatch(setSelectedNodes([]));
      dispatch(clearFeatureSearchQuery());
    }
  };

  return (
    <Box sx={{ p: 2, width }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Visual Encoding Settings
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'center', width: '100%', mb: 2 }}>
        <Tooltip title="Reset all settings to their default values">
          <Button
            size="small"
            variant="outlined"
            startIcon={<RestartAltIcon fontSize="small" />}
            onClick={handleReset}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
          >
            Reset to defaults
          </Button>
        </Tooltip>
      </Box>
      <NodeTrajectorySettings />
      <ClusterSettings />
      <InsetOptimizationSettings />
    </Box>
  );
};

export default VisualEncodingSettings;
