// src/components/Visualization/Details/Rubiks/RubiksEdgeSingleInset.tsx
// Single-transition view: gray touch-mask showing which stickers a move touches,
// sized-on-background encoding consistent with RubiksCubeInset and RubiksEdgeDiffInset.
import React, { useEffect, useMemo, useRef } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getTouchedMask, parseActionTokens } from "./rubiksMoveMasks";
import {
  buildRubiksScene,
  drawRubiksScene,
  RUBIKS_CANVAS_PAD,
  RUBIKS_SUPERSAMPLE,
} from "./rubiksCanvasDraw";

interface RubiksEdgeSingleInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor:    number;
  samplesSig:     string;
}

const TOUCHED_FILL = "#555555";
const EPS = 1e-4;

/** Build a 54-element touch-intensity array from the action strings in clusterSamples. */
function computeTouchIntensity(samples: DataPoint[]): Float32Array {
  const counts = new Float32Array(54);
  let totalMoves = 0;

  for (const s of samples) {
    const action = String(s.action ?? "");
    const tokens = parseActionTokens(action);
    for (const tok of tokens) {
      const mask = getTouchedMask(tok);
      for (let i = 0; i < 54; i++) counts[i] += mask[i];
      totalMoves++;
    }
  }

  if (totalMoves === 0) return counts;
  const max = Math.max(...counts, 1e-9);
  for (let i = 0; i < 54; i++) counts[i] /= max;
  return counts;
}

// Rendered to a supersampled canvas, not SVG — see rubiksCanvasDraw.ts (#232).
const RubiksEdgeSingleInset: React.FC<RubiksEdgeSingleInsetProps> = ({
  clusterSamples,
  scaleFactor,
  samplesSig,
}) => {
  const intensity = useMemo(
    () => computeTouchIntensity(clusterSamples),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [samplesSig, clusterSamples.length]
  );

  const scene = useMemo(
    () =>
      buildRubiksScene((idx) => {
        const touch = intensity[idx];
        if (touch <= EPS) return null;
        return { fill: TOUCHED_FILL, ratio: touch };
      }),
    [intensity]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom
    drawRubiksScene(ctx, scene, scaleFactor * RUBIKS_SUPERSAMPLE, RUBIKS_CANVAS_PAD);
  }, [scene, scaleFactor]);

  const cssWidth = (scene.width + 2 * RUBIKS_CANVAS_PAD) * scaleFactor;
  const cssHeight = (scene.height + 2 * RUBIKS_CANVAS_PAD) * scaleFactor;

  return (
    <canvas
      ref={canvasRef}
      width={Math.round(cssWidth * RUBIKS_SUPERSAMPLE)}
      height={Math.round(cssHeight * RUBIKS_SUPERSAMPLE)}
      style={{
        width: cssWidth,
        height: cssHeight,
        // Negative margin cancels the anti-clipping pad so the layout box stays
        // overallWidth × overallHeight, matching computeInsetBoundingBox.
        margin: -RUBIKS_CANVAS_PAD * scaleFactor,
        display: "block",
        pointerEvents: "none",
      }}
    />
  );
};

export default React.memo(
  RubiksEdgeSingleInset,
  (a, b) => a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
