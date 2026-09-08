import { describe, expect, it } from '@jest/globals';
import {
  chainReachSliderToWeight,
  chainReachWeightToSlider,
  cubicSliderToValue,
  cubicValueToSlider,
  formatSliderLabel,
  proximitySliderToValue,
  proximityValueToSlider,
} from './sliderUtils';

describe('formatSliderLabel', () => {
  it('strips floating-point dust from keyboard-stepped values', () => {
    // MUI accumulates min + k*step in floating point: 30 * 0.01, 3 * 0.1, 7 * 0.05
    expect(formatSliderLabel(30 * 0.01)).toBe('0.3');
    expect(formatSliderLabel(3 * 0.1)).toBe('0.3');
    expect(formatSliderLabel(7 * 0.05)).toBe('0.35');
    expect(formatSliderLabel(0.1 + 0.2)).toBe('0.3');
  });

  it('leaves clean values untouched', () => {
    expect(formatSliderLabel(0)).toBe('0');
    expect(formatSliderLabel(12)).toBe('12');
    expect(formatSliderLabel(0.35)).toBe('0.35');
    expect(formatSliderLabel(1.5)).toBe('1.5');
    expect(formatSliderLabel(0.999)).toBe('0.999');
    expect(formatSliderLabel(10000)).toBe('10000');
  });
});

describe('cubic slider warp (shared names + proximity aliases)', () => {
  it('exposes the proximity names as aliases of the cubic functions', () => {
    expect(proximitySliderToValue).toBe(cubicSliderToValue);
    expect(proximityValueToSlider).toBe(cubicValueToSlider);
  });

  it('warps position -> value as q^3 and back as cbrt', () => {
    expect(cubicSliderToValue(0)).toBe(0);
    expect(cubicSliderToValue(1)).toBe(1);
    expect(cubicSliderToValue(0.5)).toBeCloseTo(0.125, 12);
    for (const v of [0, 0.001, 0.02, 0.1, 0.5, 1]) {
      expect(cubicSliderToValue(cubicValueToSlider(v))).toBeCloseTo(v, 12);
    }
  });
});

describe('proximity slider cubic warp', () => {
  it('is exact at the endpoints', () => {
    expect(proximitySliderToValue(0)).toBe(0);
    expect(proximitySliderToValue(1)).toBe(1);
    expect(proximityValueToSlider(0)).toBe(0);
    expect(proximityValueToSlider(1)).toBe(1);
  });

  it('round-trips position -> value -> position', () => {
    for (const q of [0, 0.05, 0.1, 0.22, 0.5, 0.73, 0.9, 1]) {
      expect(proximityValueToSlider(proximitySliderToValue(q))).toBeCloseTo(q, 12);
    }
  });

  it('round-trips value -> position -> value', () => {
    for (const p of [0, 0.001, 0.01, 0.05, 0.1, 0.5, 0.9, 1]) {
      expect(proximitySliderToValue(proximityValueToSlider(p))).toBeCloseTo(p, 12);
    }
  });

  it('is strictly monotone increasing', () => {
    let prev = -Infinity;
    for (let q = 0; q <= 1.00001; q += 0.05) {
      const v = proximitySliderToValue(q);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('gives the low end fine resolution: positions 0..0.22 cover values 0..~0.0106', () => {
    expect(proximitySliderToValue(0)).toBe(0);
    // 0.22^3 = 0.010648 — the bottom decade of p claims ~22% of the track.
    expect(proximitySliderToValue(0.22)).toBeCloseTo(0.0106, 4);
    // p = 0.1 sits near mid-track; p = 0.01 gets ~22% of the track.
    expect(proximityValueToSlider(0.1)).toBeCloseTo(0.464, 3);
    expect(proximityValueToSlider(0.01)).toBeCloseTo(0.215, 3);
  });
});

describe('reach-linear chain-slider mapping (converged Backward/Forward)', () => {
  const FLOOR = 0.05;
  const SPAN = 0.75;
  const LENGTHS = [2, 10, 107];

  it('is exact at the endpoints for every trajectory length', () => {
    for (const L of LENGTHS) {
      expect(chainReachSliderToWeight(0, L)).toBe(0);
      expect(chainReachSliderToWeight(1, L)).toBe(1);
      expect(chainReachWeightToSlider(0, L)).toBe(0);
      expect(chainReachWeightToSlider(1, L)).toBe(1);
    }
  });

  it('length zone: slider at fraction f of the span reaches f·L steps at the floor', () => {
    // The defining property — "slider at 20 % ⇒ spread along 20 % of the
    // trajectory": the weight decayed over (q/SPAN)·L hops lands exactly on
    // the visibility floor.
    for (const L of LENGTHS) {
      for (const q of [0.15, 0.375, 0.6, SPAN]) {
        const w = chainReachSliderToWeight(q, L);
        const reach = (q / SPAN) * L;
        expect(Math.pow(w, reach)).toBeCloseTo(FLOOR, 10);
      }
    }
  });

  it('saturation zone: the far end walks floor → full, hitting w = 1 at the top', () => {
    const L = 10;
    // u = 0.5 ⇒ end-of-trajectory DoI = FLOOR^0.5.
    const wMid = chainReachSliderToWeight(SPAN + (1 - SPAN) / 2, L);
    expect(Math.pow(wMid, L)).toBeCloseTo(Math.sqrt(FLOOR), 10);
    expect(chainReachSliderToWeight(0.999, L)).toBeLessThan(1);
  });

  it('is continuous at the zone boundary and strictly monotone', () => {
    for (const L of LENGTHS) {
      const below = chainReachSliderToWeight(SPAN - 1e-9, L);
      const at = chainReachSliderToWeight(SPAN, L);
      const above = chainReachSliderToWeight(SPAN + 1e-9, L);
      expect(Math.abs(at - below)).toBeLessThan(1e-6);
      expect(Math.abs(above - at)).toBeLessThan(1e-6);
      let prev = -Infinity;
      for (let q = 0; q <= 1.000001; q += 0.01) {
        const w = chainReachSliderToWeight(q, L);
        expect(w).toBeGreaterThan(prev);
        prev = w;
      }
    }
  });

  it('round-trips position ↔ weight in both zones', () => {
    for (const L of LENGTHS) {
      for (const q of [0.05, 0.2, 0.5, SPAN, 0.8, 0.9, 0.99]) {
        expect(
          chainReachWeightToSlider(chainReachSliderToWeight(q, L), L)
        ).toBeCloseTo(q, 9);
      }
      for (const w of [0.01, 0.2, 0.421875, 0.75, 0.95, 0.999]) {
        expect(
          chainReachSliderToWeight(chainReachWeightToSlider(w, L), L)
        ).toBeCloseTo(w, 9);
      }
    }
  });

  it('the same thumb position means the same trajectory fraction across datasets', () => {
    // Mid-span on chess-like (L=10) and rubik-like (L=107) trajectories:
    // both reach exactly half a typical trajectory.
    const q = SPAN / 2;
    const wChess = chainReachSliderToWeight(q, 10);
    const wRubik = chainReachSliderToWeight(q, 107);
    expect(Math.pow(wChess, 5)).toBeCloseTo(FLOOR, 10);
    expect(Math.pow(wRubik, 53.5)).toBeCloseTo(FLOOR, 10);
    // The rubik weight is far closer to 1 — the mapping absorbs the
    // exponential so the FEEL does not have to.
    expect(wRubik).toBeGreaterThan(wChess);
  });
});
