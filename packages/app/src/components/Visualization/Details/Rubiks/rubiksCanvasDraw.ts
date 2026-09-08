// Shared canvas rasterization for the three Rubik's insets (issue #232).
//
// The insets used to be SVG, but they live inside a framer-motion div whose
// transform changes fractionally almost every frame (live --invk counter-scale
// during zoom, annealer micro-repositioning, hover/opacity animations). Firefox
// and weaker GPU stacks re-rasterize the vectors at a different sub-pixel offset
// each frame, so the ~0.3-unit grid gaps between stickers shimmer ("z-fighting"
// look). Rendering the cube cross to a supersampled bitmap ONCE per data change
// makes per-frame work pure texture compositing, which is stable under
// fractional transforms — same model as the MNIST/CCTV canvas insets, which do
// not flicker. Because the --invk counter-scale keeps insets at a constant
// on-screen size, the bitmap is always displayed at ≈ 1/SUPERSAMPLE of its
// internal resolution: classic SSAA at a fixed target size, at least as crisp
// as live vector AA.
import {
  backgroundColor,
  cellIndex,
  distance,
  faces,
  fineTuningScale,
  size,
} from "./rubiksUtils";

export interface RubiksSceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RubiksSceneSticker extends RubiksSceneRect {
  fill: string;
}

export interface RubiksSceneLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Cube-cross geometry in user units (same coordinate system as the old SVG viewBox). */
export interface RubiksSceneSpec {
  width: number;
  height: number;
  faceRects: RubiksSceneRect[];
  stickers: RubiksSceneSticker[];
  outlines: RubiksSceneLine[];
}

/** Internal bitmap resolution = CSS size × SUPERSAMPLE. 4 covers
 *  devicePixelRatio ≤ 2 × insetHoverScale default 1.5 with margin. */
export const RUBIKS_SUPERSAMPLE = 4;

/** Padding (user units) around the cross so outline strokes + glow blur are not
 *  clipped — the old SVG relied on overflow: visible for this. */
export const RUBIKS_CANVAS_PAD = 4;

interface Offset {
  x: number;
  y: number;
}

/**
 * Builds the cube-cross scene. `cellSpec` maps a 54-cell index (from
 * `cellIndex(face, i, j)`) to the sticker fill and size ratio (0..1, relative
 * to the cell), or null to draw no sticker for that cell.
 */
export function buildRubiksScene(
  cellSpec: (idx: number) => { fill: string; ratio: number } | null
): RubiksSceneSpec {
  const effectiveSize = size * fineTuningScale;
  const effectiveDistance = distance * fineTuningScale;
  const d = effectiveSize + effectiveDistance;
  const faceExtent = 3 * effectiveSize + 2 * effectiveDistance;

  // Cross layout offsets
  const offsets: Record<string, Offset> = {
    back: { x: 3 * d, y: 0 },
    left: { x: 0, y: 3 * d },
    up: { x: 3 * d, y: 3 * d },
    right: { x: 6 * d, y: 3 * d },
    front: { x: 3 * d, y: 6 * d },
    down: { x: 3 * d, y: 9 * d },
  };

  const faceRects: RubiksSceneRect[] = [];
  const stickers: RubiksSceneSticker[] = [];
  const faceBounds: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> = {};

  for (const face of faces) {
    const off = offsets[face];
    faceBounds[face] = {
      minX: off.x,
      minY: off.y,
      maxX: off.x + faceExtent,
      maxY: off.y + faceExtent,
    };

    // One background rect per face, expanded by a full effectiveDistance per
    // side so adjacent faces OVERLAP: the cross interior must be fully opaque.
    // Smaller expansions leave ~0.15-unit transparent hairlines between faces
    // baked into the bitmap; the background bleeds through them and modulates
    // as the (midpoint-pinned, per-frame-moving) diff insets translate
    // fractionally — the residual grid-line flicker of #232. The enlarged
    // silhouette stays hidden under the 2.5-wide outline strokes.
    faceRects.push({
      x: off.x - effectiveDistance,
      y: off.y - effectiveDistance,
      w: faceExtent + 2 * effectiveDistance,
      h: faceExtent + 2 * effectiveDistance,
    });

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const spec = cellSpec(cellIndex(face, i, j));
        if (!spec) continue;
        const faceSz = effectiveSize * Math.min(1, Math.max(0, spec.ratio));
        const pad = (effectiveSize - faceSz) / 2;
        stickers.push({
          x: off.x + j * d + pad,
          y: off.y + i * d + pad,
          w: faceSz,
          h: faceSz,
          fill: spec.fill,
        });
      }
    }
  }

  const outlines: RubiksSceneLine[] = [
    // Cross outline (back → up/right → front → down and back around)
    { x1: faceBounds.back.minX, y1: faceBounds.back.minY, x2: faceBounds.back.maxX, y2: faceBounds.back.minY },
    { x1: faceBounds.back.maxX, y1: faceBounds.back.minY, x2: faceBounds.up.maxX, y2: faceBounds.up.minY },
    { x1: faceBounds.up.maxX, y1: faceBounds.up.maxY, x2: faceBounds.front.maxX, y2: faceBounds.front.maxY },
    { x1: faceBounds.front.maxX, y1: faceBounds.front.maxY, x2: faceBounds.down.maxX, y2: faceBounds.down.maxY },
    { x1: faceBounds.down.maxX, y1: faceBounds.down.maxY, x2: faceBounds.down.minX, y2: faceBounds.down.maxY },
    { x1: faceBounds.down.minX, y1: faceBounds.down.maxY, x2: faceBounds.front.minX, y2: faceBounds.front.maxY },
    { x1: faceBounds.front.minX, y1: faceBounds.front.maxY, x2: faceBounds.up.minX, y2: faceBounds.up.maxY },
    { x1: faceBounds.up.minX, y1: faceBounds.up.minY, x2: faceBounds.back.minX, y2: faceBounds.back.minY },
    // Right face outline
    { x1: faceBounds.right.minX, y1: faceBounds.right.minY, x2: faceBounds.right.maxX, y2: faceBounds.right.minY },
    { x1: faceBounds.right.maxX, y1: faceBounds.right.maxY, x2: faceBounds.right.minX, y2: faceBounds.right.maxY },
    { x1: faceBounds.right.maxX, y1: faceBounds.right.minY, x2: faceBounds.right.maxX, y2: faceBounds.right.maxY },
    // Left face outline
    { x1: faceBounds.left.minX, y1: faceBounds.left.minY, x2: faceBounds.left.maxX, y2: faceBounds.left.minY },
    { x1: faceBounds.left.minX, y1: faceBounds.left.maxY, x2: faceBounds.left.minX, y2: faceBounds.left.minY },
    { x1: faceBounds.left.maxX, y1: faceBounds.left.maxY, x2: faceBounds.left.minX, y2: faceBounds.left.maxY },
  ];

  return { width: 9 * d, height: 12 * d, faceRects, stickers, outlines };
}

/**
 * Paints a scene into a 2D context. `pixelScale` maps user units to device
 * pixels (scaleFactor × RUBIKS_SUPERSAMPLE); `pad` is RUBIKS_CANVAS_PAD in user
 * units. The white outline pass bakes the old SVG glow via shadowBlur —
 * shadow params are in device space, hence the × pixelScale.
 */
export function drawRubiksScene(
  ctx: CanvasRenderingContext2D,
  spec: RubiksSceneSpec,
  pixelScale: number,
  pad: number
): void {
  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(pixelScale, pixelScale);
  ctx.translate(pad, pad);

  ctx.fillStyle = backgroundColor;
  for (const r of spec.faceRects) ctx.fillRect(r.x, r.y, r.w, r.h);

  for (const s of spec.stickers) {
    ctx.fillStyle = s.fill;
    ctx.fillRect(s.x, s.y, s.w, s.h);
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // White pass with baked glow (was: SVG feGaussianBlur / CSS drop-shadow).
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2.5;
  ctx.shadowColor = "rgba(255,255,255,0.5)";
  ctx.shadowBlur = 2 * pixelScale;
  for (const l of spec.outlines) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }

  // Black pass on top, no shadow.
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "black";
  ctx.lineWidth = 1;
  for (const l of spec.outlines) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }

  ctx.restore();
}
