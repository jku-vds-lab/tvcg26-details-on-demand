import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Autocomplete,
    Box,
    Chip,
    CircularProgress,
    Divider,
    FormControl,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    SelectChangeEvent,
    Stack,
    TextField,
    Tooltip,
    Typography
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import colorbrewer from 'colorbrewer';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { getDatasetVisualPreset } from '../config/datasetVisualPresets';
import { FeatureVariableType } from '../slices/datasetFeatures';
import { RootState, setFeatureTypeOverride, updateSettings } from '../store';
import { getEffectiveFeatureKind, getLegendCategories } from '../utils/featureKind';

type PaletteKind = 'categorical' | 'sequential' | 'diverging';
type FeatureKind = 'categorical' | 'sequential' | 'diverging' | 'boolean' | 'unknown';

type PaletteOption = {
  id: string;
  label: string;
  kind: PaletteKind;
  maxColors: number;
  colors: string[];
};

const BREWER = colorbrewer as unknown as Record<string, Record<string, string[]>>;
const QUALITATIVE_SCHEMES = ['Set1', 'Set2', 'Set3', 'Pastel1', 'Pastel2', 'Dark2', 'Accent', 'Paired'];
const SEQUENTIAL_SCHEMES = ['Blues', 'Greens', 'Greys', 'Oranges', 'Purples', 'Reds', 'BuGn', 'YlGnBu', 'YlOrRd'];
const DIVERGING_SCHEMES = ['RdYlBu', 'RdYlGn', 'RdBu', 'PiYG', 'PRGn', 'BrBG', 'PuOr', 'Spectral'];

const toPaletteOption = (scheme: string, kind: PaletteKind, targetStops: number): PaletteOption | null => {
  const families = BREWER[scheme];
  if (!families) return null;

  const available = Object.keys(families)
    .map((k) => Number(k))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (available.length === 0) return null;

  const chosen = available.find((s) => s >= targetStops) ?? available[available.length - 1];
  const colors = families[String(chosen)] ?? [];
  const maxColors = available[available.length - 1];

  return {
    id: `${scheme}-${chosen}`,
    label: `${scheme} (${chosen})`,
    kind,
    maxColors,
    colors: [...colors],
  };
};

const buildPaletteCatalog = (): PaletteOption[] => {
  const options: PaletteOption[] = [];

  QUALITATIVE_SCHEMES.forEach((name) => {
    const p = toPaletteOption(name, 'categorical', 10);
    if (p) options.push(p);
  });
  SEQUENTIAL_SCHEMES.forEach((name) => {
    const p = toPaletteOption(name, 'sequential', 9);
    if (p) options.push(p);
  });
  DIVERGING_SCHEMES.forEach((name) => {
    const p = toPaletteOption(name, 'diverging', 11);
    if (p) options.push(p);
  });

  return options;
};

const paletteOptions = buildPaletteCatalog();

const kindLabel: Record<FeatureKind, string> = {
  categorical: 'Categorical',
  boolean: 'Categorical',
  sequential: 'Sequential',
  diverging: 'Diverging',
  unknown: 'Unknown',
};

const paletteKindLabel: Record<PaletteKind, string> = {
  categorical: 'Qualitative',
  sequential: 'Sequential',
  diverging: 'Diverging',
};

const palettesMatch = (a: string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const normalizeRotationOffset = (offset: number, paletteLength: number): number => {
  if (paletteLength <= 1) return 0;
  const mod = offset % paletteLength;
  return mod < 0 ? mod + paletteLength : mod;
};

const rotatePalette = (palette: readonly string[], offset: number): string[] => {
  if (palette.length <= 1) return [...palette];
  const normalized = normalizeRotationOffset(offset, palette.length);
  if (normalized === 0) return [...palette];
  return [...palette.slice(normalized), ...palette.slice(0, normalized)];
};

interface ColorEncodingSettingsProps {
  nested?: boolean;
  hideAccordion?: boolean;
  defaultExpanded?: boolean;
}

const ColorEncodingSettings: React.FC<ColorEncodingSettingsProps> = ({ nested = false, hideAccordion = false, defaultExpanded = false }) => {
  const dispatch = useDispatch();
  const {
    colorPalette,
    colorEncoding,
    colorMapRotationOffset,
    sidePanelBgColor,
  } = useSelector((s: RootState) => s.visualizationSettings);
  const availableFeatureKeys = useSelector((s: RootState) => s.datasetFeatures.availableKeys);
  const statsByKey = useSelector((s: RootState) => s.datasetFeatures.statsByKey);
  const featureTypeOverrides = useSelector((s: RootState) => s.datasetFeatures.featureTypeOverrides);
  const { datasetType, datasetPath } = useSelector((s: RootState) => s.dataset);
  const [inputValue, setInputValue] = useState(colorEncoding ?? '');
  const shouldApplyTopRecommendationRef = useRef(false);

  const defaultColorEncoding = useMemo(() => {
    const preset = getDatasetVisualPreset({ datasetType, datasetPath })?.colorEncoding ?? '';
    // A preset may name a column this dataset lacks ("algo" on synth1m) —
    // the load-time validation clears such an encoding, and the reset
    // button must not resurrect it (issue #315 color-by UX).
    if (
      preset &&
      preset !== 'DoI' &&
      availableFeatureKeys.length > 0 &&
      !availableFeatureKeys.includes(preset)
    ) {
      return '';
    }
    return preset;
  }, [datasetType, datasetPath, availableFeatureKeys]);

  const handleColorEncodingReset = useCallback(() => {
    shouldApplyTopRecommendationRef.current = true;
    dispatch(updateSettings({ colorEncoding: defaultColorEncoding }));
  }, [dispatch, defaultColorEncoding]);

  useEffect(() => {
    setInputValue(colorEncoding ?? '');
  }, [colorEncoding]);

  const paletteValue = useMemo(() => {
    const match = paletteOptions.find((option) => {
      const rotated = rotatePalette(option.colors, colorMapRotationOffset);
      return palettesMatch(colorPalette, rotated);
    });
    return match?.id ?? null;
  }, [colorPalette, colorMapRotationOffset]);

  const selectedStats = useMemo(() => {
    if (!colorEncoding) return undefined;
    return statsByKey[colorEncoding];
  }, [colorEncoding, statsByKey]);

  const selectedOverride = colorEncoding ? featureTypeOverrides[colorEncoding] : undefined;
  const selectedKind = getEffectiveFeatureKind(colorEncoding || undefined, selectedStats, selectedOverride) as FeatureKind;
  // Palette choices cannot have any visible effect while no color feature is
  // selected, or while the typed feature does not exist in the dataset
  // (issue #315 color-by UX). "DoI" always colors (runtime column → LUT).
  const paletteInert = colorEncoding !== 'DoI' && (!colorEncoding || !selectedStats);
  const legendCategories = useMemo(
    () => getLegendCategories(selectedStats, selectedKind),
    [selectedStats, selectedKind]
  );

  const requiredColors = useMemo(() => {
    if (!selectedStats) return 0;
    if (selectedKind === 'categorical' || selectedKind === 'boolean') {
      const categoryCount = legendCategories.length > 0 ? legendCategories.length : selectedStats.uniqueCount;
      return Math.max(2, Math.min(categoryCount, 24));
    }
    return 0;
  }, [selectedStats, selectedKind, legendCategories]);

  const filteredPalettes = useMemo(() => {
    const byKind = paletteOptions.filter((p) => {
      if (selectedKind === 'diverging') return p.kind === 'diverging';
      if (selectedKind === 'sequential') return p.kind === 'sequential';
      if (selectedKind === 'categorical' || selectedKind === 'boolean') return p.kind === 'categorical';
      return true;
    });

    return byKind
      .map((p) => {
        const lacksCategories = requiredColors > 0 && p.maxColors < requiredColors;
        const penalty = lacksCategories ? 1000 + (requiredColors - p.maxColors) : Math.abs(p.maxColors - requiredColors);
        return { ...p, lacksCategories, penalty };
      })
      .sort((a, b) => a.penalty - b.penalty);
  }, [requiredColors, selectedKind]);

  const recommendedPaletteIds = useMemo(() => new Set(filteredPalettes.slice(0, 4).map((p) => p.id)), [filteredPalettes]);

  const featureOptions = useMemo(() => {
    const sorted = [...availableFeatureKeys];
    if (colorEncoding && colorEncoding.length > 0 && !sorted.includes(colorEncoding)) {
      sorted.unshift(colorEncoding);
    }
    return sorted;
  }, [availableFeatureKeys, colorEncoding]);

  const handlePaletteChange = useCallback(
    (newPaletteId: string) => {
      const selected = paletteOptions.find((option) => option.id === newPaletteId);
      if (!selected) return;
      dispatch(updateSettings({ colorPalette: rotatePalette(selected.colors, colorMapRotationOffset) }));
    },
    [dispatch, colorMapRotationOffset],
  );

  const handleColorMapRotationOffsetChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextRaw = Number(event.target.value);
      if (!Number.isFinite(nextRaw)) return;
      const next = Math.trunc(nextRaw);
      const normalizedCurrent = normalizeRotationOffset(colorMapRotationOffset, colorPalette.length);
      const normalizedNext = normalizeRotationOffset(next, colorPalette.length);
      if (normalizedCurrent === normalizedNext) return;
      const delta = normalizedNext - normalizedCurrent;
      dispatch(
        updateSettings({
          colorMapRotationOffset: normalizedNext,
          colorPalette: rotatePalette(colorPalette, delta),
        })
      );
    },
    [dispatch, colorMapRotationOffset, colorPalette]
  );

  const handleEncodingInputChange = useCallback((_: React.SyntheticEvent, newValue: string) => {
    setInputValue(newValue);
  }, []);

  const handleEncodingSelection = useCallback(
    (_event: React.SyntheticEvent, newValue: string | null) => {
      if (typeof newValue === 'string') {
        shouldApplyTopRecommendationRef.current = true;
        dispatch(updateSettings({ colorEncoding: newValue }));
        setInputValue(newValue);
      } else if (newValue === null) {
        shouldApplyTopRecommendationRef.current = true;
        dispatch(updateSettings({ colorEncoding: '' }));
        setInputValue('');
      }
    },
    [dispatch],
  );

  const handleEncodingCommit = useCallback(() => {
    shouldApplyTopRecommendationRef.current = true;
    dispatch(updateSettings({ colorEncoding: inputValue }));
  }, [dispatch, inputValue]);

  useEffect(() => {
    if (colorEncoding === 'DoI') return;
    if (!selectedStats) return;
    const currentPalette = paletteOptions.find((p) => palettesMatch(colorPalette, rotatePalette(p.colors, colorMapRotationOffset)));

    const best = filteredPalettes.find((p) => !p.lacksCategories) ?? filteredPalettes[0];
    if (!best) return;

    const rotatedBest = rotatePalette(best.colors, colorMapRotationOffset);
    const currentCompatible =
      currentPalette &&
      filteredPalettes.some((p) => p.id === currentPalette.id && !p.lacksCategories);

    const shouldForceTop = shouldApplyTopRecommendationRef.current;
    if (!shouldForceTop) return;

    shouldApplyTopRecommendationRef.current = false;
    if (!currentCompatible && !palettesMatch(colorPalette, rotatedBest)) {
      if (best.kind === 'sequential' || best.kind === 'diverging') {
        // Rotation shifts the gradient end-points, causing the maximum value to
        // wrap back to the minimum color (e.g. value=1 → white for Blues).
        // Sequential/diverging palettes rely on their canonical ordering, so
        // apply them without any rotation and clear the stored offset.
        dispatch(updateSettings({ colorPalette: best.colors, colorMapRotationOffset: 0 }));
      } else {
        dispatch(updateSettings({ colorPalette: rotatedBest }));
      }
    }
  }, [colorEncoding, selectedStats, filteredPalettes, colorPalette, colorMapRotationOffset, dispatch]);

  // Legend commented out — variables kept for easy re-enable
  // const legendColors = useMemo(() => {
  //   const categories = legendCategories;
  //   return categories.slice(0, 12).map((_entry, idx) => colorPalette[idx % colorPalette.length]);
  // }, [legendCategories, colorPalette]);
  //
  // const gradientCss = useMemo(() => { ... }, [...]);
  // const legendMinLabel = ...;
  // const legendMidLabel = ...;
  // const legendMaxLabel = ...;

  const handleSetOverride = useCallback(
    (kind?: FeatureVariableType) => {
      if (!colorEncoding || colorEncoding === 'DoI') return;
      dispatch(setFeatureTypeOverride({ key: colorEncoding, variableType: kind }));
    },
    [dispatch, colorEncoding]
  );

  const handleTypeModeChange = useCallback(
    (event: SelectChangeEvent<'auto' | FeatureVariableType>) => {
      const value = event.target.value as 'auto' | FeatureVariableType;
      handleSetOverride(value === 'auto' ? undefined : value);
    },
    [handleSetOverride]
  );

  const typeModeValue: 'auto' | FeatureVariableType = selectedOverride ?? 'auto';

  const panelBody = (
    <>
        <Box sx={{ mb: 2, display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <Autocomplete
            freeSolo
            size="small"
            sx={{ flex: 1 }}
            options={featureOptions}
            value={colorEncoding ?? ''}
            inputValue={inputValue}
            onInputChange={handleEncodingInputChange}
            onChange={handleEncodingSelection}
            slotProps={{
              popper: {
                sx: {
                  '& .MuiAutocomplete-paper': {
                    bgcolor: sidePanelBgColor,
                  },
                  '& .MuiAutocomplete-listbox': {
                    bgcolor: sidePanelBgColor,
                  },
                },
              },
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                label="Color feature"
                placeholder="e.g. line, action, reward"
                helperText={
                  !colorEncoding
                    ? 'No color feature selected — points use a single color.'
                    : paletteInert
                      ? `"${colorEncoding}" is not a feature of this dataset.`
                      : 'Palette recommendations adapt to this feature.'
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleEncodingCommit();
                  }
                }}
              />
            )}
          />
          <Tooltip title="Reset to dataset default">
            <span>
              <IconButton
                size="small"
                onClick={handleColorEncodingReset}
                disabled={colorEncoding === defaultColorEncoding}
                sx={{ mt: 0.5 }}
              >
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', mb: 2 }} alignItems="center">
          {colorEncoding && <Chip size="small" label={`Type: ${kindLabel[selectedKind]}`} />}
          {selectedStats && (
            <Chip
              size="small"
              label={
                selectedKind === 'categorical' || selectedKind === 'boolean'
                  ? `Values: ${selectedStats.confidence !== 'high' ? '≈' : ''}${selectedStats.uniqueCount}`
                  : `Domain: ${selectedStats.min?.toFixed?.(3) ?? 'n/a'} to ${selectedStats.max?.toFixed?.(3) ?? 'n/a'}`
              }
            />
          )}
          {selectedStats && selectedStats.confidence !== 'high' && (
            <Tooltip title="Still scanning dataset — value counts and palette fit may change once the full scan completes">
              <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                <CircularProgress size={12} thickness={5} />
              </span>
            </Tooltip>
          )}
        </Stack>

        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
          <FormControl
            size="small"
            fullWidth
            disabled={!colorEncoding || colorEncoding === 'DoI'}
          >
            <InputLabel id="feature-type-mode-label">Type mode</InputLabel>
            <Select
              labelId="feature-type-mode-label"
              value={typeModeValue}
              label="Type mode"
              onChange={handleTypeModeChange}
            >
              <MenuItem value="auto">Auto (detected)</MenuItem>
              <MenuItem value="categorical">Categorical</MenuItem>
              <MenuItem value="sequential">Sequential</MenuItem>
              <MenuItem value="diverging">Diverging</MenuItem>
            </Select>
          </FormControl>
          <Tooltip title="Override automatic feature-type detection when needed." arrow enterDelay={150}>
            <InfoOutlinedIcon sx={{ fontSize: '1rem', color: 'text.secondary', flexShrink: 0 }} />
          </Tooltip>
        </Stack>

        <Divider sx={{ mb: 2 }} />

        <Box sx={{ mb: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="body2">
              Recommended palettes
            </Typography>
            {selectedStats && selectedStats.confidence !== 'high' && (selectedKind === 'categorical' || selectedKind === 'boolean') && (
              <Tooltip title="Still scanning — the 'colors may repeat' warning will appear once the full value count is known">
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <CircularProgress size={10} thickness={5} />
                </span>
              </Tooltip>
            )}
          </Stack>
          {paletteInert && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
              Select a color feature above to enable palettes.
            </Typography>
          )}
          <Stack spacing={1} sx={paletteInert ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            {filteredPalettes.slice(0, 8).map((option) => {
              const selected = paletteValue === option.id;
              return (
                <Box
                  key={option.id}
                  onClick={paletteInert ? undefined : () => handlePaletteChange(option.id)}
                  sx={{
                    p: 1,
                    borderRadius: 1,
                    border: (theme) => `1px solid ${selected ? theme.palette.primary.main : theme.palette.divider}`,
                    cursor: 'pointer',
                    bgcolor: (theme) =>
                      selected
                        ? alpha(theme.palette.primary.main, 0.16)
                        : sidePanelBgColor,
                  }}
                >
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.75 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600 }}>
                      {option.label}
                    </Typography>
                    <Stack direction="row" spacing={0.5}>
                      <Chip size="small" label={paletteKindLabel[option.kind]} />
                      {recommendedPaletteIds.has(option.id) && <Chip size="small" color="primary" label="Recommended" />}
                    </Stack>
                  </Stack>
                  <Box sx={{ display: 'flex', borderRadius: 1, overflow: 'hidden', boxShadow: (t) => t.shadows[1] }}>
                    {rotatePalette(option.colors, colorMapRotationOffset).map((color) => (
                      <Box key={color} sx={{ width: 14, height: 14, bgcolor: color, flex: 1 }} />
                    ))}
                  </Box>
                  {option.lacksCategories && (
                    <Typography variant="caption" sx={{ color: 'warning.main' }}>
                      Fewer distinct colors than required ({option.maxColors} &lt; {requiredColors}); colors may repeat.
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
        </Box>

        <TextField
          type="number"
          label="Color map rotation"
          size="small"
          fullWidth
          disabled={paletteInert || selectedKind === 'sequential' || selectedKind === 'diverging'}
          sx={{ mt: 2 }}
          inputProps={{ min: 0, step: 1, max: Math.max(0, colorPalette.length - 1) }}
          value={normalizeRotationOffset(colorMapRotationOffset, colorPalette.length)}
          onChange={handleColorMapRotationOffsetChange}
          helperText={
            selectedKind === 'sequential' || selectedKind === 'diverging'
              ? 'Rotation is not applicable to sequential/diverging palettes.'
              : 'Rotates the active palette order (0 keeps the original start color).'
          }
        />

        {/* Legend commented out — already shown overlaid on the canvas */}
    </>
  );

  if (hideAccordion) {
    return <Box>{panelBody}</Box>;
  }

  return (
    <Accordion
      defaultExpanded={defaultExpanded}
      disableGutters={nested}
      elevation={nested ? 0 : undefined}
      square={nested}
      sx={
        nested
          ? {
              '&:before': { display: 'none' },
              border: (theme) => `1px solid ${theme.palette.divider}`,
              boxShadow: 'none',
              borderRadius: 1,
            }
          : undefined
      }
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Color Mapping</Typography>
      </AccordionSummary>
      <AccordionDetails>{panelBody}</AccordionDetails>
    </Accordion>
  );
};

export default ColorEncodingSettings;
