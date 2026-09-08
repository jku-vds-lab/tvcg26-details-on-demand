import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { Box, IconButton, Stack, Tooltip, Typography, useMediaQuery } from "@mui/material";
import { alpha } from "@mui/material/styles";
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSelector } from "react-redux";
import type { RootState } from "src/store";
import { useLiveSliderSettings } from "src/stores/liveSliderSettingsStore";
import { useOpacityClampingPreview } from "src/stores/opacityClampingPreviewStore";
import { sampleDoiColorAt } from "src/utils/doiColorScale";
import { colorDiscoveryStore } from "src/utils/colorDiscoveryStore";
import { colorScale, colorScaleStore } from "src/utils/colorScale";
import { compareCategoryValue, getEffectiveFeatureKind, getLegendCategories } from "src/utils/featureKind";


type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const six = normalized.length === 3
    ? normalized
        .split("")
        .map((c) => c + c)
        .join("")
    : normalized;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(six);
  if (!match) return [127, 127, 127];
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function rgbToHex([r, g, b]: RGB): string {
  const toHex = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const clamped = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * clamped,
    a[1] + (b[1] - a[1]) * clamped,
    a[2] + (b[2] - a[2]) * clamped,
  ];
}

function opacityForDoi(doi: number, threshold: number, minAlpha: number, maxAlpha: number): number {
  const isGray = doi < threshold;
  if (isGray) return minAlpha;
  const denom = Math.max(1 - threshold, 1e-6);
  const t = Math.min(1, Math.max(0, (doi - threshold) / denom));
  return minAlpha + (maxAlpha - minAlpha) * t;
}

function buildGradientFromStops(stops: Array<{ offset: number; color: string }>): string {
  const serialized = stops
    .map((s) => `${s.color} ${(Math.min(1, Math.max(0, s.offset)) * 100).toFixed(1)}%`)
    .join(", ");
  return `linear-gradient(90deg, ${serialized})`;
}

const SHADER_NEUTRAL_GRAY = "#808080";

type LegendCardProps = {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  canvasBgColor: string;
  headerAction?: React.ReactNode;
};

const LegendCard: React.FC<LegendCardProps> = ({
  title,
  subtitle,
  children,
  canvasBgColor,
  headerAction,
}) => (
  <Box
    sx={{
      width: { xs: 228, sm: 248, md: 260 },
      borderRadius: 1,
      border: (t) => `1px solid ${t.palette.divider}`,
      backgroundColor: alpha(canvasBgColor, 0.94),
      backdropFilter: "blur(6px)",
      px: 1,
      py: 0.8,
    }}
  >
    <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ minHeight: 28, px: 0.3, mb: 0.6 }}>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ minWidth: 0 }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="caption" sx={{ color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {subtitle}
          </Typography>
        )}
      </Stack>
      {headerAction}
    </Stack>
    {children}
  </Box>
);

const ColorLegendDock: React.FC = () => {
  // Live values from the store (issue #330): threshold markers follow the
  // drag per frame without the App-state echo that used to re-render the
  // whole tree; commits and store-driven changes land here too.
  const sliderSettings = useLiveSliderSettings();
  const [collapsed, setCollapsed] = useState(false);
  const [showHoverPreview, setShowHoverPreview] = useState(false);
  const hoverPreviewTimerRef = useRef<number | null>(null);
  const legendContentId = useId();
  const supportsHoverPreview = useMediaQuery("(hover: hover) and (pointer: fine)");
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const transitionExpandMs = 180;
  const transitionFadeMs = 120;
  const previewDelayMs = 140;
  const { colorPalette, colorEncoding, canvasBgColor, minimumOpacityClamping, maximumOpacityClamping } = useSelector((s: RootState) => s.visualizationSettings);
  const opacityClampingPreview = useOpacityClampingPreview();
  const statsByKey = useSelector((s: RootState) => s.datasetFeatures.statsByKey);
  const featureTypeOverrides = useSelector((s: RootState) => s.datasetFeatures.featureTypeOverrides);

  const stats = useMemo(() => {
    if (!colorEncoding) return undefined;
    return statsByKey[colorEncoding];
  }, [statsByKey, colorEncoding]);

  const selectedOverride = colorEncoding ? featureTypeOverrides[colorEncoding] : undefined;
  const selectedKind = getEffectiveFeatureKind(colorEncoding || undefined, stats, selectedOverride);
  useSyncExternalStore(colorDiscoveryStore.subscribe, colorDiscoveryStore.getSnapshot);
  const discovered = colorDiscoveryStore.getKeys();
  const webglCounts = colorDiscoveryStore.getCounts();

  const legendCategories = useMemo(() => {
    const base = getLegendCategories(stats, selectedKind);
    if (discovered.length === 0) return base;
    const known = new Set(base.map((e) => e.value));
    // Once the renderer's full-dataset counts exist, a discovered key absent
    // from them is a GHOST from the previous dataset (the old renderer keeps
    // painting — and discovering — through a switch): drop it. Keys the
    // capped stats scan missed are still in the counts, so legit extras stay.
    const haveCounts = Object.keys(webglCounts).length > 0;
    const extra = discovered
      .filter((k) => !known.has(k) && (!haveCounts || k in webglCounts))
      .map((k): { value: string; count: number } => ({ value: k, count: 0 }));
    return extra.length === 0
      ? base
      : [...base, ...extra].sort((a, b) => compareCategoryValue(a.value, b.value));
  }, [stats, selectedKind, discovered, webglCounts]);
  const gradientCss = useMemo(() => {
    if (colorPalette.length === 0) return "linear-gradient(90deg, #999, #333)";
    return `linear-gradient(90deg, ${colorPalette.join(", ")})`;
  }, [colorPalette]);

  // Swatches ask the SAME scale the renderer paints with (2026-08-05 bug:
  // positional palette[idx] silently diverges from the scatter whenever the
  // scale's mapping isn't exactly the sorted row list — e.g. keys carried
  // across a dataset switch). scaleVersion re-renders on every rebuild.
  const scaleVersion = useSyncExternalStore(colorScaleStore.subscribe, colorScaleStore.getSnapshot);
  const legendColors = useMemo(() => {
    const categories = legendCategories;
    return categories.slice(0, 10).map((entry) => colorScale(entry.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- colorScale reads the module-level scale; scaleVersion is its change signal
  }, [legendCategories, scaleVersion]);

  const legendMinLabel = colorEncoding === "DoI" ? "0.000" : stats?.min?.toFixed?.(3) ?? "min";
  const legendMidLabel = colorEncoding === "DoI" ? "0.500" : selectedKind === "diverging" ? "0" : "mid";
  const legendMaxLabel = colorEncoding === "DoI" ? "1.000" : stats?.max?.toFixed?.(3) ?? "max";
  const liveMinimumOpacityClamping = opacityClampingPreview?.min ?? minimumOpacityClamping;
  const liveMaximumOpacityClamping = opacityClampingPreview?.max ?? maximumOpacityClamping;

  const isCategorical =
    (selectedKind === "categorical" || selectedKind === "boolean") &&
    legendCategories.length > 0;

  const isDoIColorEncoded = colorEncoding === "DoI";
  const showFeatureLegend = !isDoIColorEncoded;
  const encodedVariableLabel = colorEncoding && colorEncoding.length > 0 ? colorEncoding : "(none)";

  const doiThresholdMarkers = useMemo(
    () => [
      { key: "hidden", value: sliderSettings.grayOutDoiThreshold, label: "Visible threshold" },
      { key: "labeled", value: sliderSettings.annotationDoiThreshold, label: "Labeled threshold" },
      { key: "insets", value: sliderSettings.insetDoiThreshold, label: "Insets threshold" },
    ],
    [
      sliderSettings.grayOutDoiThreshold,
      sliderSettings.annotationDoiThreshold,
      sliderSettings.insetDoiThreshold,
    ]
  );

  const doiGradientCss = useMemo(() => {
    const bg = hexToRgb(canvasBgColor);
    const representativeFeatureColor = legendColors[0] ?? colorPalette[0] ?? "#F67280";
    const applyGrayBelowThreshold = !isDoIColorEncoded;
    const tHidden = Math.min(1, Math.max(0, sliderSettings.grayOutDoiThreshold));
    const tLabel = Math.min(1, Math.max(tHidden, sliderSettings.annotationDoiThreshold));
    const tInset = Math.min(1, Math.max(tLabel, sliderSettings.insetDoiThreshold));
    const tMid = (tLabel + tInset) * 0.5;
    const eps = 0.002;
    const preLabel = Math.max(tHidden, tLabel - eps);
    const preInset = Math.max(tLabel, tInset - eps);
    const samplePoints = [0, tHidden, preLabel, tLabel, tMid, preInset, tInset, 1];

    return buildGradientFromStops(
      samplePoints.map((d) => {
        const isGray = applyGrayBelowThreshold && d < sliderSettings.grayOutDoiThreshold;
        const alphaAtDoi = opacityForDoi(
          d,
          sliderSettings.grayOutDoiThreshold,
          liveMinimumOpacityClamping,
          liveMaximumOpacityClamping
        );
        const base = isGray
          ? SHADER_NEUTRAL_GRAY
          : isDoIColorEncoded
            ? sampleDoiColorAt(d, {
                hidden: sliderSettings.grayOutDoiThreshold,
                labeled: sliderSettings.annotationDoiThreshold,
                inset: sliderSettings.insetDoiThreshold,
              }, colorPalette)
            : representativeFeatureColor;
        const mixed = mixRgb(bg, hexToRgb(base), alphaAtDoi);
        return { offset: d, color: rgbToHex(mixed) };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the committed clamping values are deliberate recompute triggers alongside the live (drag-preview) values the body reads
  }, [
    canvasBgColor,
    sliderSettings.grayOutDoiThreshold,
    sliderSettings.annotationDoiThreshold,
    sliderSettings.insetDoiThreshold,
    minimumOpacityClamping,
    maximumOpacityClamping,
    liveMinimumOpacityClamping,
    liveMaximumOpacityClamping,
    isDoIColorEncoded,
    colorPalette,
    legendColors,
  ]);

  const renderThresholdMarkers = useMemo(
    () =>
      doiThresholdMarkers.map((marker) => (
        <Tooltip key={marker.key} title={marker.label} arrow enterDelay={120}>
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: `${(marker.value * 100).toFixed(1)}%`,
              width: 12,
              height: 20,
              transform: "translateX(-6px)",
              cursor: "help",
            }}
          >
            <Box
              sx={{
                position: "absolute",
                top: 0,
                left: "50%",
                width: 2,
                height: 20,
                borderRadius: 1,
                bgcolor: "text.primary",
                opacity: 0.75,
                transform: "translateX(-1px)",
              }}
            />
          </Box>
        </Tooltip>
      )),
    [doiThresholdMarkers]
  );

  const featureLegendContent = useMemo(() => {
    if (!showFeatureLegend) return null;
    if (isCategorical) {
      return (
        <Stack spacing={0.4}>
          {legendCategories.slice(0, 10).map((entry, idx) => (
            <Stack key={`${entry.value}-${idx}`} data-testid="legend-category-row" direction="row" spacing={1} alignItems="center">
              <Box sx={{ width: 11, height: 11, borderRadius: 0.5, bgcolor: legendColors[idx] ?? "#999" }} />
              <Typography variant="caption" sx={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {entry.value}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {webglCounts[entry.value] ?? entry.count}
              </Typography>
            </Stack>
          ))}
        </Stack>
      );
    }

    return (
      <>
        <Box sx={{ height: 12, borderRadius: 1, backgroundImage: gradientCss, mb: 0.6 }} />
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {legendMinLabel}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {legendMidLabel}
          </Typography>
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {legendMaxLabel}
          </Typography>
        </Stack>
      </>
    );
  }, [showFeatureLegend, isCategorical, legendCategories, legendColors, webglCounts, gradientCss, legendMinLabel, legendMidLabel, legendMaxLabel]);

  const featureColorTitle = encodedVariableLabel;
  const featureColorSubtitle = "Color";
  const doiOpacityTitle = "DoI";
  const doiOpacitySubtitle = "Opacity";
  const doiCombinedSubtitle = "Color + Opacity";

  const handleWheel: React.WheelEventHandler<HTMLDivElement> = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const clearHoverPreviewTimer = () => {
    if (hoverPreviewTimerRef.current !== null) {
      window.clearTimeout(hoverPreviewTimerRef.current);
      hoverPreviewTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearHoverPreviewTimer();
    };
  }, []);

  const shieldPointer: React.PointerEventHandler<HTMLDivElement> = (event) => {
    // Capture-phase shielding keeps canvas behaviors from claiming legend interactions.
    event.stopPropagation();
  };

  const handleToggle = () => {
    setShowHoverPreview(false);
    clearHoverPreviewTimer();
    setCollapsed((prev) => !prev);
  };

  const onHandlePointerEnter = () => {
    if (!supportsHoverPreview || !collapsed) return;
    clearHoverPreviewTimer();
    hoverPreviewTimerRef.current = window.setTimeout(() => {
      setShowHoverPreview(true);
    }, previewDelayMs);
  };

  const onHandlePointerLeave = () => {
    clearHoverPreviewTimer();
    setShowHoverPreview(false);
  };

  const onHandleKeyDown: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key === "Escape" && !collapsed) {
      event.preventDefault();
      setShowHoverPreview(false);
      clearHoverPreviewTimer();
      setCollapsed(true);
    }
  };

  const renderDoiLegendBody = () => (
    <>
      <Box sx={{ position: "relative", height: 20 }}>
        <Box data-testid="legend-opacity-gradient" data-gradient={doiGradientCss} sx={{ position: "absolute", top: 4, left: 0, right: 0, height: 12, borderRadius: 1 }} style={{ backgroundImage: doiGradientCss }} />
        {renderThresholdMarkers}
      </Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.45 }}>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          0
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          1
        </Typography>
      </Stack>
    </>
  );

  const renderColorLegendBody = () => featureLegendContent;

  const primaryTitle = collapsed ? "Legend" : (showFeatureLegend ? featureColorTitle : doiOpacityTitle);
  const primarySubtitle = collapsed ? undefined : (showFeatureLegend ? featureColorSubtitle : doiCombinedSubtitle);
  const showPreview = collapsed && showHoverPreview && supportsHoverPreview;
  const isVisuallyOpen = !collapsed || showPreview;

  const toggleControl = (
    <IconButton
      aria-label={collapsed ? "Show legend" : "Hide legend"}
      aria-controls={legendContentId}
      aria-expanded={!collapsed}
      title={collapsed ? "Show legend" : "Hide legend"}
      onClick={(event) => {
        event.stopPropagation();
        handleToggle();
      }}
      onPointerEnter={onHandlePointerEnter}
      onPointerLeave={onHandlePointerLeave}
      onKeyDown={onHandleKeyDown}
      sx={{
        width: 26,
        height: 26,
        borderRadius: "50%",
        border: (t) => `1px solid ${alpha(t.palette.divider, 0.9)}`,
        backgroundColor: alpha(canvasBgColor, 0.52),
        transition: reducedMotion
          ? "none"
          : "background-color 150ms ease, border-color 150ms ease, transform 120ms ease",
        "&:hover": {
          backgroundColor: (t) => alpha(t.palette.grey[500], 0.25),
          borderColor: (t) => alpha(t.palette.text.primary, 0.35),
        },
        "&:active": {
          transform: "scale(0.97)",
        },
        "&:focus-visible": {
          outline: (t) => `2px solid ${alpha(t.palette.primary.main, 0.9)}`,
          outlineOffset: 2,
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: collapsed ? "rotate(0deg)" : "rotate(180deg)",
          transition: reducedMotion ? "none" : "transform 170ms ease-in-out",
        }}
      >
        <KeyboardArrowDownIcon fontSize="small" />
      </Box>
    </IconButton>
  );

  return (
    <Box
      onPointerDownCapture={shieldPointer}
      onPointerMoveCapture={shieldPointer}
      onPointerUpCapture={shieldPointer}
      onPointerCancelCapture={shieldPointer}
      sx={{
        position: "absolute",
        top: 12,
        right: 16,
        zIndex: 20,
        pointerEvents: "auto",
      }}
    >
      <Stack
        data-legend-scroll-lock="true"
        onWheelCapture={handleWheel}
        onWheel={handleWheel}
        spacing={0.55}
      >
        <Box
        >
          <LegendCard
            title={primaryTitle}
            subtitle={primarySubtitle}
            canvasBgColor={canvasBgColor}
            headerAction={toggleControl}
          >
            <Box
              id={legendContentId}
              aria-hidden={collapsed}
              sx={{
                display: "grid",
                gridTemplateRows: isVisuallyOpen ? "1fr" : "0fr",
                transition: reducedMotion
                  ? "none"
                  : `grid-template-rows ${transitionExpandMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
              }}
            >
              <Box
                sx={{
                  minHeight: 0,
                  overflow: "hidden",
                  opacity: isVisuallyOpen ? 1 : 0,
                  transform: isVisuallyOpen ? "translateY(0)" : "translateY(-6px)",
                  transition: reducedMotion
                    ? "none"
                    : `opacity ${transitionFadeMs}ms ease-out, transform ${transitionExpandMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
                  pointerEvents: collapsed ? "none" : "auto",
                }}
              >
                {showFeatureLegend ? renderColorLegendBody() : renderDoiLegendBody()}
              </Box>
            </Box>
          </LegendCard>
        </Box>

        {showFeatureLegend && isVisuallyOpen && (
          <LegendCard
            title={doiOpacityTitle}
            subtitle={doiOpacitySubtitle}
            canvasBgColor={canvasBgColor}
          >
            <Box sx={{ position: "relative", height: 20 }}>
              <Box data-testid="legend-opacity-gradient" data-gradient={doiGradientCss} sx={{ position: "absolute", top: 4, left: 0, right: 0, height: 12, borderRadius: 1 }} style={{ backgroundImage: doiGradientCss }} />
              {renderThresholdMarkers}
            </Box>
            <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.45 }}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                0
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                1
              </Typography>
            </Stack>
          </LegendCard>
        )}
      </Stack>
    </Box>
  );
};

export default ColorLegendDock;
