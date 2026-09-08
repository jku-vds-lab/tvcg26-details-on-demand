import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Autocomplete,
  Box,
  Chip,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import SettingsSegmentedControl from './clusterSettings/controls/SettingsSegmentedControl';
import { getDefaultLabelFeature, selectLabelFeatureName } from '../slices/labelingSelectors';
import {
  RootState,
  setAnnotationLabelFeature,
  setAnnotationTagDelimiter,
  setClusterLabelStrategy,
  setTfIdfCorpusScope,
} from '../store';

const STRATEGY_OPTIONS = [
  { value: 'majority-vote' as const, label: 'Majority Vote' },
  { value: 'tfidf' as const, label: 'TF-IDF' },
];

const SCOPE_OPTIONS = [
  { value: 'visible' as const, label: 'Visible' },
  { value: 'doi-active' as const, label: 'DOI-Active' },
  { value: 'full-dataset' as const, label: 'Full Dataset' },
];

interface AnnotationLabelSettingsProps {
  defaultExpanded?: boolean;
}

/**
 * Same contains-match list as the MUI default, ordered exact > prefix > contains
 * so `autoHighlight` (index 0) is what Enter / blur commit (issue #352).
 */
function filterFeatureOptions(options: string[], { inputValue }: { inputValue: string }): string[] {
  const q = inputValue.trim().toLowerCase();
  if (!q) return options;
  const rank = (o: string) => {
    const l = o.toLowerCase();
    return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : 3;
  };
  return options.filter((o) => rank(o) < 3).sort((a, b) => rank(a) - rank(b));
}

const AnnotationLabelSettings: React.FC<AnnotationLabelSettingsProps> = ({ defaultExpanded = false }) => {
  const dispatch = useDispatch();
  const {
    annotationLabelFeature,
    clusterLabelStrategy,
    tfidfCorpusScope,
    annotationTagDelimiter,
  } = useSelector((s: RootState) => s.visualizationSettings);
  const availableKeys = useSelector((s: RootState) => s.datasetFeatures.availableKeys);
  const statsByKey = useSelector((s: RootState) => s.datasetFeatures.statsByKey);
  const datasetType = useSelector((s: RootState) => s.dataset.datasetType);
  // Displayed value = the active column (override or dataset default), the
  // same thing the labeling panel shows (issue #352).
  const resolvedFeature = useSelector(selectLabelFeatureName);

  const [inputValue, setInputValue] = useState(resolvedFeature);
  useEffect(() => { setInputValue(resolvedFeature); }, [resolvedFeature]);

  const handleFeatureChange = useCallback((_: React.SyntheticEvent, v: string | null) => {
    dispatch(setAnnotationLabelFeature(v?.trim() || null));
  }, [dispatch]);

  const handleInputChange = useCallback((_: React.SyntheticEvent, v: string) => {
    setInputValue(v);
  }, []);

  // Commit what was typed like the labeling panel's field: an exact column
  // name, else the best match, else the name as typed; empty = dataset default.
  const commitTyped = useCallback((typed: string) => {
    const next = typed.trim();
    const resolved = next ? filterFeatureOptions(availableKeys, { inputValue: next })[0] ?? next : null;
    setInputValue(resolved ?? getDefaultLabelFeature(datasetType));
    if (resolved !== annotationLabelFeature) dispatch(setAnnotationLabelFeature(resolved));
  }, [availableKeys, annotationLabelFeature, datasetType, dispatch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // An exactly typed column wins over whatever option MUI has highlighted;
    // otherwise MUI commits the highlighted option (or the free text).
    if (e.key !== 'Enter' || !availableKeys.includes(inputValue.trim())) return;
    (e as React.KeyboardEvent & { defaultMuiPrevented?: boolean }).defaultMuiPrevented = true;
    commitTyped(inputValue);
    (e.target as HTMLElement).blur();
  }, [availableKeys, inputValue, commitTyped]);

  const handleBlur = useCallback(() => commitTyped(inputValue), [commitTyped, inputValue]);

  const handleReset = useCallback(() => dispatch(setAnnotationLabelFeature(null)), [dispatch]);

  const handleStrategyChange = useCallback((v: 'majority-vote' | 'tfidf') => {
    dispatch(setClusterLabelStrategy(v));
  }, [dispatch]);

  const handleScopeChange = useCallback((v: 'visible' | 'doi-active' | 'full-dataset') => {
    dispatch(setTfIdfCorpusScope(v));
  }, [dispatch]);

  const handleDelimiterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (v.length <= 3) dispatch(setAnnotationTagDelimiter(v || ','));
  }, [dispatch]);

  // Warn when TF-IDF is selected but the feature looks like it has no multi-token values.
  const showTfIdfWarning = useMemo(() => {
    if (clusterLabelStrategy !== 'tfidf') return false;
    const stats = statsByKey[annotationLabelFeature ?? ''];
    if (!stats?.categories?.length) return false;
    const hasMultiToken = stats.categories.some((c) => c.value.includes(annotationTagDelimiter));
    return !hasMultiToken;
  }, [clusterLabelStrategy, annotationLabelFeature, statsByKey, annotationTagDelimiter]);

  const isDisabled = availableKeys.length === 0;

  return (
    <Accordion defaultExpanded={defaultExpanded}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Annotation Labels</Typography>
      </AccordionSummary>
      <AccordionDetails sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>

        {/* Feature selector */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Autocomplete
            sx={{ flex: 1 }}
            size="small"
            options={availableKeys}
            filterOptions={filterFeatureOptions}
            freeSolo
            autoHighlight
            // No clear (x) button: emptying the text would otherwise reset the
            // override mid-edit and the resolved default would snap back in;
            // the reset button next to it covers that action.
            disableClearable
            value={resolvedFeature}
            inputValue={inputValue}
            onInputChange={handleInputChange}
            onChange={handleFeatureChange}
            onKeyDown={handleKeyDown}
            disabled={isDisabled}
            renderInput={(params) => (
              <TextField {...params} label="Label feature" placeholder="Dataset default" onBlur={handleBlur} />
            )}
            noOptionsText={isDisabled ? 'No features loaded' : 'No match'}
          />
          <Tooltip title="Reset to dataset default">
            <span>
              <IconButton size="small" onClick={handleReset} disabled={annotationLabelFeature === null}>
                <RestartAltIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>

        {/* Strategy selector */}
        <SettingsSegmentedControl
          label="Label strategy"
          value={clusterLabelStrategy}
          options={STRATEGY_OPTIONS}
          onChange={handleStrategyChange}
        />

        {/* TF-IDF options */}
        {clusterLabelStrategy === 'tfidf' && (
          <>
            <SettingsSegmentedControl
              label="Corpus scope"
              value={tfidfCorpusScope}
              options={SCOPE_OPTIONS}
              onChange={handleScopeChange}
            />

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                size="small"
                label="Tag delimiter"
                value={annotationTagDelimiter}
                onChange={handleDelimiterChange}
                sx={{ width: 100 }}
                inputProps={{ maxLength: 3 }}
              />
            </Box>

            {showTfIdfWarning && (
              <Chip
                size="small"
                label="TF-IDF works best with multi-tag values"
                color="warning"
                variant="outlined"
                sx={{ alignSelf: 'flex-start', fontSize: '0.72rem' }}
              />
            )}
          </>
        )}
      </AccordionDetails>
    </Accordion>
  );
};

export default AnnotationLabelSettings;
