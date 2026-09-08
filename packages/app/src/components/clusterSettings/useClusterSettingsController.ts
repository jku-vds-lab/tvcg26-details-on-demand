import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import store, { updateClusterSettings, updateSettings, type RootState } from '../../store';
import type { ClusterSettingKey } from './types';

type SliderValue = number | number[];

export function useClusterSettingsController() {
  const dispatch = useDispatch();
  const cluster = useSelector((state: RootState) => state.clusterSettings);
  const viz = useSelector((state: RootState) => state.visualizationSettings);

  const setClusterPatch = useCallback(
    (patch: Partial<RootState['clusterSettings']>) => {
      dispatch(updateClusterSettings(patch));
    },
    [dispatch]
  );

  const setVizPatch = useCallback(
    (patch: Partial<RootState['visualizationSettings']>) => {
      dispatch(updateSettings(patch));
    },
    [dispatch]
  );

  // --- Max active clusters ---
  // Local state keeps the thumb smooth on every pointer event.
  // Dispatch uses a leading+trailing throttle (≤1 per 100 ms) so the
  // main thread is never blocked by back-to-back Redux subscriber flushes.
  const [localMaxActive, setLocalMaxActive] = useState(cluster.maxActiveClusters);
  useEffect(() => { setLocalMaxActive(cluster.maxActiveClusters); }, [cluster.maxActiveClusters]);

  const latestMaxActiveRef = useRef(cluster.maxActiveClusters);
  const lastDispatchedMaxActiveRef = useRef(cluster.maxActiveClusters);
  const maxActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMaxActiveChange = useCallback(
    (_: Event, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      setLocalMaxActive(v);
      latestMaxActiveRef.current = v;
      if (maxActiveTimerRef.current === null) {
        // Leading edge: dispatch immediately for instant visual feedback.
        lastDispatchedMaxActiveRef.current = v;
        store.dispatch(updateClusterSettings({ maxActiveClusters: v }));
        // Trailing edge: flush the latest value if it changed during the window.
        maxActiveTimerRef.current = setTimeout(() => {
          maxActiveTimerRef.current = null;
          if (latestMaxActiveRef.current !== lastDispatchedMaxActiveRef.current) {
            lastDispatchedMaxActiveRef.current = latestMaxActiveRef.current;
            store.dispatch(updateClusterSettings({ maxActiveClusters: latestMaxActiveRef.current }));
          }
        }, 100);
      }
    },
    []
  );

  const handleMaxActiveCommit = useCallback(
    (_: Event | SyntheticEvent, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      if (maxActiveTimerRef.current !== null) {
        clearTimeout(maxActiveTimerRef.current);
        maxActiveTimerRef.current = null;
      }
      store.dispatch(updateClusterSettings({ maxActiveClusters: v }));
    },
    []
  );

  // --- Split threshold ---
  // Same pattern: local state for smooth thumb, leading+trailing throttle on dispatch.
  const [localSplitThreshold, setLocalSplitThreshold] = useState(cluster.splitThresholdFraction);
  useEffect(() => { setLocalSplitThreshold(cluster.splitThresholdFraction); }, [cluster.splitThresholdFraction]);

  const latestSplitThresholdRef = useRef(cluster.splitThresholdFraction);
  const lastDispatchedSplitThresholdRef = useRef(cluster.splitThresholdFraction);
  const splitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSplitThresholdChange = useCallback(
    (_: Event, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      setLocalSplitThreshold(v);
      latestSplitThresholdRef.current = v;
      if (splitTimerRef.current === null) {
        lastDispatchedSplitThresholdRef.current = v;
        store.dispatch(updateClusterSettings({ splitThresholdFraction: v }));
        splitTimerRef.current = setTimeout(() => {
          splitTimerRef.current = null;
          if (latestSplitThresholdRef.current !== lastDispatchedSplitThresholdRef.current) {
            lastDispatchedSplitThresholdRef.current = latestSplitThresholdRef.current;
            store.dispatch(updateClusterSettings({ splitThresholdFraction: latestSplitThresholdRef.current }));
          }
        }, 100);
      }
    },
    []
  );

  const handleSplitThresholdCommit = useCallback(
    (_: Event | SyntheticEvent, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      if (splitTimerRef.current !== null) {
        clearTimeout(splitTimerRef.current);
        splitTimerRef.current = null;
      }
      store.dispatch(updateClusterSettings({ splitThresholdFraction: v }));
    },
    []
  );

  // --- Other cluster settings (not on the hot drag path) ---
  const handleClusterChange = useCallback(
    (key: ClusterSettingKey) => (_: Event, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      store.dispatch(updateClusterSettings({ [key]: v } as Partial<RootState['clusterSettings']>));
    },
    []
  );

  const handleScaleRange = useCallback(
    (_: Event, val: SliderValue) => {
      if (!Array.isArray(val)) return;
      const [min, max] = val;
      setClusterPatch({ insetMinScale: min, insetMaxScale: max });
    },
    [setClusterPatch]
  );

  const handleEdgeInsetScaleRange = useCallback(
    (_: Event, val: SliderValue) => {
      if (!Array.isArray(val)) return;
      const [min, max] = val;
      setVizPatch({ edgeInsetMinScale: min, edgeInsetMaxScale: max });
    },
    [setVizPatch]
  );

  const handleEdgeScaleExponentChange = useCallback(
    (_: Event, val: SliderValue) => {
      const v = Array.isArray(val) ? val[0] : val;
      setVizPatch({ edgeScaleExponent: v });
    },
    [setVizPatch]
  );

  const handleEaseChange = useCallback(
    (ease: string) => {
      setClusterPatch({ ease });
    },
    [setClusterPatch]
  );

  const handleRelationLeaderWidthToggle = useCallback(
    (enabled: boolean) => {
      setClusterPatch({ relationLeaderWidthEncodesStrength: enabled });
    },
    [setClusterPatch]
  );

  const handleRelationArrowSizeRange = useCallback(
    (_: Event, val: SliderValue) => {
      if (!Array.isArray(val)) return;
      const [min, max] = val;
      setClusterPatch({ relationArrowMinSize: min, relationArrowMaxSize: max });
    },
    [setClusterPatch]
  );

  const handleLeaderShadowToggle = useCallback(
    (enabled: boolean) => {
      setClusterPatch({ leaderShadow: enabled });
    },
    [setClusterPatch]
  );

  const handleRelationLeaderShadowToggle = useCallback(
    (enabled: boolean) => {
      setClusterPatch({ relationLeaderShadow: enabled });
    },
    [setClusterPatch]
  );

  /** Copies the current node-inset leader-line styling into the relation-leader settings. */
  const handleSyncRelationLeaders = useCallback(() => {
    const s = store.getState().clusterSettings;
    setClusterPatch({
      relationLeaderThickness: s.leaderThickness,
      relationLeaderGray: s.leaderGray,
      relationLeaderOutlineThickness: s.leaderOutlineThickness,
      relationLeaderDashLength: s.leaderDashLength,
      relationLeaderDashGap: s.leaderDashGap,
      relationLeaderShadow: s.leaderShadow,
      relationLeaderShadowIntensity: s.leaderShadowIntensity,
    });
  }, [setClusterPatch]);

  return {
    cluster,
    viz,
    localMaxActive,
    localSplitThreshold,
    handleMaxActiveChange,
    handleMaxActiveCommit,
    handleSplitThresholdChange,
    handleSplitThresholdCommit,
    handleClusterChange,
    handleScaleRange,
    handleEdgeInsetScaleRange,
    handleEdgeScaleExponentChange,
    handleEaseChange,
    handleRelationLeaderWidthToggle,
    handleRelationArrowSizeRange,
    handleLeaderShadowToggle,
    handleRelationLeaderShadowToggle,
    handleSyncRelationLeaders,
  };
}
