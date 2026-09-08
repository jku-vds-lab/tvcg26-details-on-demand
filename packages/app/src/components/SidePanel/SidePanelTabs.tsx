import ColorLensIcon from '@mui/icons-material/ColorLens';
import DescriptionIcon from '@mui/icons-material/Description';
import LabelIcon from '@mui/icons-material/Label';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import TuneIcon from '@mui/icons-material/Tune';
import { Box, Tab, Tabs } from '@mui/material';
import { alpha } from '@mui/material/styles';
import React from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
// PSE's projection icon: caption stripped, viewBox cropped to the glyph, and
// fills set to currentColor so it follows the tab's text color like the MUI
// icons (svgr import → renderable component).
import PseProjectGlyph from '../../utils/textures/icons/pse-icon-project-glyph.svg?react';

interface SidePanelTabsProps {
  activeTab: number;
  onTabChange: (event: React.SyntheticEvent, newValue: number) => void;
  tabButtonWidth: number;
  showLabelingTab: boolean;
  hideDatasetTab?: boolean;
}

const SidePanelTabs: React.FC<SidePanelTabsProps> = ({ activeTab, onTabChange, tabButtonWidth, showLabelingTab, hideDatasetTab = false }) => {
  const sidePanelBgColor = useSelector((s: RootState) => s.visualizationSettings.sidePanelBgColor);

  const tabs = [
    {
      value: 0,
      label: 'Workflow',
      icon: <ManageSearchIcon />,
    },
    ...(hideDatasetTab ? [] : [{
      value: 1,
      label: 'Dataset',
      icon: <DescriptionIcon />,
    }]),
    {
      value: 2,
      label: 'Vis Encoding',
      icon: <ColorLensIcon />,
    },
    {
      value: 3,
      label: 'Advanced',
      icon: <TuneIcon />,
    },
    {
      value: 5,
      label: 'Projection',
      icon: <PseProjectGlyph width={26} height={26} aria-hidden />,
    },
    ...(showLabelingTab ? [{
      value: 4,
      label: 'Labeling',
      icon: <LabelIcon />,
    }] : []),
  ] as const;

  return (
    <Box
      sx={{
        width: tabButtonWidth,
        borderRight: (theme) => `1px solid ${theme.palette.divider}`,
        bgcolor: sidePanelBgColor,
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
      }}
    >
      <Tabs
        orientation="vertical"
        value={activeTab}
        onChange={onTabChange}
        variant="standard"
        aria-label="Side Panel Tabs"
        sx={{
          minHeight: '100%',
          '& .MuiTab-root': {
            alignItems: 'center',
            textAlign: 'center',
            textTransform: 'none',
            minHeight: 72,
            minWidth: 'unset',
            width: '100%',
            px: 0.5,
            py: 1,
            borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
            color: 'text.secondary',
            fontSize: '0.7rem',
            lineHeight: 1.2,
            transition: 'background-color 130ms ease, color 130ms ease',
            '&:hover': {
              bgcolor: (theme) => alpha(theme.palette.action.hover, 0.2),
              color: 'text.primary',
            },
            '& .MuiTab-iconWrapper': {
              marginBottom: '4px',
            },
          },
          '& .Mui-selected': {
            bgcolor: sidePanelBgColor,
            color: 'text.primary',
            fontWeight: 600,
          },
          '& .MuiTabs-indicator': {
            left: 0,
            width: 3,
            borderRadius: 2,
          },
          '& .MuiTabs-scroller': {
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
          },
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.value}
            value={tab.value}
            icon={tab.icon}
            label={tab.label}
            iconPosition="top"
          />
        ))}
      </Tabs>
    </Box>
  );
};

export default SidePanelTabs;
