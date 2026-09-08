/**
 * Lazy labeling id source (issue #315 R1a, census A17): on a column-backed
 * canonical array the count comes from the id column and the id array
 * builds only when get() is called (rare select-all / labeled-session
 * paths); plain arrays keep the eager filtered copy.
 */

import { describe, expect, it } from '@jest/globals';
import { labelingNodeIdSourceFor } from './useLabelingModeKeyboardToggle';

describe('labelingNodeIdSourceFor (issue #315 R1a A17)', () => {
  it('column ids: count without touching rows, ids on demand', () => {
    const columnIds = new Int32Array([11, 22, 33]);
    // Rows that would throw on any property read — the columnar source
    // must never dereference them.
    const explosive = new Proxy([{}, {}, {}] as { id?: number }[], {
      get(target, prop) {
        if (prop === 'length') return 3;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          throw new Error('row dereferenced on the columnar path');
        }
        return Reflect.get(target, prop);
      },
    });

    const src = labelingNodeIdSourceFor(explosive, columnIds);
    expect(src.count).toBe(3);
    expect(src.get()).toEqual([11, 22, 33]);
  });

  it('plain arrays keep the eager filtered semantics', () => {
    const src = labelingNodeIdSourceFor(
      [{ id: 1 }, { id: null }, { id: 3 }, {}],
      null
    );
    expect(src.count).toBe(2);
    expect(src.get()).toEqual([1, 3]);
  });

  it('null data yields an empty source', () => {
    const src = labelingNodeIdSourceFor(null, null);
    expect(src.count).toBe(0);
    expect(src.get()).toEqual([]);
  });
});
