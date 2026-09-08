import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { groupVoteRows } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendLoadingOverlay from "../BackendLoadingOverlay";
import { useBackendChessBoard, type ChessSquareTop } from "./chessBackend";
import { resolveImage } from "./chessPieceSprites";

const TILE_LIGHT = '#ffffff';
const TILE_DARK = '#edeeef';
const TILE_PX = 20;
const BOARD_PX = 8 * TILE_PX; // 160 logical px
const FINE_TUNE_SCALE = 0.5;
const MIN_PIECE_OPACITY = 0.15;

const squareToIndex: Record<string, number> = {};
(function () {
  let idx = 0;
  for (let rank = 1; rank <= 8; rank++) {
    for (let file = 0; file < 8; file++) {
      squareToIndex[String.fromCharCode('a'.charCodeAt(0) + file) + rank] = idx++;
    }
  }
})();

interface ChessBoardInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
}

/** Bare board while the backend board state resolves. */
const EMPTY_TOPS: ChessSquareTop[] = Array.from({ length: 64 }, () => ({
  code: "",
  count: 0,
  ratio: 0,
}));

const ChessBoardInset: React.FC<ChessBoardInsetProps> = ({ clusterSamples, scaleFactor }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cssSize = BOARD_PX * FINE_TUNE_SCALE * scaleFactor;

  // Server-side aggregation (issue #315): with a chess backend active the
  // per-square tops arrive as JSON and the local scan below never runs.
  const backend = useBackendChessBoard(clusterSamples);
  const backendActive = backend.kind !== "local";
  const backendTops = backend.kind === "ready" ? backend.payload : null;

  const tops = useMemo(() => {
    if (backendActive) return backendTops ?? EMPTY_TOPS;
    // Index-backed group arrays keep holes forever (issue #315 R1c) — resolve
    // the local scan's rows through the member spec: every member once
    // resident, ≤4096 strided while not (a hole slot is skipped by for-in and
    // would silently vanish from the counts).
    const rows = groupVoteRows(clusterSamples, 4096) ?? clusterSamples;
    const N = rows.length || 1;
    const counts: Array<Map<string, number>> = Array.from({ length: 64 }, () => new Map());
    for (const sample of rows) {
      for (const key in sample) {
        if (!Object.prototype.hasOwnProperty.call(sample, key)) continue;
        const idx = squareToIndex[key];
        if (idx === undefined) continue;
        const codeRaw = (sample as unknown as Record<string, unknown>)[key];
        if (!codeRaw) continue;
        const code = String(codeRaw).trim().toLowerCase();
        const m = counts[idx];
        m.set(code, (m.get(code) || 0) + 1);
      }
    }
    return counts.map(m => {
      let code = '', cnt = 0;
      m.forEach((c, k) => { if (c > cnt) { cnt = c; code = k; } });
      return { code, count: cnt, ratio: cnt / N };
    });
  }, [clusterSamples, backendActive, backendTops]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Canvas resolution = CSS display size × DPR, rounded to multiple of 8.
    // Must scale with cssSize so the board is never upscaled (blurry).
    const dpr = window.devicePixelRatio || 1;
    const canvasSize = Math.ceil(cssSize * dpr / 8) * 8;
    if (canvas.width !== canvasSize || canvas.height !== canvasSize) {
      canvas.width = canvasSize;
      canvas.height = canvasSize;
    }
    const tile = canvasSize / 8;

    for (let idx = 0; idx < 64; idx++) {
      const col = idx % 8;
      const row = 7 - Math.floor(idx / 8); // standard orientation: rank 8 on top
      ctx.fillStyle = (col + row) % 2 === 0 ? TILE_LIGHT : TILE_DARK;
      ctx.fillRect(col * tile, row * tile, tile, tile);
    }

    for (let idx = 0; idx < 64; idx++) {
      const top = tops[idx];
      if (!top?.code || top.count === 0) continue;
      const img = resolveImage(top.code);
      if (!img) continue;
      if (!img.complete || img.naturalWidth === 0) {
        img.onload = draw;
        continue;
      }
      const col = idx % 8;
      const row = 7 - Math.floor(idx / 8); // standard orientation: rank 8 on top
      ctx.save();
      ctx.globalAlpha = Math.max(MIN_PIECE_OPACITY, Math.min(1, top.ratio));
      ctx.drawImage(img, col * tile, row * tile, tile, tile);
      ctx.restore();
    }
  }, [tops, cssSize]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <div style={{ position: 'relative', width: cssSize, height: cssSize }}>
      <canvas
        ref={canvasRef}
        // box-shadow (not border) so the thin dark outline — matching the diff
        // inset's frame — adds no layout size and bboxes stay exact.
        style={{ width: cssSize, height: cssSize, display: 'block', boxShadow: '0 0 0 1px black' }}
      />
      {/* The bare board while the backend resolves reads as "empty position" —
          make the pending state explicit. */}
      {backend.kind === 'loading' && !backend.grace && <BackendLoadingOverlay />}
    </div>
  );
};

ChessBoardInset.displayName = "ChessBoardInset";
export default React.memo(ChessBoardInset);
