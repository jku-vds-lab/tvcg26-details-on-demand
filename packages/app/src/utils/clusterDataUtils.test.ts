import { describe, beforeEach, it, expect } from '@jest/globals';
import store, { updateClusterSettings } from '../store';
import { applyRendererDefaults, instantiateRenderer } from './clusterDataUtils';
import { CartPoleDatasetRenderer } from '../components/Visualization/Details/CartPole/CartPoleDatasetRenderer';
import { GymDatasetRenderer } from '../components/Visualization/Details/Gym/GymDatasetRenderer';

// helper minimal reset function (values deliberately differ from every
// renderer's defaultScaleBounds so the "applies defaults" test is meaningful)
const resetScales = () => {
  store.dispatch(updateClusterSettings({ insetMinScale: 0.7, insetMaxScale: 3 }));
};

describe('renderer defaults and persistence', () => {
  beforeEach(() => {
    resetScales();
  });

  it('applies renderer default scale bounds', () => {
    applyRendererDefaults('chess');
    const s = store.getState().clusterSettings;
    expect(s.insetMinScale).toBeCloseTo(1.0);
    expect(s.insetMaxScale).toBeCloseTo(2.0);
  });

  it('does not override user scale settings on instantiate', () => {
    store.dispatch(updateClusterSettings({ insetMinScale: 3, insetMaxScale: 4 }));
    instantiateRenderer('chess');
    const s = store.getState().clusterSettings;
    expect(s.insetMinScale).toBeCloseTo(3);
    expect(s.insetMaxScale).toBeCloseTo(4);
  });

  it('keeps customized scales when switching datasets', () => {
    applyRendererDefaults('chess');
    store.dispatch(updateClusterSettings({ insetMinScale: 2, insetMaxScale: 3 }));
    applyRendererDefaults('rubik');
    const s = store.getState().clusterSettings;
    expect(s.insetMinScale).toBeCloseTo(2);
    expect(s.insetMaxScale).toBeCloseTo(3);
  });

  it('instantiates CartPole renderer', () => {
    const r = instantiateRenderer('cartpole');
    expect(r).toBeInstanceOf(CartPoleDatasetRenderer);
  });

  it('instantiates Gym renderer for gymnasium datasets', () => {
    const r = instantiateRenderer('gymnasium');
    expect(r).toBeInstanceOf(GymDatasetRenderer);
  });
});
