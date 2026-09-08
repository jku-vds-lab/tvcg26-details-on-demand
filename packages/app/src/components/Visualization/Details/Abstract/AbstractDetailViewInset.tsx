import React from "react";
import AbstractDetailViewSvgComponent from "./abstract-detail-view.svg?react";

// Derived from the SVG viewBox: "0 0 27.628546 35.148006"
const SVG_NATURAL_WIDTH_MM = 27.628546;
const SVG_NATURAL_HEIGHT_MM = 35.148006;

/** Height-to-width aspect ratio of the abstract-detail-view SVG. */
export const SVG_ASPECT_RATIO = SVG_NATURAL_HEIGHT_MM / SVG_NATURAL_WIDTH_MM;

/** Base inset width in px at scaleFactor = 1. */
export const ABSTRACT_INSET_BASE_WIDTH_PX = 55;

interface AbstractDetailViewInsetProps {
  scaleFactor: number;
  count: number;
}

/**
 * Renders the abstract-detail-view.svg as a fixed inset image.
 * The drop shadow intensity is encoded by the cluster sample count.
 */
const AbstractDetailViewInset: React.FC<AbstractDetailViewInsetProps> = ({ scaleFactor, count }) => {
  const width = ABSTRACT_INSET_BASE_WIDTH_PX * scaleFactor;
  const height = width * SVG_ASPECT_RATIO;

  const blur = Math.min(10, Math.sqrt(Math.max(count, 1)) * 2);
  const offsetY = blur / 2;

  return (
    <div
      style={{
        width,
        height,
        overflow: "visible",
        pointerEvents: "none",
        filter: `drop-shadow(0px ${offsetY}px ${blur}px rgba(0,0,0,0.5))`,
      }}
    >
      <AbstractDetailViewSvgComponent
        width={width}
        height={height}
        style={{ display: "block" }}
      />
    </div>
  );
};

export default AbstractDetailViewInset;
