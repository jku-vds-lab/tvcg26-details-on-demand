/**
 * Tests for the PSE-parity per-square diff encoding (computeSquareDiff):
 * blue change-heat opacity = total variation distance between the start/end
 * piece distributions, piece shown = end selection's prominent piece iff the
 * prominent piece changed, at its relative share (mirrors ChessChanges.tsx
 * from Projection Space Explorer).
 */
import { describe, expect, it } from '@jest/globals';
import { computeSquareDiff, EMPTY_SQUARE, isMeaningfulChessLabel } from './chessDiffEncoding';

const dist = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('computeSquareDiff (PSE ChessChanges encoding)', () => {
  it('identical distributions → no change heat, no piece', () => {
    const a = dist({ br: 0.5, [EMPTY_SQUARE]: 0.5 });
    const b = dist({ br: 0.5, [EMPTY_SQUARE]: 0.5 });
    const d = computeSquareDiff(a, b);
    expect(d.changeAlpha).toBeCloseTo(0);
    expect(d.code).toBe('');
    expect(d.pieceOpacity).toBe(0);
  });

  it('complete piece swap → full change heat, end piece at full opacity', () => {
    const d = computeSquareDiff(dist({ br: 1 }), dist({ wp: 1 }));
    expect(d.changeAlpha).toBeCloseTo(1);
    expect(d.code).toBe('wp');
    expect(d.pieceOpacity).toBeCloseTo(1);
  });

  it('partial change with changed prominent piece → proportional heat and share opacity', () => {
    // TVD = (|1 − 0.25| + |0 − 0.75|) / 2 = 0.75
    const d = computeSquareDiff(dist({ br: 1 }), dist({ br: 0.25, wq: 0.75 }));
    expect(d.changeAlpha).toBeCloseTo(0.75);
    expect(d.code).toBe('wq');
    expect(d.pieceOpacity).toBeCloseTo(0.75);
  });

  it('distribution shift with unchanged prominent piece → heat but no piece', () => {
    // br stays prominent on both sides; TVD = (0.5 + 0.5) / 2 = 0.5
    const d = computeSquareDiff(dist({ br: 1 }), dist({ br: 0.5, wp: 0.5 }));
    expect(d.changeAlpha).toBeCloseTo(0.5);
    expect(d.code).toBe('');
    expect(d.pieceOpacity).toBe(0);
  });

  it('piece appearing on an empty square → full heat, piece shown', () => {
    const d = computeSquareDiff(dist({ [EMPTY_SQUARE]: 1 }), dist({ wp: 1 }));
    expect(d.changeAlpha).toBeCloseTo(1);
    expect(d.code).toBe('wp');
    expect(d.pieceOpacity).toBeCloseTo(1);
  });

  it('piece disappearing (square emptied) → full heat but no piece (PSE draws nothing)', () => {
    const d = computeSquareDiff(dist({ br: 1 }), dist({ [EMPTY_SQUARE]: 1 }));
    expect(d.changeAlpha).toBeCloseTo(1);
    expect(d.code).toBe('');
    expect(d.pieceOpacity).toBe(0);
  });
});

describe('isMeaningfulChessLabel', () => {
  it('rejects empty, whitespace, and bare numeric codes (incl. majority-vote "+" suffix and raw numbers)', () => {
    expect(isMeaningfulChessLabel('')).toBe(false);
    expect(isMeaningfulChessLabel('  ')).toBe(false);
    expect(isMeaningfulChessLabel('0')).toBe(false);
    expect(isMeaningfulChessLabel('12 +')).toBe(false);
    expect(isMeaningfulChessLabel(0)).toBe(false); // raw column value can be a number
    expect(isMeaningfulChessLabel(null)).toBe(false);
  });

  it('accepts textual labels like opening names', () => {
    expect(isMeaningfulChessLabel('A - Flank Opening')).toBe(true);
    expect(isMeaningfulChessLabel('e4')).toBe(true); // alphanumeric is fine
  });
});
