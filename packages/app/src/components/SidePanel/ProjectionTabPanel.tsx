import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Autocomplete,
    Box,
    Button,
    Checkbox,
    FormControl,
    FormControlLabel,
    InputLabel,
    MenuItem,
    Select,
    Stack,
    Switch,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import React, { useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { useDataRef } from '../../contexts/DataContext';
import type { RootState } from '../../store';
import type { KnnGraph } from '../../types/graphTypes';
import type { SliderConfig } from '../../utils/constants';
import { completeTask, failTask, startTask, updateTask } from '../../utils/progressApi';
import {
    buildProjectionMatrix,
    PIXELS_FEATURE_KEY,
    standardizeInPlace,
} from '../../utils/projectionMatrix';
import { resolveCutProvider } from '@scaling';
import type { UmapMetric } from '../../workers/umap.worker';
import { umapWorkerProxy } from '../../workers/umapWorkerProxy';
import LabeledSlider from '../clusterSettings/controls/LabeledSlider';

export interface ProjectionTabPanelProps {
  applyProjection: (coords: Float32Array, knnGraph: KnnGraph) => void;
  restoreOriginalProjection: () => void;
  canRestoreProjection: boolean;
}

const accordionCardSx: SxProps<Theme> = {
  borderRadius: 2,
  border: 'none',
  boxShadow: 'none',
  '&:before': { display: 'none' },
};

// The worker clamps nNeighbors to nRows - 1, so a generous max is safe even
// for small datasets.
const N_NEIGHBORS_CONFIG: SliderConfig = {
  min: 2,
  max: 500,
  step: 1,
  marks: [
    { value: 2, label: '2' },
    { value: 100, label: '100' },
    { value: 500, label: '500' },
  ],
};

const MIN_DIST_CONFIG: SliderConfig = {
  min: 0,
  max: 1,
  step: 0.01,
  marks: [
    { value: 0, label: '0' },
    { value: 0.5, label: '0.5' },
    { value: 1, label: '1' },
  ],
};

const EPOCHS_CONFIG: SliderConfig = {
  min: 0,
  max: 1000,
  step: 10,
  marks: [
    { value: 0, label: 'auto' },
    { value: 500, label: '500' },
    { value: 1000, label: '1000' },
  ],
};

const SPREAD_CONFIG: SliderConfig = {
  min: 0.5,
  max: 5,
  step: 0.1,
  marks: [
    { value: 0.5, label: '0.5' },
    { value: 1, label: '1' },
    { value: 5, label: '5' },
  ],
};

/**
 * Interaction/render state and pixel metadata that the feature scan picks up
 * from DataPoint but that are not data features — never offered for projection.
 */
const EXCLUDED_KEYS = new Set([
  'selected',
  'doiGroup',
  'annotationClusterId',
  'insetClusterId',
  'pixelsWidth',
  'pixelsHeight',
]);

/**
 * Bookkeeping/metadata columns (identifiers, preprocessing-derived counters):
 * selectable, but not part of the default selection — projections should
 * default to the actual data features.
 */
const DEFAULT_DESELECTED_KEYS = new Set([
  'id',
  'line',
  'DoI',
  'age',
  'groupLabel',
  'multiplicity',
  'step',
  // Generic DataPoint schema columns (labels, not state) and preprocessing
  // outputs — present in every dataset, so not data features either.
  'action',
  'algo',
  'clusterProbability',
]);

const featureOptionLabel = (key: string) =>
  key === PIXELS_FEATURE_KEY ? 'pixels (image)' : key;

/**
 * Sidebar tab that runs UMAP in-app: select the numeric features to project,
 * tune hyperparameters, and overwrite the scatterplot's x/y with the result.
 * The heavy computation runs in a Web Worker (umapWorkerProxy); progress is
 * reported through the global progress snackbar.
 */
const ProjectionTabPanel: React.FC<ProjectionTabPanelProps> = ({
  applyProjection,
  restoreOriginalProjection,
  canRestoreProjection,
}) => {
  const dataRef = useDataRef();
  const availableKeys = useSelector((s: RootState) => s.datasetFeatures.availableKeys);

  // Every scanned feature is projectable (numeric-ish columns become one
  // dimension, categoricals are one-hot encoded); image datasets additionally
  // expose their pixel buffer. dataRef is populated before the feature scan
  // dispatches availableKeys, so keying on it keeps this reactive.
  const hasPixels = useMemo(
    () => dataRef.current.some((p) => p.pixels && p.pixels.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataRef is a stable ref; availableKeys changing is the signal that a new dataset landed
    [availableKeys]
  );

  const featureOptions = useMemo(() => {
    const keys = availableKeys.filter((key) => !EXCLUDED_KEYS.has(key));
    return hasPixels ? [PIXELS_FEATURE_KEY, ...keys] : keys;
  }, [hasPixels, availableKeys]);

  const defaultSelection = useMemo(
    () => featureOptions.filter((key) => !DEFAULT_DESELECTED_KEYS.has(key)),
    [featureOptions]
  );

  // Feature selection resets when the dataset (and thus the key set) changes.
  const [selectedKeys, setSelectedKeys] = useState<string[]>(defaultSelection);
  const lastDefaultRef = useRef(defaultSelection);
  if (lastDefaultRef.current !== defaultSelection) {
    lastDefaultRef.current = defaultSelection;
    setSelectedKeys(defaultSelection);
  }

  const [nNeighbors, setNNeighbors] = useState(15);
  const [minDist, setMinDist] = useState(0.1);
  const [nEpochs, setNEpochs] = useState(0);
  const [spread, setSpread] = useState(1.0);
  const [metric, setMetric] = useState<UmapMetric>('euclidean');
  const [seed, setSeed] = useState(0);
  const [standardize, setStandardize] = useState(true);

  const [isRunning, setIsRunning] = useState(false);
  const [lastRunNote, setLastRunNote] = useState<string | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  const handleRun = async () => {
    const points = dataRef.current;
    if (!points.length || selectedKeys.length === 0 || isRunning) return;

    setIsRunning(true);
    setErrorNote(null);
    const taskId = `projection:umap:${Date.now()}`;
    startTask({
      id: taskId,
      label: 'Computing projection',
      phase: 'Preparing feature matrix…',
      kind: 'compute',
      value: null,
      progressMode: 'indeterminate',
      minShowMs: 300,
    });
    // Let the snackbar paint before the synchronous matrix build blocks the
    // main thread (wide image datasets take a noticeable moment here).
    await new Promise((r) => setTimeout(r, 0));

    try {
      const { matrix, nRows, nCols, imputedCells, encodings } = buildProjectionMatrix(
        points,
        selectedKeys
      );
      if (nCols === 0) {
        failTask(taskId, 'No projectable values');
        setErrorNote('The selected features contain no values to project.');
        return;
      }
      const { constantColumns } = standardize
        ? standardizeInPlace(matrix, nRows, nCols)
        : { constantColumns: [] };

      const oneHot = encodings.filter((e) => e.kind === 'onehot');
      const notes: string[] = [
        `${encodings.length} feature${encodings.length !== 1 ? 's' : ''} → ${nCols} dimensions` +
          (oneHot.length > 0 ? ` (${oneHot.length} one-hot encoded)` : ''),
      ];
      if (imputedCells > 0) notes.push(`${imputedCells} missing cells imputed with column means`);
      if (constantColumns.length > 0) {
        notes.push(`${constantColumns.length} constant dimension${constantColumns.length > 1 ? 's' : ''} ignored`);
      }
      setLastRunNote(notes.join('; '));

      // Covers worker startup + row conversion until the first stage message.
      updateTask({ id: taskId, phase: `Starting UMAP over ${nCols} dimensions…` });

      const { coords, knnGraph } = await umapWorkerProxy.run(
        matrix,
        nRows,
        nCols,
        { nNeighbors, minDist, spread, nEpochs, metric, seed },
        (progress) => {
          if (progress.stage === 'neighbors') {
            // umap-js exposes no per-iteration hook for its kNN search, so
            // this stage stays indeterminate — but named.
            updateTask({
              id: taskId,
              value: null,
              progressMode: 'indeterminate',
              phase: `Finding nearest neighbors in ${nCols} dimensions…`,
            });
          } else if (progress.stage === 'epochs') {
            const { epoch, totalEpochs } = progress;
            updateTask({
              id: taskId,
              // Task values are 0..100.
              value: totalEpochs > 0 ? Math.min(99, (epoch / totalEpochs) * 100) : null,
              progressMode: 'predictive',
              phase: `Optimizing layout — epoch ${epoch} / ${totalEpochs}`,
            });
          } else {
            updateTask({
              id: taskId,
              value: 99,
              progressMode: 'predictive',
              phase: 'Building 2D neighbor graph…',
            });
          }
        }
      );

      applyProjection(coords, knnGraph);
      completeTask(taskId);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        failTask(taskId, 'Cancelled');
      } else {
        failTask(taskId, 'Projection failed');
        setErrorNote(err instanceof Error ? err.message : String(err));
        console.error('ProjectionTabPanel: UMAP run failed', err);
      }
    } finally {
      setIsRunning(false);
    }
  };

  const handleCancel = () => {
    umapWorkerProxy.cancel();
  };

  const handleRestore = () => {
    if (isRunning) umapWorkerProxy.cancel();
    restoreOriginalProjection();
  };

  // Server-resident datasets (issue #315 R1a, CS decision 2026-08-02): the
  // projection reads per-point `features`/`pixels` from the CLIENT-resident
  // rows, and a server dataset ships only the columns the client needs — on a
  // slim one the fat features simply aren't here, so a run would silently
  // project from fewer columns than the picker lists. Blocked with a reason
  // instead.
  const serverResident = Boolean(resolveCutProvider(undefined));
  const runDisabled =
    isRunning || serverResident || selectedKeys.length === 0 || featureOptions.length === 0;

  return (
    <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Accordion defaultExpanded disableGutters sx={accordionCardSx}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 1, py: 1 }}>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.25 }}>
              Projection
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Re-project the data with UMAP, replacing the current layout.
            </Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 1, pb: 1 }}>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="body2">Features to project</Typography>
            <Tooltip
              title="Features fed to UMAP: numeric features count as one dimension, categorical features are one-hot encoded, and image pixels use one dimension per pixel. Distances are computed in this feature space; the 2D result overwrites the current x/y layout."
              arrow
              enterDelay={150}
            >
              <InfoOutlinedIcon sx={{ fontSize: '0.875rem', color: 'text.secondary' }} />
            </Tooltip>
            <Stack direction="row" spacing={0.5} sx={{ ml: 'auto' }}>
              <Button
                size="small"
                sx={{ minWidth: 0, px: 0.5, fontSize: '0.72rem' }}
                onClick={() => setSelectedKeys(featureOptions)}
              >
                All
              </Button>
              <Button
                size="small"
                sx={{ minWidth: 0, px: 0.5, fontSize: '0.72rem' }}
                onClick={() => setSelectedKeys([])}
              >
                None
              </Button>
            </Stack>
          </Stack>
          {/* Selection summary instead of chips — datasets can have dozens
              of features (e.g. 54 Rubik's stickers), which chips don't scale to. */}
          <Autocomplete
            multiple
            size="small"
            options={featureOptions}
            value={selectedKeys}
            onChange={(_e, value) => setSelectedKeys(value)}
            disableCloseOnSelect
            renderTags={() => null}
            getOptionLabel={featureOptionLabel}
            renderOption={(props, option, { selected }) => (
              <li {...props} key={option}>
                <Checkbox size="small" checked={selected} sx={{ mr: 0.5, p: 0.25 }} />
                {featureOptionLabel(option)}
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder={`${selectedKeys.length} of ${featureOptions.length} selected`}
                inputProps={{ ...params.inputProps, 'aria-label': 'Features to project' }}
              />
            )}
            sx={{ mb: 2 }}
          />

          <LabeledSlider
            label="Neighbors"
            tooltip="UMAP nNeighbors: size of the local neighborhood used to balance local versus global structure. Small values emphasize fine detail, large values the overall shape."
            value={nNeighbors}
            onChange={(_e, v) => setNNeighbors(v as number)}
            config={N_NEIGHBORS_CONFIG}
            defaultValue={15}
          />
          <LabeledSlider
            label="Min distance"
            tooltip="UMAP minDist: how tightly points may pack in the embedding. Lower values give denser clumps, higher values a more even spread."
            value={minDist}
            onChange={(_e, v) => setMinDist(v as number)}
            config={MIN_DIST_CONFIG}
            defaultValue={0.1}
          />
          <LabeledSlider
            label="Epochs"
            tooltip="Optimization epochs. 'auto' (0) lets UMAP choose based on dataset size; more epochs converge further but take longer."
            value={nEpochs}
            onChange={(_e, v) => setNEpochs(v as number)}
            config={EPOCHS_CONFIG}
            defaultValue={0}
            valueLabelFormat={(v) => (v === 0 ? 'auto' : String(v))}
            unfold={
              <LabeledSlider
                label="Spread"
                tooltip="UMAP spread: effective scale of embedded points; works together with min distance."
                value={spread}
                onChange={(_e, v) => setSpread(v as number)}
                config={SPREAD_CONFIG}
                defaultValue={1.0}
              />
            }
          />

          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <FormControl size="small" sx={{ flex: 1 }}>
              <InputLabel id="projection-metric-label">Metric</InputLabel>
              <Select
                labelId="projection-metric-label"
                label="Metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value as UmapMetric)}
              >
                <MenuItem value="euclidean">Euclidean</MenuItem>
                <MenuItem value="cosine">Cosine</MenuItem>
                <MenuItem value="manhattan">Manhattan</MenuItem>
              </Select>
            </FormControl>
            <Tooltip
              title="Random seed: equal seeds reproduce the same embedding for identical inputs and parameters."
              arrow
              enterDelay={150}
            >
              <TextField
                size="small"
                label="Seed"
                type="number"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value) || 0)}
                sx={{ width: 88 }}
              />
            </Tooltip>
          </Stack>

          <Tooltip
            title="Z-score each feature before projecting so features with large value ranges don't dominate the distances."
            arrow
            enterDelay={150}
          >
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={standardize}
                  onChange={(e) => setStandardize(e.target.checked)}
                />
              }
              label={<Typography variant="body2">Standardize features</Typography>}
              sx={{ mb: 1.5 }}
            />
          </Tooltip>

          <Stack direction="row" spacing={1}>
            {!isRunning ? (
              <Tooltip
                title={
                  serverResident
                    ? "This dataset's features live on the server, so a projection computed here would only see the columns already downloaded. Reprojection is available on locally loaded datasets."
                    : ""
                }
                arrow
                enterDelay={150}
              >
                <span>
                  <Button variant="contained" size="small" onClick={handleRun} disabled={runDisabled}>
                    Run projection
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button variant="outlined" size="small" color="warning" onClick={handleCancel}>
                Cancel
              </Button>
            )}
            <Tooltip
              title="Return to the projection the dataset was loaded with (including its precomputed neighbor graph and cluster hierarchy)."
              arrow
              enterDelay={150}
            >
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleRestore}
                  disabled={!canRestoreProjection}
                >
                  Restore original
                </Button>
              </span>
            </Tooltip>
          </Stack>

          {featureOptions.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
              No features found in the current dataset.
            </Typography>
          )}
          {lastRunNote && (
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
              {lastRunNote}
            </Typography>
          )}
          {errorNote && (
            <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: 1 }}>
              {errorNote}
            </Typography>
          )}
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default ProjectionTabPanel;
