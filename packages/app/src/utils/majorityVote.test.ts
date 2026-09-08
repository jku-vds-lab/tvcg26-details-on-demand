/**
 * majorityVoteBy (issue #315 insets-at-boot I2) must be byte-identical to
 * the classic majorityVote — same winner, same tie-breaking (including the
 * Object.entries integer-like key reordering), same empty handling — while
 * skipping the intermediate label-array materialization at the call sites.
 */

import { describe, expect, it } from '@jest/globals';
import { majorityVote, majorityVoteBy } from './majorityVote';

describe('majorityVote / majorityVoteBy equivalence', () => {
  const cases: string[][] = [
    [],
    ['', '', ''],
    ['a'],
    ['a', 'b', 'a'],
    ['b', 'a', 'a', 'b'], // count tie — insertion order decides
    ['2', '1', '1', '2'], // integer-like keys reorder in Object.entries
    ['x', '10', 'x', '10', '2'], // mixed integer-like and plain keys
    ['run', '', 'walk', 'run', ''],
    [' ', ' ', 'a'], // whitespace labels count as labels
  ];

  it.each(cases.map((c) => [c.join(',') || '(empty)', c] as const))(
    'agrees with majorityVote on [%s]',
    (_name, labels) => {
      expect(majorityVoteBy(labels, (l) => l)).toEqual(majorityVote(labels));
    }
  );

  it('applies the label accessor and skips empty results', () => {
    const items = [
      { action: 'up' },
      { action: undefined },
      { action: 'up' },
      { action: 'down' },
    ];
    const result = majorityVoteBy(items, (s) => s.action ?? '');
    expect(result).toEqual({ label: 'up', multiple: true });
  });

  it('reports no majority when every accessor result is empty', () => {
    expect(majorityVoteBy([{ v: null }, { v: null }], () => '')).toEqual({
      label: '',
      multiple: false,
    });
  });
});
