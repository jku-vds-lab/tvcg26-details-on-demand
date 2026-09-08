/**
 * PSE-parity per-square difference encoding (mirrors ChessChanges.tsx from
 * Projection Space Explorer): blue change-heat opacity = total variation
 * distance between the start/end piece distributions; the end selection's
 * prominent piece is shown iff the prominent piece changed, at its share.
 */

export type Dist = Map<string, number>;

/** Distribution key for an empty square. */
export const EMPTY_SQUARE = "__EMPTY__";

/** PSE's CHESS_TILE_CHANGES — the change-heat color. */
export const CHESS_TILE_CHANGES = "#007dad";

/**
 * Fine-tune factor for the edge-diff board (slightly larger than the node
 * board's 0.5). Shared between ChessEdgeDiffInset (rendered size) and
 * ChessDatasetRenderer (bbox) — the two MUST agree or leader-arrow tips
 * detach from the board border.
 */
export const EDGE_BOARD_FINE_TUNE = 0.6;

/**
 * A chess overlay label is worth showing only if it carries text. Bare
 * numeric codes (chess40k's `algo` is 0/1/2, possibly "0 +" after majority
 * vote) label nothing a reader can use — suppress them.
 */
export function isMeaningfulChessLabel(label: unknown): boolean {
  // majorityVote passes raw column values through — chess40k's algo is a number.
  const trimmed = String(label ?? "").trim();
  if (!trimmed) return false;
  return !/^\d+( \+)?$/.test(trimmed);
}

/** Most frequent non-empty piece code and its relative share (PSE getProminent). */
function prominent(dist: Dist): { code: string; share: number } {
  let code = "";
  let best = 0;
  for (const [k, p] of dist) {
    if (k === EMPTY_SQUARE) continue;
    if (p > best) {
      best = p;
      code = k;
    }
  }
  return { code, share: best };
}

export interface SquareDiff {
  /** Blue-overlay opacity: total variation distance between the distributions. */
  changeAlpha: number;
  /** Piece to draw (end selection's prominent piece) — empty string = none. */
  code: string;
  /** Opacity of the drawn piece: the prominent piece's share in the end selection. */
  pieceOpacity: number;
}

/**
 * PSE ChessChanges per-square encoding: changeAlpha = Σ|pA − pB| / 2 over all
 * piece codes (incl. empty), and the end selection's prominent piece is shown
 * iff it differs from the start selection's prominent piece.
 */
export function computeSquareDiff(a: Dist, b: Dist): SquareDiff {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  let diffSum = 0;
  for (const k of keys) {
    diffSum += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
  }
  const changeAlpha = diffSum / 2;

  const promA = prominent(a);
  const promB = prominent(b);
  const changed = promA.code !== promB.code && promB.code !== "";
  return {
    changeAlpha,
    code: changed ? promB.code : "",
    pieceOpacity: changed ? promB.share : 0,
  };
}
