/**
 * Columnar action majority (issue #315 insets-at-boot I2): the pure core
 * must be byte-identical to majorityVoteBy(samples, actionLabelOf) over the
 * same members — winner, `multiple`, tie-breaking (Object.entries
 * integer-like reordering), and the NaN/±0/null collapses — and the
 * wrapper must refuse anything without a marker + registered context.
 */

import { describe, expect, it } from '@jest/globals';

import type { PointColumns } from 'src/dataPreprocessing/columnSidecar';
import { registerSidecarColumns } from 'src/dataPreprocessing/columnSidecar';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import {
    actionMajorityColumnarOf,
    actionMajorityFromColumn,
    registerActionMajorityContext,
} from './actionMajority';
import { majorityVoteBy } from './majorityVote';

/** Mirror of BaseInsetRenderer.actionLabelOf (imported would drag the
 * component graph into this dependency-light suite). */
const actionLabelOf = (p: DataPoint): string => {
  const raw = p.action;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
};

function check(colValues: unknown[], first = 0, last = colValues.length) {
  // Identity order; samples mirror what materializeRecords produces
  // (row.action = column value).
  const order = Uint32Array.from(colValues.map((_, i) => i));
  const samples = colValues
    .slice(first, last)
    .map((v) => ({ action: v }) as unknown as DataPoint);
  const columnar = actionMajorityFromColumn(colValues, order, first, last);
  const perMember = majorityVoteBy(samples, actionLabelOf);
  expect(columnar).toEqual(perMember);
  return columnar;
}

describe('actionMajorityFromColumn ≡ majorityVoteBy(actionLabelOf)', () => {
  it('agrees on plain string categories (dict columns)', () => {
    check(['up', 'down', 'up', 'left', 'up', 'down']);
  });

  it('agrees on numeric action columns without materializing per-member strings', () => {
    check([2, 1, 1, 2, 3, 2]);
  });

  it('agrees on count ties (integer-like key reordering decides)', () => {
    check([2, 1, 1, 2]);
    check(['x', '10', 'x', '10']);
  });

  it('agrees on null/undefined/empty and all-empty inputs', () => {
    check(['a', null, undefined, '', 'a', 'b']);
    check([null, undefined, '']);
  });

  it('agrees on NaN and ±0 collapses', () => {
    check([NaN, NaN, 0, -0, 1]);
  });

  it('respects the half-open range', () => {
    const r = check(['z', 'a', 'a', 'b', 'z'], 1, 4);
    expect(r).toEqual({ label: 'a', multiple: true });
  });

  it('walks through a permuted leaf order', () => {
    const col = ['a', 'b', 'b', 'c'];
    const order = Uint32Array.from([3, 1, 2, 0]); // leaf order permutation
    const samples = [3, 1, 2, 0].map(
      (i) => ({ action: col[i] }) as unknown as DataPoint
    );
    expect(actionMajorityFromColumn(col, order, 0, 4)).toEqual(
      majorityVoteBy(samples, actionLabelOf)
    );
  });
});

describe('actionMajorityColumnarOf gates', () => {
  function markedSamples(
    n: number,
    ranges: Array<[number, number]>
  ): DataPoint[] {
    const samples = Array.from({ length: n }, (_, i) => ({ action: i % 2 }) as unknown as DataPoint);
    Object.defineProperty(samples, '__leafRange', {
      value: { tree: 'points', ranges },
      enumerable: false,
      configurable: true,
    });
    return samples;
  }

  it('resolves through a registered context + sidecar action column', () => {
    const nodes: DataPoint[] = [];
    const cols: PointColumns = {
      count: 4,
      byName: { action: ['up', 'up', 'down', 'up'] },
    };
    registerSidecarColumns(nodes, cols);
    const samples = markedSamples(4, [[0, 4]]);
    registerActionMajorityContext(samples, Uint32Array.from([0, 1, 2, 3]), nodes);
    expect(actionMajorityColumnarOf(samples)).toEqual({ label: 'up', multiple: true });
  });

  it('returns null without a marker, without a context, or on a length mismatch', () => {
    const nodes: DataPoint[] = [];
    registerSidecarColumns(nodes, { count: 4, byName: { action: [1, 1, 2, 2] } });
    const order = Uint32Array.from([0, 1, 2, 3]);

    const unmarked = [{ action: 1 }] as unknown as DataPoint[];
    expect(actionMajorityColumnarOf(unmarked)).toBeNull();

    const noContext = markedSamples(4, [[0, 4]]);
    expect(actionMajorityColumnarOf(noContext)).toBeNull();

    const wrongLength = markedSamples(3, [[0, 4]]);
    registerActionMajorityContext(wrongLength, order, nodes);
    expect(actionMajorityColumnarOf(wrongLength)).toBeNull();

    const noActionColumn = markedSamples(4, [[0, 4]]);
    const bareNodes: DataPoint[] = [];
    registerSidecarColumns(bareNodes, { count: 4, byName: { x: new Float64Array(4) } });
    registerActionMajorityContext(noActionColumn, order, bareNodes);
    expect(actionMajorityColumnarOf(noActionColumn)).toBeNull();
  });
});
