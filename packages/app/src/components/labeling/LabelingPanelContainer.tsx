import { alpha, useTheme } from "@mui/material/styles";
import React, { useMemo } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "../../store";
import { LabelingPanel } from "./LabelingPanel";
import styles from "./LabelingPanelContainer.module.css";
import { SessionsPanel } from "./SessionsPanel";

/**
 * Container component that conditionally renders the LabelingPanel
 * when labeling mode is enabled.
 * Positioned as a floating panel in the top-right area of the visualization.
 */
interface LabelingPanelContainerProps {
  embedded?: boolean;
}

export const LabelingPanelContainer: React.FC<LabelingPanelContainerProps> = ({ embedded = false }) => {
  const isEnabled = useSelector((state: RootState) => state.labeling.isEnabled);
  const theme = useTheme();

  const themeVars = useMemo(
    () => ({
      "--lp-surface": alpha(theme.palette.background.paper, 0.92),
      "--lp-surface-soft": alpha(theme.palette.background.paper, 0.72),
      "--lp-border": alpha(theme.palette.divider, 0.75),
      "--lp-border-strong": alpha(theme.palette.divider, 0.65),
      "--lp-text": theme.palette.text.primary,
      "--lp-text-muted": theme.palette.text.secondary,
      "--lp-accent": theme.palette.primary.main,
      "--lp-accent-contrast": theme.palette.primary.contrastText,
      "--lp-hover": alpha(theme.palette.action.hover, 0.28),
      "--lp-radius": `${theme.shape.borderRadius}px`,
    }) as React.CSSProperties,
    [theme]
  );

  if (!isEnabled) return null;

  return (
    <div className={embedded ? styles.embeddedContainer : styles.container} style={themeVars} data-interaction-ignore="true">
      <LabelingPanel />
      <SessionsPanel />
    </div>
  );
};
