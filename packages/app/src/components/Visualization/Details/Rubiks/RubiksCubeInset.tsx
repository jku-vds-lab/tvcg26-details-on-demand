import React, { useEffect, useMemo, useRef } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendLoadingOverlay from "../BackendLoadingOverlay";
import { useBackendRubiksBoard } from "./rubiksBackend";
import { colorNames, useRubiksAggregation } from "./rubiksUtils";
import {
  buildRubiksScene,
  drawRubiksScene,
  RUBIKS_CANVAS_PAD,
  RUBIKS_SUPERSAMPLE,
} from "./rubiksCanvasDraw";

interface RubiksCubeInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
  samplesSig: string;
}

const cubieToColour = (str: string, opacity: number): string => {
  const map: Record<string, string> = {
    O: `rgba(255,137,33,${opacity})`,
    Y: `rgba(255,204,0,${opacity})`,
    G: `rgba(48,174,32,${opacity})`,
    B: `rgba(21,130,174,${opacity})`,
    R: `rgba(197,11,11,${opacity})`,
    W: `rgba(191,191,191,${opacity})`,
  };
  return map[str] || "black";
};

const EMPTY_SAMPLES: DataPoint[] = [];

// Rendered to a supersampled canvas, not SVG — see rubiksCanvasDraw.ts (#232).
const RubiksCubeInset: React.FC<RubiksCubeInsetProps> = ({
  clusterSamples,
  scaleFactor,
  samplesSig,
}) => {
  // Server-side aggregation (issue #315): with a rubiks backend active the
  // majority stickers arrive as JSON and the local aggregation never runs.
  const backend = useBackendRubiksBoard(clusterSamples);
  const backendActive = backend.kind !== "local";
  const local = useRubiksAggregation(
    backendActive ? "backend-inactive" : samplesSig,
    backendActive ? EMPTY_SAMPLES : clusterSamples
  );
  const { major, prop } = backend.kind === "ready" ? backend.payload : local;
  const backendLoading = backend.kind === "loading";

  const scene = useMemo(
    () =>
      buildRubiksScene((idx) => {
        const chosenIdx = major[idx];
        const chosen = chosenIdx < 6 ? colorNames[chosenIdx] : "";
        return { fill: cubieToColour(chosen, 1), ratio: prop[idx] };
      }),
    [major, prop]
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // jsdom
    if (backendLoading) {
      // Transparent canvas until the backend stickers arrive (an empty local
      // aggregation would draw an all-black cube).
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

export default React.memo(RubiksCubeInset, (a, b) =>
  a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
