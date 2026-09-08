/** Grayscale + diverging diff for gym edge insets.
 *
 * The render service returns one mean-rendered PNG per cluster side; the edge
 * inset converts both to luminance and colors the per-pixel difference with
 * the shared blue-orange diverging palette (imageDiffShared, same look as the
 * CCTV/MNIST edge diffs).
 */

import { renderImageDiffToRgba } from "../imageDiffShared";

/** Rec. 601 luminance of an RGBA buffer, normalized to [0, 1]. */
export function luminanceFromRgba(rgba: Uint8ClampedArray): Float32Array {
  const n = rgba.length >> 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    out[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) / 255;
  }
  return out;
}

/** Differences below this are treated as noise and not amplified: MuJoCo
 * re-renders wobble by a few intensity steps (AA), and two visually identical
 * clusters must stay near-white instead of auto-contrasting noise to full
 * saturation. 0.04 ≈ 10/255. */
export const DIFF_NOISE_FLOOR = 0.04;

/** Both images count as white-background (classic-control style) when their
 * mean border luminance is at least this bright. */
const WHITE_BG_MIN = 0.92;

/** Mean luminance of the 1px border ring — classic-control renders keep their
 * content centered on a white canvas, so a bright border identifies them. */
function borderLuminance(lum: Float32Array, width: number, height: number): number {
  let sum = 0;
  let count = 0;
  for (let x = 0; x < width; x++) {
    sum += lum[x] + lum[(height - 1) * width + x];
    count += 2;
  }
  for (let y = 1; y < height - 1; y++) {
    sum += lum[y * width] + lum[y * width + width - 1];
    count += 2;
  }
  return count ? sum / count : 0;
}

/** Normalized "ink" (content presence) of a white-background mean image:
 * ink = background − luminance, scaled so the image's strongest content is 1,
 * then sqrt-boosted. A mean image mixes the content color with the white
 * background proportionally to how many members cover the pixel, so raw ink
 * IS the occupancy fraction — the sqrt turns faint "covered by some members"
 * regions into clearly visible presence instead of near-white. */
function inkField(lum: Float32Array, background: number): Float32Array {
  const n = lum.length;
  const ink = new Float32Array(n);
  let maxInk = 0;
  for (let i = 0; i < n; i++) {
    const v = background - lum[i];
    ink[i] = v > 0 ? v : 0;
    if (ink[i] > maxInk) maxInk = ink[i];
  }
  if (maxInk > DIFF_NOISE_FLOOR) {
    for (let i = 0; i < n; i++) ink[i] = Math.sqrt(ink[i] / maxInk);
  }
  return ink;
}

/** Diverging RGBA of the (end − start) difference; inputs are same-size RGBA
 * buffers of the two clusters' mean-rendered images.
 *
 * White-background images (classic control — detected via the border ring)
 * are diffed on background-subtracted, per-side-normalized, sqrt-boosted ink
 * (see inkField): where one cluster's content always covers a pixel and the
 * other's never does, the diff hits the full palette end. Everything else
 * (MuJoCo's agent-tracking camera has no stable background to subtract)
 * diffs raw luminance. Both paths are finally contrast-normalized per inset
 * (largest |difference| = full blue/orange) with a noise floor so that
 * near-identical clusters stay near-white. Trade-off: color magnitude is
 * comparable within one inset, not across insets.
 *
 * @param width Pixels per row (border detection); defaults to a square image.
 */
export function diffRgbaFromImages(
  startRgba: Uint8ClampedArray,
  endRgba: Uint8ClampedArray,
  width?: number
): Uint8ClampedArray {
  let start = luminanceFromRgba(startRgba);
  let end = luminanceFromRgba(endRgba);
  const n = end.length;

  const w = width ?? Math.max(1, Math.round(Math.sqrt(n)));
  const h = Math.max(1, Math.round(n / w));
  const bgStart = borderLuminance(start, w, h);
  const bgEnd = borderLuminance(end, w, h);
  if (bgStart >= WHITE_BG_MIN && bgEnd >= WHITE_BG_MIN) {
    // ink is presence, so (end − start) > 0 means content APPEARED at the
    // end side → orange, matching the MNIST/CCTV "content added" reading.
    start = inkField(start, bgStart);
    end = inkField(end, bgEnd);
  }

  return normalizedDiffToRgba(start, end);
}

/** Diverging RGBA of two server-side presence maps (agg="presence": grayscale
 * per-pixel fraction of member frames deviating from the dataset-median
 * background). The true occupancy replaces the client-side background
 * heuristics entirely; each side is sqrt-boosted so partial occupancy reads
 * as presence, then diffed (content appearing at the end side = orange). */
export function diffRgbaFromPresence(
  startRgba: Uint8ClampedArray,
  endRgba: Uint8ClampedArray
): Uint8ClampedArray {
  const start = luminanceFromRgba(startRgba);
  const end = luminanceFromRgba(endRgba);
  for (let i = 0; i < start.length; i++) start[i] = Math.sqrt(start[i]);
  for (let i = 0; i < end.length; i++) end[i] = Math.sqrt(end[i]);
  return normalizedDiffToRgba(start, end);
}

/** Shared tail: (end − start), per-inset contrast normalization above the
 * noise floor, diverging palette. */
function normalizedDiffToRgba(start: Float32Array, end: Float32Array): Uint8ClampedArray {
  const n = end.length;
  const diff = new Float32Array(n);
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    const d = end[i] - start[i];
    diff[i] = d;
    const abs = d < 0 ? -d : d;
    if (abs > maxAbs) maxAbs = abs;
  }
  if (maxAbs > DIFF_NOISE_FLOOR) {
    for (let i = 0; i < n; i++) diff[i] /= maxAbs;
  }
  // renderImageDiffToRgba maps (end − start); pass the pre-scaled diff
  // against a zero baseline to reuse the shared palette mapping unchanged.
  return renderImageDiffToRgba(new Float32Array(n), diff);
}

/** Decode a summary PNG (object URL) to raw RGBA at size×size. DOM-only. */
export function decodeUrlToRgba(url: string, size: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2d context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      resolve(ctx.getImageData(0, 0, size, size).data);
    };
    img.onerror = () => reject(new Error(`Failed to decode summary image ${url}`));
    img.src = url;
  });
}
