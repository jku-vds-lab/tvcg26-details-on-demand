import * as d3 from "d3";
import { drawAll } from "../basicVisualization/drawNodesAndEdges";
import type { DataPoint, SplineSegment } from "../dataPreprocessing/dataPreprocessing";
import { LOD_SCALE_BASE, MIN_BACKGROUND_OPACITY, NUM_LOD_LEVELS } from "../utils/constants";

// Fixed high-resolution for each tile (in pixels)
const TILE_RES = 600; // Each tile will be rendered at TILE_RES x TILE_RES pixels regardless of LOD

export interface PyramidTile {
  x: number; // tile's logical x-offset within the overall view
  y: number; // tile's logical y-offset
  width: number; // logical width of the tile (portion of the view)
  height: number; // logical height of the tile
  dataURL: string;
}

export interface PyramidLevel {
  level: number;
  tiles: PyramidTile[];
}

export type ImagePyramid = PyramidLevel[];

export function precomputeImagePyramid(
  allData: DataPoint[],
  allSegments: SplineSegment[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  width: number,
  height: number
): ImagePyramid {
  const pyramid: ImagePyramid = [];
  for (let level = 0; level < NUM_LOD_LEVELS; level++) {
    const numTilesPerAxis = Math.pow(2, level);
    const tileWidth = width / numTilesPerAxis; // logical view width of each tile
    const tileHeight = height / numTilesPerAxis; // logical view height of each tile
    const levelTiles: PyramidTile[] = [];

    // For each tile in this LOD level, always render at TILE_RES resolution.
    for (let i = 0; i < numTilesPerAxis; i++) {
      for (let j = 0; j < numTilesPerAxis; j++) {
        const tileX = i * tileWidth;
        const tileY = j * tileHeight;

        // Create offscreen canvas for this tile with fixed high resolution.
        const offscreenCanvas = document.createElement("canvas");
        const dpi = window.devicePixelRatio || 1;
        offscreenCanvas.width = TILE_RES * dpi;
        offscreenCanvas.height = TILE_RES * dpi;

        const offscreenCtx = offscreenCanvas.getContext("2d");
        if (!offscreenCtx) {
          continue;
        }
        offscreenCtx.scale(dpi, dpi);
        offscreenCtx.clearRect(0, 0, TILE_RES, TILE_RES);

        // Set clipping region to the full canvas.
        offscreenCtx.save();
        offscreenCtx.beginPath();
        offscreenCtx.rect(0, 0, TILE_RES, TILE_RES);
        offscreenCtx.clip();

        // Compute scale factor so that the tile's logical size maps to TILE_RES pixels.
        const scaleFactor = TILE_RES / tileWidth;
        // Apply transformation: scale then translate to render only the tile’s segment.
        offscreenCtx.scale(scaleFactor, scaleFactor);
        offscreenCtx.translate(-tileX, -tileY);

        // Compute effective scale for this LOD level.
        const effectiveScale = Math.pow(LOD_SCALE_BASE, level);
        // Use forced sizes that scale down with effectiveScale, matching the foreground.

        drawAll(
          offscreenCtx,
          width,
          height,
          allData,
          allSegments,
          xScale,
          yScale,
          {
            mode: "background",
            transform: d3.zoomIdentity, // no additional transform applied
            forceOpacity: MIN_BACKGROUND_OPACITY,
            forceRadius: 5 / effectiveScale,
            forceLineWidth: 2 / effectiveScale,
            forceColor: true, // Render background in grayscale
          }
        );
        offscreenCtx.restore();

        const dataURL = offscreenCanvas.toDataURL("image/png");
        levelTiles.push({
          x: tileX,
          y: tileY,
          width: tileWidth,
          height: tileHeight,
          dataURL,
        });
      }
    }
    pyramid.push({
      level,
      tiles: levelTiles,
    });
  }
  return pyramid;
}
