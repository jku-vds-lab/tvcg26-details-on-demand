import { Stack, ToggleButton, Tooltip } from "@mui/material";
import React, { useEffect, useState } from "react";
import type { FalloffShape } from "../../doiPropagation/falloff";
import {
  getFalloffShape,
  setFalloffShape,
  subscribeFalloffShape,
} from "../../doiPropagation/serverPropagation";

interface FalloffOption {
  value: FalloffShape;
  label: string;
  tooltip: string;
}

/**
 * Spatial falloff shapes offered by the field-engine DoI radio (issue #315 A3
 * field-first v2, plan §8). CS 2026-07-24 trimmed the UI to the three shapes
 * he uses — Logarithmic (the default), Plateau, Linear; exp/gauss/hop stay
 * reachable programmatically but are no longer surfaced. Tooltips carry every
 * word of explanation — the Workflow tab keeps no inline captions.
 */
const FALLOFF_OPTIONS: FalloffOption[] = [
  {
    value: "log",
    label: "Logarithmic",
    tooltip: "Holds high near the selection, then falls off to a bounded radius.",
  },
  {
    value: "plateau",
    label: "Plateau",
    tooltip: "Full interest inside a radius, then a smooth cut-off.",
  },
  {
    value: "linear",
    label: "Linear",
    tooltip: "Influence ends at a hard radius set by the proximity slider.",
  },
];

interface FalloffShapeControlProps {
  /**
   * Re-run the propagation commit after a shape change — the same path a
   * propagation-slider release takes. InterestTabSliders binds this to the
   * commit handler with the current slider settings.
   */
  onCommit: () => void;
}

const toggleSx = {
  // grow to split the row evenly across the three buttons (basis 0), while the
  // wrap-capable Stack still lets them fall to a second line on a very narrow
  // panel.
  flex: "1 1 0",
  px: 1,
  py: 0.375,
  border: "1px solid",
  borderColor: "divider",
  borderRadius: 1.5,
  textTransform: "none",
  fontSize: "0.7rem",
  lineHeight: 1.15,
} as const;

/**
 * Falloff radio (segmented button row). Lives inside the Proximity slider's
 * inline unfold in InterestTabSliders — falloff governs the proximity term, so
 * that is its natural home. Rendered on EVERY dataset (issue #315 field
 * parity): provider-less builds compute the distance field themselves
 * (runLocalFieldPropagation), so the field shapes are universal. The shape
 * lives in the serverPropagation module store — this component mirrors it via
 * subscription and writes back on click, then fires a re-propagation commit.
 */
export const FalloffShapeControl: React.FC<FalloffShapeControlProps> = ({
  onCommit,
}) => {
  const [shape, setShape] = useState<FalloffShape>(getFalloffShape());

  // Mirror external mutations (shape-3 commits, dataset switches) into the UI.
  useEffect(
    () => subscribeFalloffShape(() => setShape(getFalloffShape())),
    []
  );

  const handleSelect = (next: FalloffShape) => {
    if (next === shape) return;
    setFalloffShape(next);
    onCommit();
  };

  return (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap">
      {FALLOFF_OPTIONS.map((option) => (
        <Tooltip key={option.value} title={option.tooltip} placement="top">
          <ToggleButton
            value={option.value}
            size="small"
            selected={shape === option.value}
            color="primary"
            aria-label={`Falloff: ${option.label}`}
            onChange={() => handleSelect(option.value)}
            sx={toggleSx}
          >
            {option.label}
          </ToggleButton>
        </Tooltip>
      ))}
    </Stack>
  );
};

export default FalloffShapeControl;
