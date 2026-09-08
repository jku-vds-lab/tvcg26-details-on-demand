// PNG assets are inlined by Vite as base64 data URIs (< 4 KB each), so they
// work in all environments including anywidget/Jupyter without any network access.
import wrPng from './pieces/wr.png';
import wnPng from './pieces/wn.png';
import wbPng from './pieces/wb.png';
import wqPng from './pieces/wq.png';
import wkPng from './pieces/wk.png';
import wpPng from './pieces/wp.png';
import brPng from './pieces/br.png';
import bnPng from './pieces/bn.png';
import bbPng from './pieces/bb.png';
import bqPng from './pieces/bq.png';
import bkPng from './pieces/bk.png';
import bpPng from './pieces/bp.png';

export type ChessPieceCode =
  | "wr" | "wn" | "wb" | "wq" | "wk" | "wp"
  | "br" | "bn" | "bb" | "bq" | "bk" | "bp";

export const PIECE_SPRITES: Record<ChessPieceCode, string> = {
  wr: wrPng, wn: wnPng, wb: wbPng, wq: wqPng, wk: wkPng, wp: wpPng,
  br: brPng, bn: bnPng, bb: bbPng, bq: bqPng, bk: bkPng, bp: bpPng,
};

// Pre-loaded HTMLImageElement map for canvas drawImage.
// Populated at module load time; data URI src loads synchronously.
export const PIECE_IMAGES: Partial<Record<string, HTMLImageElement>> = {};
if (typeof window !== 'undefined') {
  for (const [code, src] of Object.entries(PIECE_SPRITES)) {
    const img = new Image();
    img.src = src;
    PIECE_IMAGES[code] = img;
  }
}

export function resolveSprite(code: string): string | undefined {
  const k = code.trim().toLowerCase() as ChessPieceCode;
  return (PIECE_SPRITES as Record<string, string>)[k];
}

export function resolveImage(code: string): HTMLImageElement | undefined {
  return PIECE_IMAGES[code.trim().toLowerCase()];
}
