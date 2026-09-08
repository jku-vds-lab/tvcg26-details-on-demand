/**
 * Tests for the hover-diff sample synthesis pattern in HoverDiffInsetItem.
 *
 * The key invariant: samples are created via Object.create(aPoint) rather than
 * {...aPoint, edgeStart, edgeEnd}. This is critical for performance — DataPoints
 * in image-based datasets (CCTV: 9 216 pixel keys, MNIST: 784) would otherwise
 * be fully shallow-copied per sample per pair inside the React commit, causing
 * multi-second first-hover freezes.
 *
 * We test the synthesis logic directly (it lives in HoverDiffInsetItem.useMemo)
 * by replicating the exact pattern and asserting:
 *   1. edgeStart / edgeEnd are own properties of the wrapper.
 *   2. Inherited DataPoint fields (action, x, y) are readable.
 *   3. No pixel-key properties are own properties of the wrapper.
 *   4. The original aPoint object is NOT mutated.
 */
import { describe, expect, it } from '@jest/globals';
import type { EdgeAugmentedPoint } from 'src/hooks/useCreateRelationInsetElements';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal DataPoint-like object with a payload of "pixel" own properties. */
function makePixelPoint(opts: { action: string; x: number; numPixels: number }) {
  const p: Record<string, unknown> = {
    id: 1,
    x: opts.x,
    y: 0,
    action: opts.action,
    DoI: 1,
    line: 0,
  };
  // Simulate CCTV-style pixel keys "CxR"
  for (let i = 0; i < opts.numPixels; i++) {
    p[`${i + 1}x1`] = (i / opts.numPixels).toFixed(4);
  }
  return p;
}

/** Replicate the synthesis logic from HoverDiffInsetItem (the fixed version). */
function synthesizeSamples(
  aPoints: object[],
  bPoints: object[],
): EdgeAugmentedPoint[] {
  const n = Math.max(bPoints.length, 1);
  return aPoints.map((aPoint, i) => {
    const s = Object.create(aPoint) as EdgeAugmentedPoint;
    s.edgeStart = aPoint as EdgeAugmentedPoint;
    s.edgeEnd   = bPoints[i % n] as EdgeAugmentedPoint;
    return s;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HoverDiffGlyphs sample synthesis (Object.create pattern)', () => {
  const NUM_PIXELS = 100; // small stand-in for 9216

  it('edgeStart and edgeEnd are own properties of each wrapper', () => {
    const aPoints = [makePixelPoint({ action: 'L', x: 0, numPixels: NUM_PIXELS })];
    const bPoints = [makePixelPoint({ action: 'R', x: 1, numPixels: NUM_PIXELS })];

    const samples = synthesizeSamples(aPoints, bPoints);
    expect(samples).toHaveLength(1);

    const own = Object.getOwnPropertyNames(samples[0]);
    expect(own).toContain('edgeStart');
    expect(own).toContain('edgeEnd');
  });

  it('wrapper has NO own pixel-key properties (prototype delegation, not spread)', () => {
    const aPoints = [makePixelPoint({ action: 'L', x: 0, numPixels: NUM_PIXELS })];
    const bPoints = [makePixelPoint({ action: 'R', x: 1, numPixels: NUM_PIXELS })];

    const samples = synthesizeSamples(aPoints, bPoints);
    const own = new Set(Object.getOwnPropertyNames(samples[0]));

    // No pixel keys should be own properties of the wrapper
    for (let i = 0; i < NUM_PIXELS; i++) {
      expect(own.has(`${i + 1}x1`)).toBe(false);
    }

    // The only own properties are the two we set
    expect(Array.from(own).sort()).toEqual(['edgeEnd', 'edgeStart'].sort());
  });

  it('inherited DataPoint fields (action, x, y, DoI) are readable on the wrapper', () => {
    const aPoint = makePixelPoint({ action: 'jump', x: 3.5, numPixels: 4 });
    const bPoint = makePixelPoint({ action: 'noop', x: 7.0, numPixels: 4 });

    const [sample] = synthesizeSamples([aPoint], [bPoint]);

    // These come through the prototype chain — must not throw or return undefined.
    // Double-cast required because EdgeAugmentedPoint has no index signature.
    const s = sample as unknown as Record<string, unknown>;
    expect(s.action).toBe('jump');
    expect(s.x as number).toBeCloseTo(3.5);
    expect(s.DoI).toBe(1);
  });

  it('edgeStart references the original aPoint object (no copy)', () => {
    const aPoint = makePixelPoint({ action: 'A', x: 0, numPixels: 4 });
    const bPoint = makePixelPoint({ action: 'B', x: 1, numPixels: 4 });

    const [sample] = synthesizeSamples([aPoint], [bPoint]);

    expect(sample.edgeStart).toBe(aPoint); // same reference, not a copy
    expect(sample.edgeEnd).toBe(bPoint);
  });

  it('edgeEnd wraps around when bPoints is shorter than aPoints', () => {
    const aPoints = [0, 1, 2].map((x) =>
      makePixelPoint({ action: String(x), x, numPixels: 4 })
    );
    const bPoints = [makePixelPoint({ action: 'b0', x: 10, numPixels: 4 })];

    const samples = synthesizeSamples(aPoints, bPoints);
    // All three wrappers should reference the single bPoint
    for (const s of samples) {
      expect(s.edgeEnd).toBe(bPoints[0]);
    }
  });

  it('does not mutate the original aPoint', () => {
    const aPoint = makePixelPoint({ action: 'noop', x: 0, numPixels: 4 });
    const ownKeysBefore = Object.getOwnPropertyNames(aPoint);

    synthesizeSamples([aPoint], [makePixelPoint({ action: 'X', x: 1, numPixels: 4 })]);

    // aPoint itself should be unchanged
    expect(Object.getOwnPropertyNames(aPoint)).toEqual(ownKeysBefore);
    expect((aPoint as Record<string, unknown>).edgeStart).toBeUndefined();
    expect((aPoint as Record<string, unknown>).edgeEnd).toBeUndefined();
  });
});
