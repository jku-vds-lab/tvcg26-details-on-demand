/**
 * REGRESSION GUARD: cluster version counters (annotationClusterVersion etc.)
 *
 * These counters are the ONLY mechanism by which ClusterVisualizations knows it
 * must re-render after a clustering result or active-cluster update.  If any
 * counter stops incrementing, annotations will silently freeze and never update
 * without a zoom/pan event — a bug that has regressed multiple times.
 *
 * Root cause of the original regression: an extraReducers block referenced
 * `clusteringSlice.actions.*` during createSlice() execution, when the variable
 * was still `undefined` (temporal dead zone).  The counters were wired but never
 * fired.  Fix: bump counters inline inside each reducer body.
 *
 * If ANY test in this file fails:
 *   ██████████████████████████████████████████████████████████████
 *   ██  CRITICAL: cluster annotations will no longer auto-update  ██
 *   ██  without zoom/pan. Check the relevant reducer in store.ts  ██
 *   ██████████████████████████████████████████████████████████████
 */

import { describe, expect, it } from '@jest/globals';
import store, {
  setAnnotationClusteringResults,
  setEdgeAnnotationClusteringResults,
  setEdgeInsetClusteringResults,
  setInsetClusteringResults,
  updateAnnotationActiveClusters,
  updateEdgeAnnotationActiveClusters,
  updateEdgeInsetActiveClusters,
  updateInsetActiveClusters,
} from '../store';

const fakeCluster = () => ({
  id: 1, uid: 'c1', size: 1, stability: 0, normalizedStability: 0,
  isCoreCluster: false, points: [], footprint: 0, doiMass: 0,
  saliencyScore: 0, distance: 0,
});

const baseResults = () => ({
  labels: [0, 1, 2],
  activeClusters: [fakeCluster()],
  hierarchyId: 1,
});

function readVersion(key: 'annotationClusterVersion' | 'insetClusterVersion' | 'edgeAnnotationClusterVersion' | 'edgeInsetClusterVersion') {
  return store.getState().clustering[key];
}

// ─── set* actions ──────────────────────────────────────────────────────────

describe('REGRESSION GUARD — version counters increment on set* actions', () => {
  it('annotationClusterVersion increments when setAnnotationClusteringResults is dispatched', () => {
    const before = readVersion('annotationClusterVersion');
    store.dispatch(setAnnotationClusteringResults(baseResults()));
    expect(readVersion('annotationClusterVersion')).toBe(before + 1);
  });

  it('insetClusterVersion increments when setInsetClusteringResults is dispatched', () => {
    const before = readVersion('insetClusterVersion');
    store.dispatch(setInsetClusteringResults(baseResults()));
    expect(readVersion('insetClusterVersion')).toBe(before + 1);
  });

  it('edgeAnnotationClusterVersion increments when setEdgeAnnotationClusteringResults is dispatched', () => {
    const before = readVersion('edgeAnnotationClusterVersion');
    store.dispatch(setEdgeAnnotationClusteringResults(baseResults()));
    expect(readVersion('edgeAnnotationClusterVersion')).toBe(before + 1);
  });

  it('edgeInsetClusterVersion increments when setEdgeInsetClusteringResults is dispatched', () => {
    const before = readVersion('edgeInsetClusterVersion');
    store.dispatch(setEdgeInsetClusteringResults(baseResults()));
    expect(readVersion('edgeInsetClusterVersion')).toBe(before + 1);
  });
});

// ─── update* (active-cluster) actions ─────────────────────────────────────

describe('REGRESSION GUARD — version counters increment on update* (active-cluster) actions', () => {
  it('annotationClusterVersion increments when updateAnnotationActiveClusters is dispatched', () => {
    // Ensure results exist first
    store.dispatch(setAnnotationClusteringResults(baseResults()));
    const before = readVersion('annotationClusterVersion');
    store.dispatch(updateAnnotationActiveClusters([fakeCluster()]));
    expect(readVersion('annotationClusterVersion')).toBe(before + 1);
  });

  it('insetClusterVersion increments when updateInsetActiveClusters is dispatched', () => {
    store.dispatch(setInsetClusteringResults(baseResults()));
    const before = readVersion('insetClusterVersion');
    store.dispatch(updateInsetActiveClusters([fakeCluster()]));
    expect(readVersion('insetClusterVersion')).toBe(before + 1);
  });

  it('edgeAnnotationClusterVersion increments when updateEdgeAnnotationActiveClusters is dispatched', () => {
    store.dispatch(setEdgeAnnotationClusteringResults(baseResults()));
    const before = readVersion('edgeAnnotationClusterVersion');
    store.dispatch(updateEdgeAnnotationActiveClusters([fakeCluster()]));
    expect(readVersion('edgeAnnotationClusterVersion')).toBe(before + 1);
  });

  it('edgeInsetClusterVersion increments when updateEdgeInsetActiveClusters is dispatched', () => {
    store.dispatch(setEdgeInsetClusteringResults(baseResults()));
    const before = readVersion('edgeInsetClusterVersion');
    store.dispatch(updateEdgeInsetActiveClusters([fakeCluster()]));
    expect(readVersion('edgeInsetClusterVersion')).toBe(before + 1);
  });
});

// ─── structural guard ──────────────────────────────────────────────────────

describe('REGRESSION GUARD — counter must not start stuck at 0 and stay there', () => {
  it('dispatching set + update raises annotationClusterVersion by at least 2', () => {
    const before = readVersion('annotationClusterVersion');
    store.dispatch(setAnnotationClusteringResults(baseResults()));
    store.dispatch(updateAnnotationActiveClusters([fakeCluster()]));
    expect(readVersion('annotationClusterVersion')).toBeGreaterThanOrEqual(before + 2);
  });
});
