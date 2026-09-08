import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Box, Collapse, IconButton, Slider, Stack, Tooltip, Typography } from '@mui/material';
import React, { useCallback, useMemo, useState } from 'react';
import { SliderConfig, UI_SPACING } from 'src/utils/constants';
import { useSliderDoubleClickReset } from 'src/utils/sliderReset';
import { formatSliderLabel } from 'src/utils/sliderUtils';

type Props = {
  label: string;
  tooltip?: string;
  value: number | number[];
  onChange: (event: Event, value: number | number[]) => void;
  onChangeCommitted?: (event: Event | React.SyntheticEvent, value: number | number[]) => void;
  config: SliderConfig;
  /**
   * When provided, double-clicking a thumb resets it to this value.
   * For range sliders, pass an array that mirrors the shape of `value`.
   * Only the double-clicked thumb is reset; the other thumb is preserved.
   */
  defaultValue?: number | number[];
  valueLabelDisplay?: 'auto' | 'on' | 'off';
  /**
   * Optional formatter for the thumb value label (e.g. "34.5k", "off").
   * Defaults to formatSliderLabel, which strips floating-point dust
   * from keyboard-stepped fractional values (0.30000000000000004 → "0.3").
   */
  valueLabelFormat?: (value: number) => string;
  disableSwap?: boolean;
  disabled?: boolean;
  /**
   * Related sub-controls revealed by a small arrow in the label row
   * (collapsed by default). Rendered full-width below the slider — no
   * accordion chrome, no indentation. The Collapse mounts OUTSIDE the
   * double-click-reset Box so nested slider thumbs don't trigger this
   * slider's reset.
   */
  unfold?: React.ReactNode;
};

const LabeledSlider: React.FC<Props> = ({
  label,
  tooltip,
  value,
  onChange,
  onChangeCommitted,
  config,
  defaultValue,
  valueLabelDisplay = 'auto',
  valueLabelFormat = formatSliderLabel,
  disableSwap,
  disabled,
  unfold,
}) => {
  const marks = useMemo(() => config.marks.slice(), [config.marks]);
  const [unfoldOpen, setUnfoldOpen] = useState(false);

  const handleReset = useCallback(
    (e: React.MouseEvent, resetValue: number | number[]) => {
      onChange(e.nativeEvent, resetValue);
    },
    [onChange],
  );

  const { onDoubleClick, noTransitionSx } = useSliderDoubleClickReset(defaultValue, value, handleReset);

  return (
    <>
    <Box
      sx={{ mb: unfold && unfoldOpen ? 0.5 : UI_SPACING.PANEL_SECTION_MB }}
      onDoubleClick={onDoubleClick}
    >
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="body2">{label}</Typography>
        {tooltip && (
          <Tooltip title={tooltip} arrow enterDelay={150}>
            <InfoOutlinedIcon sx={{ fontSize: '0.875rem', color: 'text.secondary' }} />
          </Tooltip>
        )}
        {unfold && (
          <IconButton
            size="small"
            aria-label={`${label} details`}
            aria-expanded={unfoldOpen}
            onClick={() => setUnfoldOpen((open) => !open)}
            sx={{ p: 0.25, ml: 'auto' }}
          >
            <ExpandMoreIcon
              sx={{
                fontSize: '1rem',
                color: 'text.secondary',
                transform: unfoldOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 150ms',
              }}
            />
          </IconButton>
        )}
      </Stack>
      <Slider
        value={value}
        onChange={onChange}
        onChangeCommitted={onChangeCommitted}
        disabled={disabled}
        step={config.step}
        min={config.min}
        max={config.max}
        marks={marks}
        valueLabelDisplay={valueLabelDisplay}
        valueLabelFormat={valueLabelFormat}
        disableSwap={disableSwap}
        sx={{
          mx: 1,
          width: 'calc(100% - 16px)',
          ...noTransitionSx,
          '& .MuiSlider-markLabel': {
            fontSize: '0.72rem',
            whiteSpace: 'nowrap',
          },
        }}
      />
    </Box>
    {unfold && <Collapse in={unfoldOpen}>{unfold}</Collapse>}
    </>
  );
};

export default LabeledSlider;
