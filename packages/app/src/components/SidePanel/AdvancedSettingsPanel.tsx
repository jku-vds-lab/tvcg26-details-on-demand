import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Divider, Tooltip, Typography } from '@mui/material';
import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import {
    clearFeatureSearchQuery,
    initialClusterSettings,
    initialVisualizationSettings,
    setSelectedNodes,
    updateClusterSettings,
    updateSettings,
} from '../../store';
import ClusterSettings from '../ClusterSettings';
import InsetOptimizationSettings from '../InsetOptimizationSettings';

const AdvancedSettingsPanel: React.FC = () => {
  const dispatch = useDispatch();
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);

  const handleConfirmReset = () => {
    dispatch(updateSettings(initialVisualizationSettings));
    dispatch(updateClusterSettings(initialClusterSettings));
    dispatch(setSelectedNodes([]));
    dispatch(clearFeatureSearchQuery());
    setIsResetDialogOpen(false);
  };

  return (
    <Box sx={{
      p: 1,
      '& .MuiAccordion-root': {
        boxShadow: 'none',
        border: 'none',
        '&:before': { display: 'none' },
      },
      '& .MuiAccordionSummary-root': { px: 1 },
      '& .MuiAccordionDetails-root': { px: 1 },
    }}>
      <Typography variant="h6" sx={{ mb: 0.5, px: 1 }}>
        Advanced Controls
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5, px: 1 }}>
        Expert-level parameters for clustering behavior and inset optimization.
      </Typography>

      <Box sx={{ display: 'flex', justifyContent: 'center', width: '100%', mb: 2 }}>
        <Tooltip title="Reset all settings to their default values">
          <Button
            size="small"
            variant="outlined"
            startIcon={<RestartAltIcon fontSize="small" />}
            onClick={() => setIsResetDialogOpen(true)}
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
          >
            Reset to defaults
          </Button>
        </Tooltip>
      </Box>

      <Divider sx={{ my: 2 }} />

      <ClusterSettings />
      <InsetOptimizationSettings />

      <Dialog open={isResetDialogOpen} onClose={() => setIsResetDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Reset settings?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This resets visualization, clustering, selected nodes, and feature search to their default states.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIsResetDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" color="primary" onClick={handleConfirmReset}>
            Reset
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AdvancedSettingsPanel;
