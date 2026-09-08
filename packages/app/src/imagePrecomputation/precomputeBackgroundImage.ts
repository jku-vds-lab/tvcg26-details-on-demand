import * as d3 from "d3";
import { drawAll } from "../basicVisualization/drawNodesAndEdges";
import type { DataPoint, SplineSegment } from "../dataPreprocessing/dataPreprocessing";
import { NUM_LOD_LEVELS } from "../utils/constants";

export interface PyramidTile {
  x: number; // tile's logical x-offset within the overall view
  y: number; // tile's logical y-offset
  width: number; // logical width of the tile (portion of the view)
  height: number; // logical height of the tile (portion of the view)
  dataURL: string;
}

export interface PyramidLevel {
  level: number;
  tiles: PyramidTile[];
}

export type ImagePyramid = PyramidLevel[];

export interface BackgroundSettings {
  tileResolution: number;
  opacityThreshold: number;
  nodeRadius: number;
  edgeWidth: number;
  lodScaleBase: number;
}

/**
 * Asynchronously computes the image pyramid for background tiles.
 * The computation yields between tile renderings to keep the UI responsive,
 * and reports progress via the optional onProgress callback.
 *
 * @param allData - Array of DataPoint objects.
 * @param allSegments - Array of SplineSegment objects.
 * @param xScale - D3 linear scale for the x-axis.
 * @param yScale - D3 linear scale for the y-axis.
 * @param width - Logical width of the view.
 * @param height - Logical height of the view.
 * @param backgroundSettings - Visual settings from the store relevant to background rendering.
 * @param onProgress - Optional callback to report progress (a number between 0 and 1).
 * @returns A Promise that resolves to an ImagePyramid.
 */
export async function precomputeBackgroundImagePyramid(
  allData: DataPoint[],
  allSegments: SplineSegment[],
  xScale: d3.ScaleLinear<number, number>,
  yScale: d3.ScaleLinear<number, number>,
  width: number,
  height: number,
  backgroundSettings: BackgroundSettings,
  onProgress?: (progress: number) => void
): Promise<ImagePyramid> {
  const pyramid: ImagePyramid = [];
  let totalTiles = 0;
  for (let level = 0; level < NUM_LOD_LEVELS; level++) {
    totalTiles += Math.pow(2, level) * Math.pow(2, level);
  }
  let processedTiles = 0;

  for (let level = 0; level < NUM_LOD_LEVELS; level++) {
    const numTilesPerAxis = Math.pow(2, level);
    const tileWidth = width / numTilesPerAxis;
    const tileHeight = height / numTilesPerAxis;
    const levelTiles: PyramidTile[] = [];
    for (let i = 0; i < numTilesPerAxis; i++) {
      for (let j = 0; j < numTilesPerAxis; j++) {
        const tileX = i * tileWidth;
        const tileY = j * tileHeight;

        const offscreenCanvas = document.createElement("canvas");
        const dpi = window.devicePixelRatio || 1;
        offscreenCanvas.width = backgroundSettings.tileResolution * dpi;
        offscreenCanvas.height = backgroundSettings.tileResolution * dpi;

        const offscreenCtx = offscreenCanvas.getContext("2d");
        if (!offscreenCtx) {
          processedTiles++;
          if (onProgress) {
            onProgress(processedTiles / totalTiles);
          }
          continue;
        }
        offscreenCtx.scale(dpi, dpi);
        offscreenCtx.clearRect(0, 0, backgroundSettings.tileResolution, backgroundSettings.tileResolution);

        offscreenCtx.save();
        offscreenCtx.beginPath();
        offscreenCtx.rect(0, 0, backgroundSettings.tileResolution, backgroundSettings.tileResolution);
        offscreenCtx.clip();

        const scaleFactor = backgroundSettings.tileResolution / tileWidth;
        offscreenCtx.scale(scaleFactor, scaleFactor);
        offscreenCtx.translate(-tileX, -tileY);

        const effectiveScale = Math.pow(backgroundSettings.lodScaleBase, level);
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
            transform: d3.zoomIdentity,
            forceOpacity: backgroundSettings.opacityThreshold,
            forceRadius: backgroundSettings.nodeRadius / effectiveScale,
            forceLineWidth: backgroundSettings.edgeWidth / effectiveScale,
            forceColor: true,
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

        processedTiles++;
        if (onProgress) {
          onProgress(processedTiles / totalTiles);
        }
        // Yield to the event loop to keep the UI responsive
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    pyramid.push({
      level,
      tiles: levelTiles,
    });
  }
  return pyramid;
}
