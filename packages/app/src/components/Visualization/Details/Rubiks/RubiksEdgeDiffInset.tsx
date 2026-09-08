// src/components/Visualization/Details/Rubiks/RubiksEdgeDiffInset.tsx
// Set-difference view: per-sticker color diff encoded as sized rect on background,
// mirroring the RubiksCubeInset variance-encoding pattern.
import React, { useEffect, useMemo, useRef } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendLoadingOverlay from "../BackendLoadingOverlay";
import { useBackendRubiksDiff } from "./rubiksBackend";
import { colorDiff54, colorNames, cubieToColour } from "./rubiksUtils";
import {
  buildRubiksScene,
  drawRubiksScene,
  RUBIKS_CANVAS_PAD,
  RUBIKS_SUPERSAMPLE,
} from "./rubiksCanvasDraw";

interface RubiksEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples:   DataPoint[];
  scaleFactor:  number;
  samplesSig:   string; // `${startSig}::${endSig}` — memo key
}

const EPS = 1e-4;

// Rendered to a supersampled canvas, not SVG — see rubiksCanvasDraw.ts (#232).
const RubiksEdgeDiffInset: React.FC<RubiksEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  samplesSig,
}) => {
  // Server-side aggregation (issue #315): with a rubiks backend active the
  // color-gain cells arrive as JSON and the local aggregation never runs.
  const backend = useBackendRubiksDiff(startSamples, endSamples);
  const backendActive = backend.kind !== "local";
  const backendCells = backend.kind === "ready" ? backend.payload : null;
  const backendLoading = backend.kind === "loading";

  const diffs = useMemo(() => {
    if (backendActive) return backendCells ?? [];
    return colorDiff54(startSamples, endSamples);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samplesSig, startSamples.length, endSamples.length, backendActive, backendCells]);

  const scene = useMemo(
    () =>
      buildRubiksScene((idx) => {
        const { color, delta } = diffs[idx] ?? { color: 0, delta: 0 };
        if (delta <= EPS) return null;
        return { fill: cubieToColour(colorNames[color], 1), ratio: delta };
      }),
    [diffs]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom
    if (backendLoading) {
      // Transparent canvas until the backend cells arrive.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawRubiksScene(ctx, scene, scaleFactor * RUBIKS_SUPERSAMPLE, RUBIKS_CANVAS_PAD);
  }, [scene, scaleFactor, backendLoading]);

  const cssWidth = (scene.width + 2 * RUBIKS_CANVAS_PAD) * scaleFactor;
  const cssHeight = (scene.height + 2 * RUBIKS_CANVAS_PAD) * scaleFactor;

  return (
    <div
      style={{
        position: "relative",
        width: cssWidth,
        height: cssHeight,
        // Negative margin cancels the anti-clipping pad so the layout box stays
        // overallWidth × overallHeight, matching computeInsetBoundingBox.
        margin: -RUBIKS_CANVAS_PAD * scaleFactor,
        pointerEvents: "none",
      }}
    >
      <canvas
        ref={canvasRef}
        width={Math.round(cssWidth * RUBIKS_SUPERSAMPLE)}
        height={Math.round(cssHeight * RUBIKS_SUPERSAMPLE)}
        style={{
          width: cssWidth,
          height: cssHeight,
          display: "block",
          pointerEvents: "none",
        }}
      />
      {/* The transparent canvas while the backend resolves reads as "missing
          inset" — make the pending state explicit. */}
      {backendLoading && !(backend.kind === "loading" && backend.grace) && <BackendLoadingOverlay />}
    </div>
  );
};

export default React.memo(
  RubiksEdgeDiffInset,
  (a, b) => a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
