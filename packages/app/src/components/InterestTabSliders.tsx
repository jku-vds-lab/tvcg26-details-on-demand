import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Collapse, Grid, IconButton, Slider, Stack, Typography, useTheme } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import type { FeatureSearchDeps } from "../hooks/useFeatureSearch";
import FalloffShapeControl from "./SidePanel/FalloffShapeControl";
import { initialVisualizationSettings } from "../store";
import {
  getLiveSliderSettings,
  subscribeLiveSliderSettings,
} from "../stores/liveSliderSettingsStore";
import { computeThumbResetValue, getThumbIndexFromEvent, useInstantReset } from "../utils/sliderReset";
import {
  chainReachSliderToWeight,
  chainReachWeightToSlider,
  proximitySliderToValue,
  proximityValueToSlider,
} from "../utils/sliderUtils";
import {
  getMedianTrajectoryLength,
  subscribeMedianTrajectoryLength,
} from "../utils/trajectoryStats";
import FeatureSearchInput from "./FeatureSearchInput";

export interface SliderSettings {
  proximitySlider: number;
  pastSlider: number;
  futureSlider: number;
  grayOutDoiThreshold: number;
  annotationDoiThreshold: number;
  insetDoiThreshold: number;
}

interface InterestTabSlidersProps {
  initialProximity: number;
  initialPast: number;
  initialFuture: number;
  initialDoiThresholds: [number, number, number]; // [hidden, annotations, insets]
  onSliderChange: (newSettings: {
    proximitySlider: number;
    pastSlider: number;
    futureSlider: number;
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  }) => void;
  onSliderChangeCommitted?: (newSettings: {
    proximitySlider: number;
    pastSlider: number;
    futureSlider: number;
    grayOutDoiThreshold: number;
    annotationDoiThreshold: number;
    insetDoiThreshold: number;
  }) => void;
  featureSearchDeps: FeatureSearchDeps;
  hideFeatureSearch?: boolean;
  compact?: boolean;
}

const InterestTabSliders: React.FC<InterestTabSlidersProps> = ({
  initialProximity,
  initialPast,
  initialFuture,
  initialDoiThresholds,
  onSliderChange,
  onSliderChangeCommitted,
  featureSearchDeps,
  hideFeatureSearch = false,
  compact = false,
}) => {
  const [proximity, setProximity] = useState(initialProximity);
  const [past, setPast] = useState(initialPast);
  const [future, setFuture] = useState(initialFuture);
  const [doiThresholds, setDoiThresholds] = useState<[number, number, number]>(initialDoiThresholds);

  // Falloff radio lives behind the Proximity label's inline unfold arrow (the
  // same expert idiom the cluster-budget sub-sliders use). Available on EVERY
  // dataset since the client field lane (issue #315 field parity): without a
  // provider the distance field is computed locally, so the shapes always work.
  const [falloffOpen, setFalloffOpen] = useState(false);
  const falloffAvailable = true;

  const isDoiDraggingRef = useRef(false);

  // Median trajectory length of the current dataset — the reach-linear
  // Backward/Forward mapping's scale (utils/trajectoryStats; set once per
  // dataset load, so this re-renders only on dataset switches).
  const [trajLen, setTrajLen] = useState(getMedianTrajectoryLength());
  useEffect(
    () =>
      subscribeMedianTrajectoryLength(() => setTrajLen(getMedianTrajectoryLength())),
    []
  );

  useEffect(() => { setProximity(initialProximity); }, [initialProximity]);
  useEffect(() => { setPast(initialPast); }, [initialPast]);
  useEffect(() => { setFuture(initialFuture); }, [initialFuture]);

  // Live-value subscription (issue #330): programmatic drags (demo glide)
  // publish per-frame values to the live store instead of App state, so the
  // thumbs must follow it here. During a USER drag the store echoes this
  // component's own values — every setter bails on Object.is equality, so
  // the subscription adds zero re-renders to a manual drag.
  useEffect(() => {
    return subscribeLiveSliderSettings(() => {
      const v = getLiveSliderSettings();
      setProximity((p) => (p === v.proximitySlider ? p : v.proximitySlider));
      setPast((p) => (p === v.pastSlider ? p : v.pastSlider));
      setFuture((f) => (f === v.futureSlider ? f : v.futureSlider));
      setDoiThresholds((t) =>
        t[0] === v.grayOutDoiThreshold &&
        t[1] === v.annotationDoiThreshold &&
        t[2] === v.insetDoiThreshold
          ? t
          : [v.grayOutDoiThreshold, v.annotationDoiThreshold, v.insetDoiThreshold]
      );
    });
  }, []);

  useEffect(() => {
    if (isDoiDraggingRef.current) return;
    const [a, b, c] = doiThresholds;
    const [na, nb, nc] = initialDoiThresholds;
    if (a !== na || b !== nb || c !== nc) {
      setDoiThresholds(initialDoiThresholds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDoiThresholds[0], initialDoiThresholds[1], initialDoiThresholds[2]]);

  const theme = useTheme();
  const sliderColor = theme.palette.primary.main;

  // Suppresses MUI thumb/track CSS transitions for one paint when any reset fires.
  const { noTransitionSx, prepareInstantReset } = useInstantReset();

  const makeSettings = (overrides: Partial<SliderSettings> = {}): SliderSettings => ({
    proximitySlider: overrides.proximitySlider ?? proximity,
    pastSlider: overrides.pastSlider ?? past,
    futureSlider: overrides.futureSlider ?? future,
    grayOutDoiThreshold: overrides.grayOutDoiThreshold ?? doiThresholds[0],
    annotationDoiThreshold: overrides.annotationDoiThreshold ?? doiThresholds[1],
    insetDoiThreshold: overrides.insetDoiThreshold ?? doiThresholds[2],
  });

  // ── Proximity: UI-only while dragging; commit does heavy work
  // The thumb runs on a POSITION q with a fine step; the semantic value is the
  // cubic warp p = q³ (issue #315 A3), so the settings flow only ever sees p.
  const handleProximityChange = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const v = proximitySliderToValue(newValue as number);
    setProximity(v);
    onSliderChange(makeSettings({ proximitySlider: v }));
  };
  const handleProximityChangeCommitted = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const v = proximitySliderToValue(newValue as number);
    setProximity(v);
    onSliderChangeCommitted?.(makeSettings({ proximitySlider: v }));
  };
  const handleProximityDoubleClick = (e: React.MouseEvent) => {
    if (getThumbIndexFromEvent(e) === null) return;
    const def = initialVisualizationSettings.proximitySlider;
    prepareInstantReset();
    setProximity(def);
    const s = makeSettings({ proximitySlider: def });
    onSliderChange(s);
    onSliderChangeCommitted?.(s);
  };

  // Backward (past): preview during drag. REACH-LINEAR mapping (CS
  // 2026-08-17, third feel pass — see chainReachSliderToWeight): the thumb
  // is linear in the fraction of a typical trajectory the chain visibly
  // reaches (first ¾ of the track), then saturates the trail to full DoI
  // (last ¼). The store/settings flow only ever sees the true per-hop
  // weight w; log, cubic and identity thumb mappings were all rejected —
  // every weight-space mapping feels exponential because the chain IS w^k.
  const handlePastChange = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const w = chainReachSliderToWeight(newValue as number, trajLen);
    setPast(w);
    onSliderChange(makeSettings({ pastSlider: w }));
  };
  const handlePastChangeCommitted = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const w = chainReachSliderToWeight(newValue as number, trajLen);
    setPast(w);
    onSliderChangeCommitted?.(makeSettings({ pastSlider: w }));
  };
  const handlePastDoubleClick = (e: React.MouseEvent) => {
    if (getThumbIndexFromEvent(e) === null) return;
    const def = initialVisualizationSettings.pastSlider;
    prepareInstantReset();
    setPast(def);
    const s = makeSettings({ pastSlider: def });
    onSliderChange(s);
    onSliderChangeCommitted?.(s);
  };

  // Forward (future): same reach-linear mapping as Backward.
  const handleFutureChange = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const w = chainReachSliderToWeight(newValue as number, trajLen);
    setFuture(w);
    onSliderChange(makeSettings({ futureSlider: w }));
  };
  const handleFutureChangeCommitted = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const w = chainReachSliderToWeight(newValue as number, trajLen);
    setFuture(w);
    onSliderChangeCommitted?.(makeSettings({ futureSlider: w }));
  };
  const handleFutureDoubleClick = (e: React.MouseEvent) => {
    if (getThumbIndexFromEvent(e) === null) return;
    const def = initialVisualizationSettings.futureSlider;
    prepareInstantReset();
    setFuture(def);
    const s = makeSettings({ futureSlider: def });
    onSliderChange(s);
    onSliderChangeCommitted?.(s);
  };


  // ── DoI thresholds (3-thumb)
  // While dragging: GPU-only preview via uniforms (no propagation/clustering)
  // On release: heavy commit path runs once.
  const handleDoiThresholdsChange = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    isDoiDraggingRef.current = true;
    const vals = newValue as number[];
    const tuple = [vals[0], vals[1], vals[2]] as [number, number, number];
    setDoiThresholds(tuple);
    onSliderChange(
      makeSettings({
        grayOutDoiThreshold: tuple[0],
        annotationDoiThreshold: tuple[1],
        insetDoiThreshold: tuple[2],
      })
    );
  };
  const handleDoiThresholdsChangeCommitted = (_: React.SyntheticEvent | Event, newValue: number | number[]) => {
    const vals = newValue as number[];
    const tuple = [vals[0], vals[1], vals[2]] as [number, number, number];
    setDoiThresholds(tuple);
    isDoiDraggingRef.current = false;
    onSliderChangeCommitted?.(
      makeSettings({
        grayOutDoiThreshold: tuple[0],
        annotationDoiThreshold: tuple[1],
        insetDoiThreshold: tuple[2],
      })
    );
  };
  const handleDoiDoubleClick = (e: React.MouseEvent) => {
    const thumbIndex = getThumbIndexFromEvent(e);
    if (thumbIndex === null) return;
    const defaultDoi: [number, number, number] = [
      initialVisualizationSettings.grayOutDoiThreshold,
      initialVisualizationSettings.annotationDoiThreshold,
      initialVisualizationSettings.insetDoiThreshold,
    ];
    const newTuple = computeThumbResetValue(defaultDoi, doiThresholds, thumbIndex) as [number, number, number];
    prepareInstantReset();
    setDoiThresholds(newTuple);
    const s = makeSettings({
      grayOutDoiThreshold: newTuple[0],
      annotationDoiThreshold: newTuple[1],
      insetDoiThreshold: newTuple[2],
    });
    onSliderChange(s);
    onSliderChangeCommitted?.(s);
  };

  return (
    <Box sx={{ px: compact ? 0 : 2, py: compact ? 0 : 2 }}>
      {!compact && (
        <>
          <Typography variant="h6" sx={{ mb: 0.25 }}>
            Propagation
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
            Tune focus spread across neighborhood, backward context, and forward context.
          </Typography>
        </>
      )}

      <Box
        sx={{ mb: falloffAvailable && falloffOpen ? 0.5 : 2 }}
        onDoubleClick={handleProximityDoubleClick}
      >
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Proximity</Typography>
          {falloffAvailable && (
            <IconButton
              size="small"
              aria-label="Proximity details"
              aria-expanded={falloffOpen}
              onClick={() => setFalloffOpen((open) => !open)}
              sx={{ p: 0.25, ml: "auto" }}
            >
              <ExpandMoreIcon
                sx={{
                  fontSize: "1rem",
                  color: "text.secondary",
                  transform: falloffOpen ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 150ms",
                }}
              />
            </IconButton>
          )}
        </Stack>
        <Slider
          value={proximityValueToSlider(proximity)}
          onChange={handleProximityChange}
          onChangeCommitted={handleProximityChangeCommitted}
          step={0.001}
          min={0}
          max={1}
          valueLabelDisplay="auto"
          // `scale` maps the position back to the true value p for the label
          // (and feeds valueLabelFormat that p); 2 significant digits stays
          // readable down in the fine low end (0.004, 0.05, 0.32, 1).
          scale={proximitySliderToValue}
          valueLabelFormat={(value) => Number(value.toPrecision(2)).toString()}
          sx={{ color: sliderColor, ...noTransitionSx }}
        />
      </Box>
      {falloffAvailable && (
        // Mounted OUTSIDE the double-click-reset Box so the falloff buttons
        // never trip the Proximity reset. Commit re-runs propagation with the
        // component's current slider values — the same path a Proximity release
        // takes (the binding WorkflowTabPanel used to own).
        <Collapse in={falloffOpen}>
          <Box sx={{ mb: 2 }}>
            <FalloffShapeControl
              onCommit={() => onSliderChangeCommitted?.(makeSettings())}
            />
          </Box>
        </Collapse>
      )}

      <Grid container spacing={2}>
        <Grid item xs={6}>
          <Box onDoubleClick={handlePastDoubleClick}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>Backward</Typography>
            <Slider
              value={chainReachWeightToSlider(past, trajLen)}
              onChange={handlePastChange}
              onChangeCommitted={handlePastChangeCommitted}
              step={0.001}
              min={0}
              max={1}
              valueLabelDisplay="auto"
              // Label = the thumb position itself (CS 2026-08-17): linear
              // 0–1, read as "fraction of a typical trajectory reached"
              // (0.75+ = full length, deepening). The true per-hop weight
              // stays store-internal.
              valueLabelFormat={(value) => value.toFixed(2)}
              sx={{ color: sliderColor, ...noTransitionSx }}
            />
          </Box>
        </Grid>
        <Grid item xs={6}>
          <Box onDoubleClick={handleFutureDoubleClick}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>Forward</Typography>
            <Slider
              value={chainReachWeightToSlider(future, trajLen)}
              onChange={handleFutureChange}
              onChangeCommitted={handleFutureChangeCommitted}
              step={0.001}
              min={0}
              max={1}
              valueLabelDisplay="auto"
              valueLabelFormat={(value) => value.toFixed(2)}
              sx={{ color: sliderColor, ...noTransitionSx }}
            />
          </Box>
        </Grid>
      </Grid>

      <Box sx={{ mt: 4, mb: 2 }} onDoubleClick={handleDoiDoubleClick}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>DoI thresholds</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
          hidden, annotations, insets (left to right)
        </Typography>
        <Slider
          value={doiThresholds}
          onChange={handleDoiThresholdsChange}
          onChangeCommitted={handleDoiThresholdsChangeCommitted}
          valueLabelDisplay="auto"
          min={0}
          max={1}
          step={0.01}
          disableSwap
          sx={{ color: sliderColor, ...noTransitionSx }}
          slotProps={{ valueLabel: { style: { zIndex: 1500 } } }}
          valueLabelFormat={(value, index) => {
            switch (index) {
              case 0: return `hidden: ${value.toFixed(2)}`;
              case 1: return `annotations: ${value.toFixed(2)}`;
              case 2: return `insets: ${value.toFixed(2)}`;
              default: return value.toFixed(2);
            }
          }}
        />
      </Box>

      {!hideFeatureSearch && <FeatureSearchInput featureSearchDeps={featureSearchDeps} compact={compact} />}
    </Box>
  );
};

export default InterestTabSliders;
