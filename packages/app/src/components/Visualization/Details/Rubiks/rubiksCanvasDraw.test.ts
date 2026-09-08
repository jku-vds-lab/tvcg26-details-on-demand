// Pure geometry tests for the shared Rubik's canvas scene builder (issue #232).
// The draw path itself needs a real 2D context (not available in jsdom), so the
// testable surface is the scene spec — same approach as imageDiffShared.test.ts.
import { describe, expect, it } from '@jest/globals';
import { buildRubiksScene, RUBIKS_SUPERSAMPLE } from './rubiksCanvasDraw';
import { distance, faces, fineTuningScale, size } from './rubiksUtils';

const effectiveSize = size * fineTuningScale;
const effectiveDistance = distance * fineTuningScale;
const d = effectiveSize + effectiveDistance;

describe('buildRubiksScene', () => {
  it('produces one background rect per face and 14 outline lines', () => {
    const scene = buildRubiksScene(() => null);
    expect(scene.faceRects).toHaveLength(faces.length);
    expect(scene.outlines).toHaveLength(14);
    expect(scene.width).toBeCloseTo(9 * d);
    expect(scene.height).toBeCloseTo(12 * d);
  });

  it('overlaps adjacent face backgrounds so the cross interior is opaque (#232 round 3)', () => {
    const scene = buildRubiksScene(() => null);
    const rectByFace = new Map(faces.map((f, i) => [f, scene.faceRects[i]]));
    const horizontal: Array<[string, string]> = [
      ['left', 'up'],
      ['up', 'right'],
    ];
    for (const [a, b] of horizontal) {
      const ra = rectByFace.get(a as typeof faces[number])!;
      const rb = rectByFace.get(b as typeof faces[number])!;
      expect(ra.x + ra.w).toBeGreaterThan(rb.x);
    }
    const vertical: Array<[string, string]> = [
      ['back', 'up'],
      ['up', 'front'],
      ['front', 'down'],
    ];
    for (const [a, b] of vertical) {
      const ra = rectByFace.get(a as typeof faces[number])!;
      const rb = rectByFace.get(b as typeof faces[number])!;
      expect(ra.y + ra.h).toBeGreaterThan(rb.y);
    }
  });

  it('produces no stickers when cellSpec returns null', () => {
    const scene = buildRubiksScene(() => null);
    expect(scene.stickers).toHaveLength(0);
  });

  it('produces 54 stickers that stay within their face background', () => {
    const scene = buildRubiksScene(() => ({ fill: 'red', ratio: 1 }));
    expect(scene.stickers).toHaveLength(54);
    for (const s of scene.stickers) {
      const face = scene.faceRects.find(
        (f) => s.x >= f.x && s.y >= f.y && s.x + s.w <= f.x + f.w && s.y + s.h <= f.y + f.h
      );
      expect(face).toBeDefined();
    }
  });

  it('sizes a ratio-1 sticker to exactly the cell and centers smaller ratios', () => {
    const full = buildRubiksScene(() => ({ fill: 'red', ratio: 1 }));
    expect(full.stickers[0].w).toBeCloseTo(effectiveSize);

    const half = buildRubiksScene(() => ({ fill: 'red', ratio: 0.5 }));
    expect(half.stickers[0].w).toBeCloseTo(effectiveSize / 2);
    // centered: offset by (effectiveSize - faceSz) / 2 relative to the full sticker
    expect(half.stickers[0].x - full.stickers[0].x).toBeCloseTo(effectiveSize / 4);
  });

  it('clamps out-of-range ratios', () => {
    const over = buildRubiksScene(() => ({ fill: 'red', ratio: 5 }));
    expect(over.stickers[0].w).toBeCloseTo(effectiveSize);
    const under = buildRubiksScene(() => ({ fill: 'red', ratio: -1 }));
    expect(under.stickers[0].w).toBeCloseTo(0);
  });

  it('exposes a supersample factor > 1 (crispness invariant)', () => {
    expect(RUBIKS_SUPERSAMPLE).toBeGreaterThan(1);
  });
});
