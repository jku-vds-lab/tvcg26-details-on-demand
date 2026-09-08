// src/components/Visualization/Details/ChessEdgeDiffInset.tsx
import React, { useMemo } from "react";
import { groupVoteRows } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendLoadingOverlay from "../BackendLoadingOverlay";
import { useBackendChessDiff } from "./chessBackend";
import { CHESS_TILE_CHANGES, computeSquareDiff, EDGE_BOARD_FINE_TUNE, EMPTY_SQUARE, type Dist, type SquareDiff } from "./chessDiffEncoding";
import { resolveSprite } from "./chessPieceSprites";

/**
 * PSE-parity difference encoding (see ChessChanges.tsx in Projection Space
 * Explorer): every square gets a blue (#007dad) overlay whose opacity is the
 * total variation distance between the square's piece distributions in the
 * start and end selections (0 = identical, 1 = disjoint). On squares whose
 * prominent (most frequent) piece changed, the end selection's prominent
 * piece is drawn with opacity equal to its relative share.
 */

interface ChessEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples: DataPoint[];
  scaleFactor: number;
  samplesSig: string; // startSig::endSig (memo key)
}

const TILE = 20;
const FINE_TUNE_SCALE = EDGE_BOARD_FINE_TUNE; // must match the bbox in ChessDatasetRenderer.renderSingleEdgeInset

// a1..h8 (idx = rankIndex*8 + file; drawn with rank 8 on top)
const squareKeys: string[] = [];
for (let rank = 1; rank <= 8; rank++) {
  for (let file = 0; file < 8; file++) {
    squareKeys.push(String.fromCharCode("a".charCodeAt(0) + file) + rank.toString());
  }
}

const TILE_LIGHT = '#ffffff';
const TILE_DARK = '#edeeef';

const EMPTY = EMPTY_SQUARE;

function distributions(samples: DataPoint[]): Dist[] {
  // The sides are the ORIGINAL group arrays (edgeSides.ts) — on index-backed
  // groups (issue #315 R1c) their slots stay holes forever, so the local scan
  // walks resolved vote rows: every member once resident, ≤4096 strided while
  // not (display-only, the hover-diff cap precedent).
  const rows = groupVoteRows(samples, 4096) ?? samples;
  const N = rows.length || 1;
  const arr: Dist[] = Array.from({ length: 64 }, () => new Map<string, number>());
  for (const s of rows) {
    for (let i = 0; i < 64; i++) {
      const key = squareKeys[i];
      const raw = (s as unknown as Record<string, unknown>)[key];
      const v = raw ? String(raw).trim().toLowerCase() : EMPTY;
      const m = arr[i];
      m.set(v, (m.get(v) || 0) + 1);
    }
  }
  // normalize to probabilities
  for (const m of arr) {
    for (const [k, v] of m) m.set(k, v / N);
  }
  return arr;
}

const EPS = 1e-4;

/** Bare board while the backend diff resolves. */
const EMPTY_DIFFS: SquareDiff[] = Array.from({ length: 64 }, () => ({
  changeAlpha: 0,
  code: "",
  pieceOpacity: 0,
}));

const ChessEdgeDiffInset: React.FC<ChessEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  samplesSig,
}) => {
  // Server-side aggregation (issue #315): with a chess backend active the
  // PSE SquareDiffs arrive as JSON and the local scans below never run.
  const backend = useBackendChessDiff(startSamples, endSamples);
  const backendActive = backend.kind !== "local";
  const backendDiffs = backend.kind === "ready" ? backend.payload : null;

  const startDist = useMemo(
    () => (backendActive ? [] : distributions(startSamples)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the content signature: sample arrays are swapped in place by reconcileClusterItems, so identity is not a change signal
    [samplesSig, startSamples.length, backendActive]
  );
  const endDist = useMemo(
    () => (backendActive ? [] : distributions(endSamples)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the content signature: sample arrays are swapped in place by reconcileClusterItems, so identity is not a change signal
    [samplesSig, endSamples.length, backendActive]
  );

  const squareDiffs = useMemo(() => {
    if (backendActive) return backendDiffs ?? EMPTY_DIFFS;
    return Array.from({ length: 64 }, (_, i) => computeSquareDiff(startDist[i], endDist[i]));
  }, [startDist, endDist, backendActive, backendDiffs]);

  const width = 8 * TILE;
  const height = 8 * TILE;
  const scale = scaleFactor * FINE_TUNE_SCALE;

  return (
    <div style={{ position: "relative", width: width * scale, height: height * scale }}>
    <svg
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible", pointerEvents: "none", display: "block" }}
    >
      {/* Tiles */}
      {Array.from({ length: 64 }, (_, idx) => {
        const col = idx % 8;
        const row = 7 - Math.floor(idx / 8); // standard orientation: rank 8 on top
        const isLight = (col + row) % 2 === 0;
        const fill = isLight ? TILE_LIGHT : TILE_DARK;
        return (
          <rect
            key={`tile-${idx}`}
            x={col * TILE}
            y={row * TILE}
            width={TILE}
            height={TILE}
            fill={fill}
            stroke="rgba(0,0,0,0.2)"
            strokeWidth={0.75}
          />
        );
      })}

      {/* PSE change heat: blue overlay, opacity = total variation distance */}
      {Array.from({ length: 64 }, (_, idx) => {
        const d = squareDiffs[idx];
        if (d.changeAlpha <= EPS) return null;
        const col = idx % 8;
        const row = 7 - Math.floor(idx / 8); // standard orientation: rank 8 on top
        return (
          <rect
            key={`change-${idx}`}
            x={col * TILE}
            y={row * TILE}
            width={TILE}
            height={TILE}
            fill={CHESS_TILE_CHANGES}
            style={{ opacity: Math.min(1, d.changeAlpha) }}
          />
        );
      })}

      {/* End selection's prominent piece where prominence changed, opacity = its share */}
      {Array.from({ length: 64 }, (_, idx) => {
        const d = squareDiffs[idx];
        if (!d.code || d.pieceOpacity <= EPS) return null;

        const href = resolveSprite(d.code);
        if (!href) return null;

        const col = idx % 8;
        const row = 7 - Math.floor(idx / 8); // standard orientation: rank 8 on top

        return (
          <image
            key={`piece-${idx}`}
            href={href}
            x={col * TILE}
            y={row * TILE}
            width={TILE}
            height={TILE}
            style={{ opacity: Math.min(1, d.pieceOpacity) }}
          />
        );
      })}

      {/* Frame */}
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="white" strokeWidth={2} />
      <rect x={0} y={0} width={width} height={height} fill="none" stroke="black" strokeWidth={1} />
    </svg>
    {/* The bare board while the backend resolves reads as "no change" —
        make the pending state explicit. */}
    {backend.kind === "loading" && !backend.grace && <BackendLoadingOverlay />}
    </div>
  );
};

export default React.memo(
  ChessEdgeDiffInset,
  (a, b) => a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
