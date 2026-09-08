import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { computeThumbResetValue, getThumbIndexFromEvent } from './sliderReset';

// ─── computeThumbResetValue ───────────────────────────────────────────────────

describe('computeThumbResetValue', () => {
  it('returns defaultValue for a single-value slider', () => {
    expect(computeThumbResetValue(5, 10, 0)).toBe(5);
  });

  it('ignores thumbIndex for single-value sliders', () => {
    expect(computeThumbResetValue(5, 10, 1)).toBe(5);
  });

  it('resets the first thumb of a range slider, preserving the second', () => {
    expect(computeThumbResetValue([0, 1], [0.3, 0.8], 0)).toEqual([0, 0.8]);
  });

  it('resets the second thumb of a range slider, preserving the first', () => {
    expect(computeThumbResetValue([0, 1], [0.3, 0.8], 1)).toEqual([0.3, 1]);
  });

  it('handles range sliders where current equals default', () => {
    expect(computeThumbResetValue([0, 1], [0, 1], 0)).toEqual([0, 1]);
  });
});

// ─── getThumbIndexFromEvent ───────────────────────────────────────────────────

describe('getThumbIndexFromEvent', () => {
  it('returns null when the target has no ancestor with data-index', () => {
    const div = document.createElement('div');
    const e = { target: div } as unknown as React.MouseEvent;
    expect(getThumbIndexFromEvent(e)).toBeNull();
  });

  it('returns the thumb index when the target itself has data-index', () => {
    const thumb = document.createElement('span');
    thumb.dataset.index = '0';
    const e = { target: thumb } as unknown as React.MouseEvent;
    expect(getThumbIndexFromEvent(e)).toBe(0);
  });

  it('returns the correct index for the second thumb', () => {
    const thumb = document.createElement('span');
    thumb.dataset.index = '1';
    const e = { target: thumb } as unknown as React.MouseEvent;
    expect(getThumbIndexFromEvent(e)).toBe(1);
  });

  it('walks up the DOM tree to find a parent thumb element', () => {
    const thumb = document.createElement('span');
    thumb.dataset.index = '0';
    const child = document.createElement('span');
    thumb.appendChild(child);
    // The click lands on the inner child, not directly on the thumb span.
    const e = { target: child } as unknown as React.MouseEvent;
    expect(getThumbIndexFromEvent(e)).toBe(0);
  });

  it('returns null when data-index is present on a non-parent non-ancestor element', () => {
    const sibling = document.createElement('span');
    sibling.dataset.index = '0';
    const div = document.createElement('div');
    // `div` is not a descendant of `sibling`.
    const e = { target: div } as unknown as React.MouseEvent;
    expect(getThumbIndexFromEvent(e)).toBeNull();
  });
});
