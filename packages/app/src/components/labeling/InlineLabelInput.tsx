import type * as d3 from "d3";
import React, { useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { useDispatch, useSelector } from "react-redux";
import { useTheme } from "@mui/material/styles";
import { useLabeling } from "../../hooks/useLabeling";
import { useLayout } from "../../layout/layoutStore";
import { endInlineLabeling, updateInlineDraft } from "../../slices/labelingSlice";
import type { RootState } from "../../store";

interface Props {
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  zoomTransform: d3.ZoomTransform;
  canvasContainer: HTMLDivElement;
}

/**
 * Floating label input rendered via portal at the document body level so it is
 * unaffected by the annotation-layer CSS zoom transform. Coordinates are
 * converted from data-space to screen-space using the live zoom transform.
 */
export const InlineLabelInput: React.FC<Props> = ({ scales, zoomTransform, canvasContainer }) => {
  const dispatch = useDispatch();
  const labeling = useLabeling();
  const theme = useTheme();
  const accentColor = theme.palette.primary.main;
  const inputRef = useRef<HTMLInputElement>(null);
  const { positions } = useLayout();
  const clusterUid = useSelector((s: RootState) => s.labeling.activeInlineClusterUid);
  const elementId = useSelector((s: RootState) => s.labeling.activeInlineElementId);
  const draft = useSelector((s: RootState) => s.labeling.activeInlineDraft);

  useEffect(() => {
    if (clusterUid) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [clusterUid]);

  if (!clusterUid || !elementId) return null;

  const pos = positions.get(elementId);
  if (!pos) return null;

  // Convert data-space → layout-space → screen-space via zoom transform.
  const lx = scales.xScale(pos.x);
  const ly = scales.yScale(pos.y);
  const sx = zoomTransform.applyX(lx);
  const sy = zoomTransform.applyY(ly);

  // Add canvas container's offset from the viewport edge.
  const rect = canvasContainer.getBoundingClientRect();
  const fixedX = rect.left + sx;
  const fixedY = rect.top + sy;

  const commit = () => {
    if (draft.trim()) {
      labeling.assignLabelToClusterUid(clusterUid, draft);
    }
    dispatch(endInlineLabeling());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { dispatch(endInlineLabeling()); }
  };

  const input = (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => dispatch(updateInlineDraft(e.target.value))}
      onKeyDown={handleKeyDown}
      onBlur={commit}
      style={{
        position: "fixed",
        left: fixedX,
        top: fixedY,
        transform: "translate(-50%, calc(-100% - 44px))",
        zIndex: 9999,
        minWidth: 120,
        padding: "4px 8px",
        border: `2px solid ${accentColor}`,
        borderRadius: 4,
        fontSize: 14,
        fontFamily: "sans-serif",
        background: "rgba(255,255,255,0.96)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.28)",
        outline: "none",
      }}
      placeholder="Enter label…"
    />
  );

  return ReactDOM.createPortal(input, document.body);
};
