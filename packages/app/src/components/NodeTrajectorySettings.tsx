import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Slider, Stack, TextField, Typography } from "@mui/material";
import React, { SyntheticEvent, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { getDatasetVisualPreset } from "src/config/datasetVisualPresets";
import { useRendererApiRef } from "../contexts/RendererApiContext";
import type { StyleSettings } from "../gl/api";
import { RootState, initialVisualizationSettings, setAnnotationLabelScale, updateSettings } from "../store";
import { clearOpacityClampingPreview, setOpacityClampingPreview } from "../stores/opacityClampingPreviewStore";
import { computeThumbResetValue, getThumbIndexFromEvent, useInstantReset } from "../utils/sliderReset";
import { cubicSliderToValue, cubicValueToSlider, formatSliderLabel } from "../utils/sliderUtils";
import ColorEncodingSettings from "./ColorEncodingSettings";
import SettingsSegmentedControl from "./clusterSettings/controls/SettingsSegmentedControl";

type StyleKey = "nodeRadius" | "nodeOutlineWidth" | "edgeWidth" | "arrowScale";

const nodeTrajectoryOptions: Array<{ label: string; key: StyleKey; min: number; max: number; step: number }> = [
  { label: "Node Radius", key: "nodeRadius", min: 1, max: 40, step: 0.5 },
  { label: "Node Outline", key: "nodeOutlineWidth", min: 0, max: 10, step: 0.1 },
  { label: "Edge Width", key: "edgeWidth", min: 1, max: 20, step: 0.1 },
  { label: "Arrow Scale", key: "arrowScale", min: 1, max: 20, step: 0.1 },
];

const outlineColorOptions = [
  { value: "black" as const, label: "Black" },
  { value: "white" as const, label: "White" },
];

type OpacityRange = { min: number; max: number };

const ANNOTATION_SCALE_PREVIEW_VAR = "--annotation-label-scale-preview-mult";

/**
 * Positions closer than this are treated as identical when reflecting external
 * store changes into the opacity thumbs. It prevents a float-dust echo of our
 * own just-committed value (cbrt(q³) ≈ q) from re-setting position state and
 * spinning a render loop. Any perceptible external change (preset, reset) moves
 * a position far more than this.
 */
const OPACITY_POSITION_EPS = 1e-4;

/**
 * Clamp a pair of numbers to [0, 1] and return them in ascending order.
 *
 * Used to keep the opacity-range slider's emitted `[min, max]` inside the unit
 * interval and never inverted, regardless of what raw positions `onChange`
 * hands us. `disableSwap` on the Slider already stops thumbs crossing during a
 * gesture; this is the defensive belt-and-braces guaranteeing the renderer's
 * opacity params are always `0 ≤ min ≤ max ≤ 1`. Exported for unit testing the
 * invariant. Because the cubic warp is monotone, ordering positions and
 * ordering the resulting values are equivalent.
 */
export function clampOrder01(a: number, b: number): [number, number] {
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const lo = clamp(a);
  const hi = clamp(b);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

interface NodeTrajectorySettingsProps {
  showColorEncoding?: boolean;
  defaultExpanded?: boolean;
}

const NodeTrajectorySettings: React.FC<NodeTrajectorySettingsProps> = ({
  showColorEncoding = true,
  defaultExpanded = true,
}) => {
  const dispatch = useDispatch();
  const s = useSelector((state: RootState) => state.visualizationSettings);
  const datasetType = useSelector((state: RootState) => state.dataset.datasetType);
  const datasetPath = useSelector((state: RootState) => state.dataset.datasetPath);

  const apiRef = useRendererApiRef();

  // Shared instant-reset hook: suppresses MUI thumb/track transitions for one
  // paint cycle whenever any double-click reset fires in this component.
  const { noTransitionSx, prepareInstantReset } = useInstantReset();

  // -------------------------
  // Style (node radius / edge width / arrow scale) preview + commit
  // -------------------------
  const [draftStyle, setDraftStyle] = React.useState<StyleSettings>(() => ({
    nodeRadius: s.nodeRadius,
    nodeOutlineWidth: s.nodeOutlineWidth,
    edgeWidth: s.edgeWidth,
    arrowScale: s.arrowScale,
  }));

  const [draftColors, setDraftColors] = React.useState({
    uiAccentColor: s.uiAccentColor,
    sidePanelBgColor: s.sidePanelBgColor,
    canvasBgColor: s.canvasBgColor,
  });
  const colorDebounceRefs = React.useRef<Record<'uiAccentColor' | 'sidePanelBgColor' | 'canvasBgColor', number | null>>({
    uiAccentColor: null,
    sidePanelBgColor: null,
    canvasBgColor: null,
  });

  const rafIdRef = React.useRef<number | null>(null);
  const pendingStyleRef = React.useRef<StyleSettings>(draftStyle);

  React.useEffect(() => {
    const next: StyleSettings = {
      nodeRadius: s.nodeRadius,
      nodeOutlineWidth: s.nodeOutlineWidth,
      edgeWidth: s.edgeWidth,
      arrowScale: s.arrowScale,
    };
    setDraftStyle(next);
    pendingStyleRef.current = next;
  }, [s.nodeRadius, s.nodeOutlineWidth, s.edgeWidth, s.arrowScale]);

  React.useEffect(() => {
    setDraftColors({
      uiAccentColor: s.uiAccentColor,
      sidePanelBgColor: s.sidePanelBgColor,
      canvasBgColor: s.canvasBgColor,
    });
  }, [s.uiAccentColor, s.sidePanelBgColor, s.canvasBgColor]);

  React.useEffect(() => {
    const debounceTimers = colorDebounceRefs.current;
    return () => {
      (Object.keys(debounceTimers) as Array<'uiAccentColor' | 'sidePanelBgColor' | 'canvasBgColor'>).forEach((k) => {
        const t = debounceTimers[k];
        if (t !== null) window.clearTimeout(t);
      });
    };
  }, []);

  const scheduleStylePreview = React.useCallback(
    (next: StyleSettings) => {
      pendingStyleRef.current = next;

      if (rafIdRef.current !== null) return;

      rafIdRef.current = window.requestAnimationFrame(() => {
        rafIdRef.current = null;
        apiRef.current?.setStyle(pendingStyleRef.current);
      });
    },
    [apiRef]
  );

  React.useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // -------------------------
  // Opacity clamping preview + commit (WebGL)
  //
  // Cubic low-end warp (issue #315): the range slider runs on raw POSITIONS
  // q ∈ [0, 1] (fine 0.001 step); the semantic opacity the renderer receives is
  // v = q³ (cubicSliderToValue), giving the bottom band fine resolution. The
  // positions are the single source of truth while a gesture is active, so the
  // controlled `value` never round-trips through cbrt(store). That round-trip
  // (value={cbrt(state)} + step snap + onChange emitting cube(position)) is a
  // step-grid oscillation, not a float fixpoint — it was the flicker /
  // non-determinism source in the reverted attempt. External store changes
  // reflect into the positions ONLY when no gesture is active, guarded by an
  // epsilon so an echo of our own committed value cannot start a render loop.
  // -------------------------
  const [opacityPositions, setOpacityPositions] = React.useState<[number, number]>(() => [
    cubicValueToSlider(s.minimumOpacityClamping),
    cubicValueToSlider(s.maximumOpacityClamping),
  ]);
  const opacityDraggingRef = React.useRef(false);

  const opacityRafIdRef = React.useRef<number | null>(null);
  const pendingOpacityRef = React.useRef<OpacityRange>({
    min: s.minimumOpacityClamping,
    max: s.maximumOpacityClamping,
  });
  const opacityThresholdRef = React.useRef<number>(s.grayOutDoiThreshold);

  React.useEffect(() => {
    opacityThresholdRef.current = s.grayOutDoiThreshold;
  }, [s.grayOutDoiThreshold]);

  // Reflect external store changes into the thumb positions — but never
  // mid-drag (the ref gates it) and never when the target only differs by
  // float dust from the current position (the epsilon gate stops render loops).
  React.useEffect(() => {
    const min = s.minimumOpacityClamping;
    const max = s.maximumOpacityClamping;
    pendingOpacityRef.current = { min, max };
    setOpacityClampingPreview({ min, max });

    if (opacityDraggingRef.current) return;

    const targetLo = cubicValueToSlider(min);
    const targetHi = cubicValueToSlider(max);
    setOpacityPositions((prev) =>
      Math.abs(prev[0] - targetLo) < OPACITY_POSITION_EPS &&
      Math.abs(prev[1] - targetHi) < OPACITY_POSITION_EPS
        ? prev
        : [targetLo, targetHi],
    );
  }, [s.minimumOpacityClamping, s.maximumOpacityClamping]);

  React.useEffect(() => {
    return () => {
      clearOpacityClampingPreview();
    };
  }, []);

  const scheduleOpacityPreview = React.useCallback(() => {
    if (opacityRafIdRef.current !== null) return;

    opacityRafIdRef.current = window.requestAnimationFrame(() => {
      opacityRafIdRef.current = null;

      const { min, max } = pendingOpacityRef.current;
      apiRef.current?.setOpacityParams({
        threshold: opacityThresholdRef.current,
        minAlpha: min,
        maxAlpha: max,
      });
      setOpacityClampingPreview({ min, max });
    });
  }, [apiRef]);

  React.useEffect(() => {
    return () => {
      if (opacityRafIdRef.current !== null) {
        window.cancelAnimationFrame(opacityRafIdRef.current);
        opacityRafIdRef.current = null;
      }
    };
  }, []);

  // Drag preview: hold RAW positions locally, emit clamped/ordered cubed values.
  const handleOpacityRangePreview = useCallback(
    (_: Event | SyntheticEvent<Element, Event>, val: number | number[]) => {
      if (!Array.isArray(val)) return;
      const [qLo, qHi] = clampOrder01(val[0], val[1]);
      // Interactive quality reduction (issue #315 §10.1): the opacity-clamp drag
      // repaints the full 1M cloud per tick, so drop the backing-store
      // resolution for the gesture. Idempotent; the commit handler restores it.
      apiRef.current?.setInteractiveQuality?.(true);
      opacityDraggingRef.current = true;
      setOpacityPositions([qLo, qHi]);
      const min = cubicSliderToValue(qLo);
      const max = cubicSliderToValue(qHi);
      pendingOpacityRef.current = { min, max };
      scheduleOpacityPreview();
    },
    [scheduleOpacityPreview, apiRef],
  );

  const handleOpacityRangeCommit = useCallback(
    (_: Event | SyntheticEvent<Element, Event>, val: number | number[]) => {
      if (!Array.isArray(val)) return;
      const [qLo, qHi] = clampOrder01(val[0], val[1]);
      setOpacityPositions([qLo, qHi]);
      opacityDraggingRef.current = false;
      const min = cubicSliderToValue(qLo);
      const max = cubicSliderToValue(qHi);
      setOpacityClampingPreview({ min, max });
      // Restore full render resolution (issue #315 §10.1) now the drag is over;
      // the commit render below then repaints at full quality.
      apiRef.current?.setInteractiveQuality?.(false);
      dispatch(updateSettings({ minimumOpacityClamping: min, maximumOpacityClamping: max }));
    },
    [dispatch, apiRef],
  );

  // -------------------------
  // Double-click reset handlers
  // -------------------------

  /**
   * Resets the double-clicked style slider thumb (nodeRadius / nodeOutlineWidth /
   * edgeWidth / arrowScale) to its default.  Updates draft state, schedules a
   * WebGL preview, and commits to the Redux store immediately.
   */
  const handleStyleDoubleClick = useCallback(
    (key: StyleKey, e: React.MouseEvent) => {
      const thumbIndex = getThumbIndexFromEvent(e);
      if (thumbIndex === null) return;
      // These are all single-thumb sliders; thumbIndex is always 0.
      const defaultVal = initialVisualizationSettings[key];
      const next = { ...pendingStyleRef.current, [key]: defaultVal } as StyleSettings;
      prepareInstantReset();
      setDraftStyle(next);
      pendingStyleRef.current = next;
      apiRef.current?.setStyle(next);
      dispatch(updateSettings({ [key]: defaultVal } as Partial<RootState['visualizationSettings']>));
    },
    [dispatch, apiRef, prepareInstantReset],
  );

  /**
   * Resets the double-clicked opacity-range thumb to its default, applying the
   * change to both draft state and the Redux store.
   */
  const handleOpacityDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const thumbIndex = getThumbIndexFromEvent(e);
      if (thumbIndex === null) return;
      const defaultOpacity = [
        initialVisualizationSettings.minimumOpacityClamping,
        initialVisualizationSettings.maximumOpacityClamping,
      ];
      // Operate in TRUE-value space, reading the committed store values (exact,
      // no cbrt dust) as the current pair; reset only the clicked thumb.
      const current = [s.minimumOpacityClamping, s.maximumOpacityClamping];
      const reset = computeThumbResetValue(defaultOpacity, current, thumbIndex) as number[];
      const [min, max] = clampOrder01(reset[0], reset[1]);
      prepareInstantReset();
      setOpacityPositions([cubicValueToSlider(min), cubicValueToSlider(max)]);
      opacityDraggingRef.current = false;
      pendingOpacityRef.current = { min, max };
      apiRef.current?.setOpacityParams({
        threshold: opacityThresholdRef.current,
        minAlpha: min,
        maxAlpha: max,
      });
      setOpacityClampingPreview({ min, max });
      dispatch(updateSettings({ minimumOpacityClamping: min, maximumOpacityClamping: max }));
    },
    [s.minimumOpacityClamping, s.maximumOpacityClamping, dispatch, apiRef, prepareInstantReset],
  );

  /**
   * Resets the annotation-label-scale slider thumb to its default.
   */
  const handleAnnotationScaleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const thumbIndex = getThumbIndexFromEvent(e);
      if (thumbIndex === null) return;
      const defaultVal = initialVisualizationSettings.annotationLabelScale;
      prepareInstantReset();
      setDraftAnnotationScale(defaultVal);
      annPendingRef.current = defaultVal;
      document.documentElement.style.removeProperty(ANNOTATION_SCALE_PREVIEW_VAR);
      dispatch(setAnnotationLabelScale(defaultVal));
    },
    [dispatch, prepareInstantReset],
  );

  const handleStyleColorChange =
    (key: 'uiAccentColor' | 'sidePanelBgColor' | 'canvasBgColor') =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setDraftColors((prev) => ({ ...prev, [key]: next }));
      const existing = colorDebounceRefs.current[key];
      if (existing !== null) {
        window.clearTimeout(existing);
      }
      colorDebounceRefs.current[key] = window.setTimeout(() => {
        dispatch(updateSettings({ [key]: next }));
      }, 80);
    };

  const handleApplyArtisticPreset = useCallback(() => {
    dispatch(
      updateSettings({
        colorEncoding: "DoI",
        colorPalette: ["#f8b195", "#f67280", "#c06c84", "#6c5b7b", "#355c7d"],
        colorMapRotationOffset: 0,
        sidePanelBgColor: "#F0E6DA",
        canvasBgColor: "#F0E6DA",
        uiAccentColor: "#C06C84",
        minimumOpacityClamping: 0,
        maximumOpacityClamping: 1,
      })
    );
  }, [dispatch]);

  const handleApplyDefaultDoiPreset = useCallback(() => {
    const datasetDefaults = {
      ...initialVisualizationSettings,
      ...getDatasetVisualPreset({ datasetType, datasetPath }),
    };

    dispatch(
      updateSettings({
        colorEncoding: datasetDefaults.colorEncoding,
        colorPalette: datasetDefaults.colorPalette,
        colorMapRotationOffset: datasetDefaults.colorMapRotationOffset,
        sidePanelBgColor: datasetDefaults.sidePanelBgColor,
        canvasBgColor: datasetDefaults.canvasBgColor,
        uiAccentColor: datasetDefaults.uiAccentColor,
        minimumOpacityClamping: datasetDefaults.minimumOpacityClamping,
        maximumOpacityClamping: datasetDefaults.maximumOpacityClamping,
        clusterLabelStrategy: datasetDefaults.clusterLabelStrategy,
        tfidfCorpusScope: datasetDefaults.tfidfCorpusScope,
        annotationTagDelimiter: datasetDefaults.annotationTagDelimiter,
        annotationLabelFeature: datasetDefaults.annotationLabelFeature,
      })
    );
  }, [dispatch, datasetType, datasetPath]);

  // -------------------------
  // Annotation label scale preview + commit (JSX overlay; NOT WebGL)
  // Preview uses a CSS var multiplier to avoid Redux churn on drag.
  // -------------------------
  const [draftAnnotationScale, setDraftAnnotationScale] = React.useState<number>(() => s.annotationLabelScale);

  const annCommittedRef = React.useRef<number>(s.annotationLabelScale);
  const annPendingRef = React.useRef<number>(draftAnnotationScale);
  const annRafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    annCommittedRef.current = s.annotationLabelScale;
  }, [s.annotationLabelScale]);

  React.useEffect(() => {
    setDraftAnnotationScale(s.annotationLabelScale);
    annPendingRef.current = s.annotationLabelScale;

    // If something external updates the store (reset/preset), clear preview override.
    document.documentElement.style.removeProperty(ANNOTATION_SCALE_PREVIEW_VAR);
  }, [s.annotationLabelScale]);

  const scheduleAnnotationScalePreview = React.useCallback(() => {
    if (annRafRef.current !== null) return;

    annRafRef.current = window.requestAnimationFrame(() => {
      annRafRef.current = null;

      const committed = annCommittedRef.current || 1;
      const draft = annPendingRef.current;

      const mult = draft / committed;
      document.documentElement.style.setProperty(ANNOTATION_SCALE_PREVIEW_VAR, String(mult));
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (annRafRef.current !== null) {
        window.cancelAnimationFrame(annRafRef.current);
        annRafRef.current = null;
      }
      document.documentElement.style.removeProperty(ANNOTATION_SCALE_PREVIEW_VAR);
    };
  }, []);

  // -------------------------
  // Render
  // -------------------------
  return (
    <>
      <Accordion defaultExpanded={defaultExpanded}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography variant="subtitle1">Nodes &amp; Trajectories</Typography>
      </AccordionSummary>

      <AccordionDetails>
        {showColorEncoding && (
          <Box sx={{ mb: 3 }}>
            <ColorEncodingSettings nested />
          </Box>
        )}

        {nodeTrajectoryOptions.map(({ label, key, min, max, step }) => (
          <React.Fragment key={key}>
            <Box
              sx={{ mb: 3 }}
              onDoubleClick={(e) => handleStyleDoubleClick(key, e)}
            >
              <Typography variant="body2">{label}</Typography>
              <Slider
                value={draftStyle[key]}
                onChange={(_, val) => {
                  const v = Array.isArray(val) ? val[0] : val;

                  setDraftStyle((prev) => {
                    const next = { ...prev, [key]: v } as StyleSettings;
                    scheduleStylePreview(next);
                    return next;
                  });
                }}
                onChangeCommitted={(_, val) => {
                  const v = Array.isArray(val) ? val[0] : val;
                  dispatch(updateSettings({ [key]: v } as Partial<RootState["visualizationSettings"]>));
                }}
                step={step}
                min={min}
                max={max}
                marks={[
                  { value: min, label: String(min) },
                  { value: max, label: String(max) },
                ]}
                valueLabelDisplay="auto"
                valueLabelFormat={formatSliderLabel}
                sx={noTransitionSx}
              />
            </Box>

            {key === "nodeOutlineWidth" && (
              <Box sx={{ mb: 3 }}>
                <SettingsSegmentedControl
                  label="Node Outline Color"
                  value={s.nodeOutlineWhite ? "white" : "black"}
                  options={outlineColorOptions}
                  onChange={(v) => dispatch(updateSettings({ nodeOutlineWhite: v === "white" }))}
                />
              </Box>
            )}
          </React.Fragment>
        ))}

        <Box sx={{ mb: 3 }} onDoubleClick={handleAnnotationScaleDoubleClick}>
          <Typography variant="body2">Annotation label size</Typography>
          <Slider
            value={draftAnnotationScale}
            onChange={(_, val) => {
              const v = Array.isArray(val) ? val[0] : val;

              setDraftAnnotationScale(v);
              annPendingRef.current = v;
              scheduleAnnotationScalePreview();
            }}
            onChangeCommitted={(_, val) => {
              const v = Array.isArray(val) ? val[0] : val;

              // Commit once
              dispatch(setAnnotationLabelScale(v));

              // Clear preview override so committed store value is the only scale factor.
              document.documentElement.style.removeProperty(ANNOTATION_SCALE_PREVIEW_VAR);
            }}
            step={0.05}
            min={0.5}
            max={2}
            marks={[
              { value: 0.5, label: "0.5×" },
              { value: 2, label: "2×" },
            ]}
            valueLabelDisplay="auto"
            valueLabelFormat={formatSliderLabel}
            sx={noTransitionSx}
          />
        </Box>

        <Box sx={{ mb: 3 }} onDoubleClick={handleOpacityDoubleClick}>
          <Typography variant="body2">Opacity Clamping Range</Typography>
          <Slider
            value={opacityPositions}
            onChange={handleOpacityRangePreview}
            onChangeCommitted={handleOpacityRangeCommit}
            step={0.001}
            min={0}
            max={1}
            disableSwap
            // Positions drive the thumbs; `scale` maps a position back to its
            // true value v = q³ for the label (2 significant figures reads well
            // down in the fine low end: 0.004, 0.05, 0.32, 1). Endpoints exact.
            scale={cubicSliderToValue}
            marks={[
              { value: 0, label: "0" },
              { value: 1, label: "1" },
            ]}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => Number(value.toPrecision(2)).toString()}
            sx={noTransitionSx}
          />
        </Box>
      </AccordionDetails>
      </Accordion>

      <Accordion disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle1">Visual Theme</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1}>
            <TextField
              type="color"
              label="UI accent"
              size="small"
              value={draftColors.uiAccentColor}
              onChange={handleStyleColorChange('uiAccentColor')}
              helperText="Controls slider and interactive accent color"
            />
            <TextField
              type="color"
              label="Side panel background"
              size="small"
              value={draftColors.sidePanelBgColor}
              onChange={handleStyleColorChange('sidePanelBgColor')}
            />
            <TextField
              type="color"
              label="Canvas background"
              size="small"
              value={draftColors.canvasBgColor}
              onChange={handleStyleColorChange('canvasBgColor')}
            />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <Button size="small" variant="outlined" onClick={handleApplyArtisticPreset}>
                Encode DoI by Color
              </Button>
              <Button size="small" variant="outlined" onClick={handleApplyDefaultDoiPreset}>
                Apply Default DoI Preset
              </Button>
            </Stack>
          </Stack>
        </AccordionDetails>
      </Accordion>
    </>
  );
};

export default NodeTrajectorySettings;
