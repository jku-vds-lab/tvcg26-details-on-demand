/**
 * Bounded selective reheat (issue #315): an inset conflict the annealer can
 * NEVER resolve — here, an element whose every position lies inside a foreign
 * cluster contour covering the whole screen — must stop re-warming after
 * SELECTIVE_REHEAT_MAX_ATTEMPTS and let the loop go to sleep. Without the
 * cap the loop livelocks (reheat → anneal → still overlapping → cooldown →
 * reheat, forever), profiled at 43% main-thread duty at rest on synth1m.
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react';
import * as d3 from 'd3';

jest.mock('src/annealing/InsetOptimization', () => ({
  __esModule: true,
  // Instant-cool stub: real annealing decays temperature across frames; the
  // test only needs "a reheat was consumed without resolving the conflict".
  optimizeVisualElementsPositions: jest.fn((elements: Array<{ temperature: number }>) => {
    for (const el of elements) el.temperature = 0;
    return { patch: new Map(), diagnostics: {} };
  }),
}));

import { optimizeVisualElementsPositions } from 'src/annealing/InsetOptimization';
import type { VisualElement } from 'src/models/VisualElement';
import { useLayoutEngine } from './useLayoutEngine';

const optimizeMock = optimizeVisualElementsPositions as jest.Mock;

function makeElement(): VisualElement {
  return {
    id: 'inset-el-0xAAA',
    type: 'inset',
    pinned: false,
    temperature: 0,
    center: { x: 50, y: 50 },
    samples: [],
    sourcePosition: { x: 50, y: 50 },
    getScreenBoundingBoxFor: () => ({ x: 45, y: 45, width: 10, height: 10 }),
  } as unknown as VisualElement;
}

describe('useLayoutEngine bounded selective reheat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    optimizeMock.mockClear();
  });

  it('gives up on an unsatisfiable foreign-contour conflict and sleeps', () => {
    const identity = d3.scaleLinear().domain([0, 100]).range([0, 100]);
    const element = makeElement();
    // One contour covering the entire screen, owned by a DIFFERENT cluster —
    // every possible placement of the element overlaps it.
    const contour = {
      clusterUid: '0xFFFF',
      minX: -10, minY: -10, maxX: 110, maxY: 110,
      points: [[-10, -10], [110, -10], [110, 110], [-10, 110]] as Array<[number, number]>,
    };

    const { unmount } = renderHook(() =>
      useLayoutEngine({
        elements: [element],
        obstacles: [],
        contours: [contour],
        zoomKRef: { current: 1 },
        scalesRef: { current: { x: identity, y: identity } },
        viewboxRef: { current: { minX: 0, minY: 0, maxX: 100, maxY: 100 } },
        weightsRef: { current: {} as never },
        annealRef: { current: { maxIterations: 10, coolingRate: 0.9, jitterStrength: 1 } as never },
        positioningModeRef: { current: 'annealing' },
        nodeTreeRef: { current: { search: () => [] } as never },
        segTreeRef: { current: { search: () => [] } as never },
      })
    );

    // 10 s of fake frames: cooldown is 500 ms, so an uncapped loop would
    // keep reheating (and keep the rAF loop running optimize) forever.
    act(() => {
      for (let i = 0; i < 625; i++) jest.advanceTimersByTime(16);
    });
    const callsAt10s = optimizeMock.mock.calls.length;
    expect(callsAt10s).toBeGreaterThan(0); // the loop did run and consume reheats

    // After the give-up the engine must be ASLEEP: no further optimize calls
    // over 5 more seconds (the watchdog alone must not re-wake it).
    act(() => {
      for (let i = 0; i < 312; i++) jest.advanceTimersByTime(16);
    });
    expect(optimizeMock.mock.calls.length).toBe(callsAt10s);

    unmount();
  });
});
