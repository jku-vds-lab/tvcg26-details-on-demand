// src/components/Visualization/ClusterVisualizations.tsx
import * as d3 from "d3";
import RBush from "rbush";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { AnnealingSettings, computeDiffHoverNudge, ContourObstacle, DerivedInset, OptimizationWeights } from "src/annealing/InsetOptimization";
import { useRTreeRef } from "src/contexts/RTreeContext";
import { useSegmentsRTreeRef } from "src/contexts/SegmentsRTreeContext";
import { useTrajectoryMidpointRTreeRef, useTrajectoryMidpointRTreeVersion } from "src/contexts/TrajectoryMidpointRTreeContext";
import type { DataPoint, RTreeItem, TrajectoryMidpoint } from "src/dataPreprocessing/dataPreprocessing";
import { createFrontierDensityIndex } from "src/dataPreprocessing/frontierDensityIndex";
import { type SegmentSearchIndex } from "src/dataPreprocessing/segmentIndex";
import { createDoiFilteredNodeIndex, type NodeSearchIndex } from "src/dataPreprocessing/nodeIndex";
import { doiGroupOfPoint } from "src/doiPropagation/bakedDoi";
import { getMidpointClusteringContext, getNodeClusteringContext } from "src/clustering/hdbscanClustering";
import { useTrajectoryMidpointsRef } from "src/contexts/TrajectoryMidpointsContext";
import { useCreateAnnotationClusterElements } from "src/hooks/useCreateAnnotationClusterElements";
import { useTfIdfClusterLabels } from "src/hooks/useTfIdfClusterLabels";
import { useCreateEdgeAnnotationClusterElements } from "src/hooks/useCreateEdgeAnnotationClusterElements";
import { useCreateEdgeInsetClusterElements } from "src/hooks/useCreateEdgeInsetClusterElements";
import { sharesFreehandMembers } from "src/hooks/freehandCoverage";
import type { ClusterItem } from "src/hooks/reconcileClusterItems";
import { useCreateFreehandInsetElements } from "src/hooks/useCreateFreehandInsetElements";
import { useCreateInsetClusterElements } from "src/hooks/useCreateInsetClusterElements";
import { useClusterRelations } from "src/hooks/useClusterRelations";
import { useCreateRelationInsetElements } from "src/hooks/useCreateRelationInsetElements";
import type { LayoutPositioningMode } from "src/hooks/useLayoutEngine";
import { useLayoutEngine } from "src/hooks/useLayoutEngine";
import { useRelationInsetMidpoints } from "src/hooks/useRelationInsetMidpoints";
import {
    applyPartial as layoutApplyPartial,
    getSnapshot as layoutGet,
    setPositions as layoutSetPositions,
} from "src/layout/layoutStore";
import { parseClusterUid, type VisualElement } from "src/models/VisualElement";
import store, { type RootState } from "src/store";
import { buildMidpointObstacles } from "src/utils/midpointObstacles";
import { computeViewbox } from "src/utils/viewboxUtils";
import { AnimatedAnnotationClusterItems } from "./AnimatedAnnotationClusterItems";
import { AnimatedEdgeAnnotationClusterItems } from "./AnimatedEdgeAnnotationClusterItems";
import { AnimatedEdgeInsetClusterItems } from "./AnimatedEdgeInsetClusterItems";
import { AnimatedInsetClusterItems } from "./AnimatedInsetClusterItems";
import { InlineLabelInput } from "./labeling/InlineLabelInput";
import { AnimatedConvexHullItems } from "./Visualization/AnimatedConvexHullItems";
import { AnimatedLeaderLines } from "./Visualization/AnimatedLeaderLines";
import { AnimatedRelationLeaderLines } from "./Visualization/AnimatedRelationLeaderLines";
import { HoverDiffLeaders, HoverDiffInsets } from "./HoverDiffGlyphs";
import { selectVisibleRelationInsets } from "./relationInsetSelection";
import { useHoverDiffPairs } from "src/hooks/useHoverDiffPairs";
import { useRelationHover } from "src/hooks/useRelationHover";
import { useRelationSpotlight } from "src/hooks/useRelationSpotlight";

export interface ClusterVisualizationsProps {
  scales: {
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  };
  zoomTransform: d3.ZoomTransform;
  canvasContainer: HTMLDivElement;
  annotationLayerRef: React.Ref<HTMLDivElement>;
  isZoomingRef: React.MutableRefObject<boolean>;
  /** True while a pure-pan gesture is in flight (issue #322): the spatial
   * query viewbox freezes so per-tick element churn stops (the zoom cut is
   * frozen by App during pans anyway). */
  panGestureRef?: React.MutableRefObject<boolean>;
  reheatRef: React.MutableRefObject<() => void>;
}

const REHEAT_TEMPERATURE = 1.0;
const ZOOM_REHEAT_TEMPERATURE = 0.6;

// Stable empty list for the retired legacy edge-inset rendering path.
const NO_EDGE_INSET_ITEMS: ClusterItem[] = [];

// Stable empty list for automated items hidden while showAutoInsets is off.
const EMPTY_CLUSTER_ITEMS: ClusterItem[] = [];

// Stable empty list: relations input while the edge budget is 0.
const NO_RELATION_MIDPOINTS: TrajectoryMidpoint[] = [];

interface ClusterVisualizationsInnerProps extends ClusterVisualizationsProps {
  /** Null on server-cut datasets, which build no point index (issue #315
   * A2): viewport queries are range-live and the annealer density term
   * reads the cut frontier. */
  rTree: RBush<RTreeItem<DataPoint>> | null;
}

const ClusterVisualizationsInner: React.FC<ClusterVisualizationsInnerProps> = ({
  scales,
  zoomTransform,
  canvasContainer,
  annotationLayerRef,
  isZoomingRef,
  panGestureRef,
  reheatRef,
  rTree,
}) => {
  // Hover state for D1: hovering a node inset reveals all its difference insets (uncapped).
  const [hoveredClusterUid, setHoveredClusterUid] = useState<string | null>(null);
  const onHoverCluster = useCallback(
    (uid: string | null) => setHoveredClusterUid(uid),
    []
  );

  // D2 (spotlight on diff-inset hover) lives in useRelationHover, called below
  // once the rendered relation-inset set is known (it needs those ids to clear
  // a hover whose inset unmounted without a mouse-out, issue #264).
  const spotlight = useRelationSpotlight();

  const segmentsRTree = useSegmentsRTreeRef().current;
  const trajectoryMidpointRTree = useTrajectoryMidpointRTreeRef().current;
  // Re-render (and re-read the ref above) when the background midpoint R-tree
  // build lands — otherwise a load applied without user interaction (deep
  // links) leaves the edge/relation pipeline empty until the next re-render.
  const { version: midpointRTreeVersion } = useTrajectoryMidpointRTreeVersion();

  // visualization settings
  const {
    optimizationWeightD,
    optimizationWeightM,
    optimizationWeightL,
    optimizationWeightOS,
    optimizationWeightDS,
    optimizationWeightOI,
    optimizationWeightDI,
    optimizationWeightRTree,
    hardInsetOverlapPenalty,
    hardLeaderCrossingPenalty,
    hardScatterOverlapPenalty,
    hardForeignContourOverlapPenalty,
    contourTargetRadiusMultiplier,
    grayOutDoiThreshold,
    insetOptimizationIterations,
    insetOptimizationCoolingRate,
    insetOptimizationJitterStrength,
    clusterPositioningMode,
  } = useSelector((s: RootState) => s.visualizationSettings);

  // annealing settings
  const annealingSettings = useMemo<AnnealingSettings>(() => ({
    maxIterations: insetOptimizationIterations,
    coolingRate: insetOptimizationCoolingRate,
    jitterStrength: insetOptimizationJitterStrength,
  }), [insetOptimizationIterations, insetOptimizationCoolingRate, insetOptimizationJitterStrength]);

  // filtered spatial indexes
  const annotationVersion      = useSelector((s: RootState) => s.clustering.annotationClusterVersion);
  const insetVersion           = useSelector((s: RootState) => s.clustering.insetClusterVersion);
  const edgeAnnotationVersion  = useSelector((s: RootState) => s.clustering.edgeAnnotationClusterVersion);
  const edgeInsetVersion       = useSelector((s: RootState) => s.clustering.edgeInsetClusterVersion);

  // DoI-filtered searchable view over the shared all-point rbush: candidates
  // are resolved from `rTree` and filtered by DoI at query time (DoI is read
  // per query, so no full-tree rebuild per threshold change). Mirrors
  // `filteredSegmentsTree` below. See nodeIndex.ts for the 1M-point rationale.
  // Server-cut datasets build no point index at all (issue #315 A2): the
  // annealer's density term reads the cut frontier instead — active cluster
  // bbox + size approximate the per-point count (see frontierDensityIndex).
  const filteredNodeTree = useMemo<NodeSearchIndex>(() => {
    if (rTree) return createDoiFilteredNodeIndex(rTree, grayOutDoiThreshold);
    return createFrontierDensityIndex(() => {
      const clustering = store.getState().clustering;
      const ann = clustering.annotationClusteringResults?.activeClusters ?? [];
      const ins = clustering.insetClusteringResults?.activeClusters ?? [];
      return [...ann, ...ins];
    });
  }, [rTree, grayOutDoiThreshold]);

  // DoI-filtered searchable view over the columnar segments: the edge rbush
  // resolves candidates, the columns refine to per-segment hits at query time
  // (edgeDoi is read per query, so no tree rebuild per selection). Frontier
  // fallback as above (midpoint-tree actives approximate edge density);
  // empty until edge actives exist, matching the retired empty-index path.
  const filteredSegmentsTree = useMemo<SegmentSearchIndex>(() => {
    if (segmentsRTree) return segmentsRTree.filtered(grayOutDoiThreshold);
    return createFrontierDensityIndex(() => {
      const clustering = store.getState().clustering;
      const ann = clustering.edgeAnnotationClusteringResults?.activeClusters ?? [];
      const ins = clustering.edgeInsetClusteringResults?.activeClusters ?? [];
      return [...ann, ...ins];
    });
  }, [segmentsRTree, grayOutDoiThreshold]);

  // weights
  const weights = useMemo<OptimizationWeights>(
    () => ({
      wD: optimizationWeightD,
      wM: optimizationWeightM,
      wL: optimizationWeightL,
      wOS: optimizationWeightOS,
      wDS: optimizationWeightDS,
      wOI: optimizationWeightOI,
      wDI: optimizationWeightDI,
      wRTree: optimizationWeightRTree,
      hardInsetOverlapPenalty,
      hardLeaderCrossingPenalty,
      hardScatterOverlapPenalty,
      hardForeignContourOverlapPenalty,
      contourTargetRadiusMultiplier,
    }), [
      optimizationWeightD,
      optimizationWeightM,
      optimizationWeightL,
      optimizationWeightOS,
      optimizationWeightDS,
      optimizationWeightOI,
      optimizationWeightDI,
      optimizationWeightRTree,
      hardInsetOverlapPenalty,
      hardLeaderCrossingPenalty,
      hardScatterOverlapPenalty,
      hardForeignContourOverlapPenalty,
      contourTargetRadiusMultiplier,
    ]
  );

  // compute strict data-space viewbox
    // viewport
  const baseViewbox = React.useMemo(
  () => computeViewbox(canvasContainer, scales, zoomTransform),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- granular fields, not object identity: recompute only when the actual view changes
  [canvasContainer, scales.xScale, scales.yScale, zoomTransform.k, zoomTransform.x, zoomTransform.y]
);
  const marginFactor = 0.1;
  const extendedViewbox = useMemo(() => ({
    minX: baseViewbox.minX - (baseViewbox.maxX - baseViewbox.minX) * marginFactor,
    maxX: baseViewbox.maxX + (baseViewbox.maxX - baseViewbox.minX) * marginFactor,
    minY: baseViewbox.minY - (baseViewbox.maxY - baseViewbox.minY) * marginFactor,
    maxY: baseViewbox.maxY + (baseViewbox.maxY - baseViewbox.minY) * marginFactor,
  }), [baseViewbox]);

  // Issue #322 (extended to zoom at 1M scale, #315): while ANY gesture is in
  // flight, freeze the spatial query viewbox. rbush search results come back
  // in viewport-dependent order, so a per-tick query churns the identity AND
  // order of every downstream nodes array and re-runs the whole
  // query→map→filter→groupBy→reconcile chain — O(visible points) per settled
  // tick — for a cut that mostly hasn't changed (measured: the dominant
  // interaction cost at 1M). Version bumps are the real change signal: when
  // the cut DOES change mid-gesture, adopt the current viewport so the new
  // clusters resolve against fresh queries; the gesture-end flush recomputes
  // for the final viewport as before.
  // C1b2 part 2 (issue #315): when the persistent node clustering matches
  // the dispatched results, all four node-group hooks resolve membership
  // from leaf ranges — the viewport node query exists only to feed their
  // fallback, so skip it entirely (it was O(1M) rbush search + map + two
  // filters per version bump). The midpoint query below is NOT gated:
  // useClusterRelations still consumes visibleMidpoints.
  const insetHierarchyId = useSelector(
    (s: RootState) => s.clustering.insetClusteringResults?.hierarchyId
  );
  const annotationHierarchyId = useSelector(
    (s: RootState) => s.clustering.annotationClusteringResults?.hierarchyId
  );
  const nodeCtx = getNodeClusteringContext();
  const nodeRangesLive =
    nodeCtx != null &&
    insetHierarchyId != null &&
    nodeCtx.hierarchyId === insetHierarchyId &&
    nodeCtx.hierarchyId === annotationHierarchyId;

  // Midpoint twin: when the edge hooks resolve groups from ranges, the
  // midpoint viewport query only feeds their fallback — and the relations
  // scan can read the FULL midpoints array (active clusters are
  // viewport-scoped already, so relations among them are unchanged).
  const edgeInsetHierarchyId = useSelector(
    (s: RootState) => s.clustering.edgeInsetClusteringResults?.hierarchyId
  );
  const midpointCtx = getMidpointClusteringContext();
  const midpointRangesLive =
    midpointCtx != null &&
    edgeInsetHierarchyId != null &&
    midpointCtx.hierarchyId === edgeInsetHierarchyId;
  const allMidpointsRef = useTrajectoryMidpointsRef();

  const frozenViewboxRef = useRef(extendedViewbox);
  const frozenVersionsRef = useRef([annotationVersion, insetVersion] as const);
  const versionsChanged =
    frozenVersionsRef.current[0] !== annotationVersion ||
    frozenVersionsRef.current[1] !== insetVersion;
  if ((!panGestureRef?.current && !isZoomingRef?.current) || versionsChanged) {
    frozenViewboxRef.current = extendedViewbox;
    frozenVersionsRef.current = [annotationVersion, insetVersion];
  }
  const queryViewbox = frozenViewboxRef.current;

  // visible data points
  // The clustering version counters below are deliberate "extra" deps: cluster
  // cuts MUTATE doiGroup / cluster ids in place on the same DataPoint objects,
  // so these memos must re-run on version bumps even though input identities
  // are unchanged (the rule can't see the mutation).
  const nodesInView = useMemo(
    () => (nodeRangesLive || !rTree ? [] : (rTree.search(queryViewbox) as RTreeItem<DataPoint>[])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
    [rTree, queryViewbox, annotationVersion, insetVersion, nodeRangesLive]
  );

  // visible trajectory midpoints
  const midpointItemsInView = useMemo(
    () =>
      trajectoryMidpointRTree && !midpointRangesLive
        ? (trajectoryMidpointRTree.search(
            queryViewbox
          ) as RTreeItem<TrajectoryMidpoint>[])
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
    [trajectoryMidpointRTree, queryViewbox, annotationVersion, insetVersion, midpointRTreeVersion, midpointRangesLive]
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
  const visibleNodes = useMemo(() => nodesInView.map(item => item.data), [nodesInView, annotationVersion, insetVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
  const visibleMidpoints = useMemo(() => midpointItemsInView.map((item) => item.data), [midpointItemsInView, annotationVersion, insetVersion]);
  // Server-baked DoI (issue #315 P7 S5): the provider path writes no per-node
  // doiGroup STRING, so the band is evaluated from the adopted f32 column.
  // This viewport query only feeds the range hooks' FALLBACK (see
  // nodeRangesLive above), but that fallback must not silently classify every
  // point as unwritten while a hierarchy swap is in flight.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
  const annotationNodes = useMemo(() => visibleNodes.filter(n => (doiGroupOfPoint(n) ?? n.doiGroup) === "annotation"), [visibleNodes, annotationVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version counters bust in-place mutations (see block comment)
  const insetNodes      = useMemo(() => visibleNodes.filter(n => (doiGroupOfPoint(n) ?? n.doiGroup) === "inset"), [visibleNodes, insetVersion]);

  const { visibleClusterItems: autoAnnotationItems } = useCreateAnnotationClusterElements(annotationNodes);
  const { visibleClusterItems: autoInsetItems } = useCreateInsetClusterElements(insetNodes);
  const { visibleClusterItems: edgeAnnotationItems } = useCreateEdgeAnnotationClusterElements(visibleMidpoints);
  const { visibleClusterItems: edgeInsetItems } = useCreateEdgeInsetClusterElements(visibleMidpoints);

  // Freehand insets: membership is exactly the lassoed points, sourced from
  // the freehand slice — never from the activation pipeline, so the zoom cut
  // and cluster budget cannot cull them. Hiding the automated layer
  // (showAutoInsets = false) drops the automated items HERE, upstream of
  // nodeItems, so hulls, leader lines, obstacles, and the annealer follow.
  // While automated items are visible, clusters sharing ANY point with a
  // freehand inset are suppressed: the user pinned those points as units,
  // so the cut must not annotate over the freehand selection.
  const showAutoInsets = useSelector((s: RootState) => s.freehand.showAutoInsets);
  const freehandInsets = useSelector((s: RootState) => s.freehand.insets);
  const { visibleClusterItems: freehandInsetItems } = useCreateFreehandInsetElements();
  const freehandMemberUnion = useMemo(() => {
    const union = new Set<number>();
    for (const inset of freehandInsets) {
      for (const id of inset.memberIds) union.add(id);
    }
    return union;
  }, [freehandInsets]);
  const annotationItems = useMemo(
    () =>
      showAutoInsets
        ? autoAnnotationItems.filter(
            ({ element }) => !sharesFreehandMembers(element.samples, freehandMemberUnion)
          )
        : EMPTY_CLUSTER_ITEMS,
    [showAutoInsets, autoAnnotationItems, freehandMemberUnion]
  );
  const insetItems = useMemo(
    () =>
      showAutoInsets
        ? [
            ...autoInsetItems.filter(
              ({ element }) => !sharesFreehandMembers(element.samples, freehandMemberUnion)
            ),
            ...freehandInsetItems,
          ]
        : freehandInsetItems,
    [showAutoInsets, autoInsetItems, freehandInsetItems, freehandMemberUnion]
  );

  // Node items (annotation + inset): needed before relation filtering.
  const nodeItems = useMemo(() => [...annotationItems, ...insetItems], [annotationItems, insetItems]);

  // Element map for leader-line glyph-box attachment: uid → VisualElement.
  // Built before relation filtering so we can use it as a resolvability gate.
  const nodeElementMap = useMemo(() => {
    const m = new Map<string, VisualElement>();
    for (const item of nodeItems) {
      m.set(parseClusterUid(item.element.id), item.element);
    }
    return m;
  }, [nodeItems]);

  // Cluster-conditioned edge relation insets (one per unordered pair, all zoom levels).
  // Feed ALL consolidated relations to the hook — no creation-time nodeElementMap filter.
  // Filtering for visible/leadered items happens after the hook returns (same render as
  // nodeElementMap), avoiding a render-lag where map population and hook state are out of sync.
  // Range-live mode scans the FULL midpoints array (one cheap O(n) field
  // pass) instead of the viewport query result — relations only involve
  // active clusters, which are viewport-scoped by the cut anyway.
  // Budget 0 hides everything relations feed (#261: relation insets, edge
  // labels, hover diffs) — skip the whole extraction too (it scanned 975k
  // midpoints + built per-pair sample arrays per cut change for nothing).
  const relationInsetBudget = useSelector((s: RootState) => s.clusterSettings.relationInsetBudget);
  const consolidatedRelations = useClusterRelations(
    relationInsetBudget > 0
      ? midpointRangesLive
        ? allMidpointsRef.current
        : visibleMidpoints
      : NO_RELATION_MIDPOINTS
  );
  const insetHoverScale = useSelector((s: RootState) => s.clusterSettings.insetHoverScale);
  const { visibleClusterItems: relationInsetItems } = useCreateRelationInsetElements(
    consolidatedRelations,
    nodeElementMap
  );

  useTfIdfClusterLabels(annotationItems, insetItems);

  // Edge-pipeline visibility derives from the edge-inset budget: 0 hides
  // relation insets, edge annotation labels, and hover diffs alike (the
  // slider replaced the former showEdgeAnnotations toggle, #261 part 4).
  // Freehand-pair relations stay eligible while the automated layer is
  // hidden (they belong to the freehand layer); automated/mixed floating
  // relations self-filter then because their anchors leave nodeElementMap.
  const showEdgeAnnotations = relationInsetBudget > 0;
  // Edge annotation labels are activation-derived, so they also hide with
  // the automated layer.
  const effectiveEdgeAnnotationItems = useMemo(
    () => (showEdgeAnnotations && showAutoInsets ? edgeAnnotationItems : []),
    [showEdgeAnnotations, showAutoInsets, edgeAnnotationItems]
  );

  // Classify items from the hook output (computed in same render as nodeElementMap).
  // On-spline: both clusters are singletons → pinned to spline, no leaders.
  // Floating: multi-point clusters → only show those whose both anchors are currently visible
  //   in nodeElementMap. The diff budget caps BOTH kinds jointly (top-N by score, #261 part 3).
  // On-spline items are pinned to the curve (no nodeElementMap resolvability
  // gate), so when the automated layer is hidden keep only freehand pairs.
  const onSplineRelationInsetItems = useMemo(
    () =>
      (showEdgeAnnotations ? relationInsetItems : []).filter(({ element }) => {
        const a = element.relationAnchors;
        if (a?.onSpline !== true) return false;
        return (
          showAutoInsets || (a.uidA.startsWith("fh-") && a.uidB.startsWith("fh-"))
        );
      }),
    [showEdgeAnnotations, showAutoInsets, relationInsetItems]
  );
  // All resolvable floating insets (no budget cap yet) — used as input to the hover-aware selector.
  const resolvableFloating = useMemo(
    () =>
      (showEdgeAnnotations ? relationInsetItems : [])
        .filter(({ element }) => {
          const a = element.relationAnchors;
          return a && !a.onSpline && nodeElementMap.has(a.uidA) && nodeElementMap.has(a.uidB);
        }),
    [showEdgeAnnotations, relationInsetItems, nodeElementMap]
  );
  // If the hovered cluster's inset has unmounted (e.g. zoomed away), fall back to budget view.
  const effectiveHover = hoveredClusterUid && nodeElementMap.has(hoveredClusterUid) ? hoveredClusterUid : null;
  // Hover: reveal all existing insets touching the hovered uid (uncapped).
  // Normal: top-N by combined relation score across floating AND on-spline
  // insets (on-spline items count against the budget too since #261 part 3).
  const {
    floating: visibleFloatingRelationInsetItems,
    onSpline: visibleOnSplineRelationInsetItems,
  } = useMemo(
    () =>
      selectVisibleRelationInsets(
        resolvableFloating,
        onSplineRelationInsetItems,
        effectiveHover,
        relationInsetBudget
      ),
    [resolvableFloating, onSplineRelationInsetItems, effectiveHover, relationInsetBudget]
  );

  // Ids of the relation insets actually rendered this commit — the valid hover
  // targets for D2. Synthetic hover diffs (HoverDiffGlyphs) never call
  // onHoverRelation, so this set is exhaustive.
  const renderedRelationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { element } of visibleFloatingRelationInsetItems) ids.add(element.id);
    for (const { element } of visibleOnSplineRelationInsetItems) ids.add(element.id);
    return ids;
  }, [visibleFloatingRelationInsetItems, visibleOnSplineRelationInsetItems]);

  // D2: spotlight the relation's trajectory edges when hovering a diff inset;
  // auto-clears (both JSX dimming and the WebGL tween) when the hovered inset
  // unmounts without a mouse-out (issue #264).
  const { spotlightUids, hoveredRelationItem, onHoverRelation } = useRelationHover(
    spotlight,
    renderedRelationIds
  );

  // Legacy edge-inset rendering retired: edgeInsetClusteringResults collapses at deep zoom.
  // edgeInsetItems is still computed above because midpointObstacles uses it for annealing.
  // Module-level constant: a fresh [] here busted the allItems memo every render.
  const effectiveEdgeInsetItems = NO_EDGE_INSET_ITEMS;

  // Leader items: derived from visible floating insets (anchors guaranteed resolvable above).
  const relationLeaderItems = useMemo(
    () =>
      visibleFloatingRelationInsetItems.flatMap(({ element }) => {
        if (!element.relationAnchors) return [];
        const elementA = nodeElementMap.get(element.relationAnchors.uidA);
        const elementB = nodeElementMap.get(element.relationAnchors.uidB);
        if (!elementA || !elementB) return [];
        return [{ element, elementA, elementB }];
      }),
    [visibleFloatingRelationInsetItems, nodeElementMap]
  );

  // resolvableFloating (all anchors visible) rather than visibleFloatingRelationInsetItems
  // (budget/hover filtered) so setCssScale and position-seeding cover hidden-but-live insets.
  const allItems = useMemo(
    () => [
      ...nodeItems,
      ...effectiveEdgeAnnotationItems,
      ...effectiveEdgeInsetItems,
      ...resolvableFloating,
      ...onSplineRelationInsetItems,
    ],
    [nodeItems, effectiveEdgeAnnotationItems, effectiveEdgeInsetItems, resolvableFloating, onSplineRelationInsetItems]
  );
  const allElements = useMemo(() => allItems.map((item) => item.element), [allItems]);

  // The cleanup effect must treat every element that ANY creation hook seeds a position for
  // as "live". Using allElements (the rendered subset) causes an infinite loop: elements
  // excluded from rendering (edgeInsetItems, off-budget relationInsetItems, etc.) are still
  // seeded by their creation hooks; the cleanup removes those positions, the hook re-seeds
  // them, the cleanup fires again, ...
  const seededElementIds = useMemo(
    () =>
      new Set(
        [...nodeItems, ...edgeAnnotationItems, ...edgeInsetItems, ...relationInsetItems].map(
          (i) => i.element.id
        )
      ),
    [nodeItems, edgeAnnotationItems, edgeInsetItems, relationInsetItems]
  );

  useEffect(() => {
    const invk = 1 / zoomTransform.k;
    allItems.forEach(({ element, hull }) => {
      element.setCssScale(invk);
      hull?.setCssScale?.(invk);
    });
  }, [zoomTransform.k, allItems]);

  // Prune positions for elements that no longer exist (zoomed away / cluster dissolved).
  // Uses seededElementIds — the full set of elements any creation hook produced — not the
  // narrower rendered subset, to avoid fighting the hooks' seed-if-missing writes.
  useEffect(() => {
    const { positions } = layoutGet();
    let removedAny = false;
    const next = new Map<string, { x: number; y: number }>();

    positions.forEach((pos, id) => {
      const isClusterElementId = id.includes("-inset-") || id.includes("-annotation-");
      if (isClusterElementId && !seededElementIds.has(id)) {
        removedAny = true;
        return;
      }
      next.set(id, pos);
    });

    if (removedAny) {
      layoutSetPositions(next);
    }
  }, [seededElementIds]);

  useEffect(() => {
    const { positions } = layoutGet();
    const patch = new Map<string, { x: number; y: number }>();

    for (const el of allElements) {
      if (!positions.has(el.id)) {
        // Keep element-local placement (including remembered world positions)
        // instead of forcing source anchors on reappearance.
        patch.set(el.id, { ...el.center });
        // Warm only genuinely new elements; restored cold elements stay fixed.
        if (el.temperature > 0) {
          el.temperature = Math.max(el.temperature, REHEAT_TEMPERATURE);
        }
      }
    }

    if (patch.size) layoutApplyPartial(patch);
    // note: no annotationVersion/insetVersion here on purpose
  }, [allElements]);

  useEffect(() => {
    reheatRef.current = () => {
      allElements.forEach((el) => {
        if (el.pinned) return; // user-dragged placement survives zoom reheats (#290)
        el.temperature = Math.max(el.temperature, ZOOM_REHEAT_TEMPERATURE);
      });
    };
  }, [reheatRef, allElements]);

  // Stable ref so the nudge effect's dep array stays narrow (only hoveredRelationItem
  // and insetHoverScale) and doesn't re-fire on unrelated nodeElementMap rebuilds.
  const nodeElementMapRef = useRef(nodeElementMap);
  useEffect(() => { nodeElementMapRef.current = nodeElementMap; }, [nodeElementMap]);

  // Overlap-gated symmetric nudge: on diff hover, if the enlarged diff box actually
  // overlaps a parent node inset, push ONLY those two parents apart (symmetrically,
  // minimum clearance, along the A→B axis).  On mouse-out (hoveredRelationItem = null)
  // nothing moves.  Parents stay cold (temperature unchanged) so the annealer never
  // undoes the patch.
  useEffect(() => {
    if (!hoveredRelationItem) return; // mouse-out → no movement
    const anchors = hoveredRelationItem.element.relationAnchors;
    if (!anchors || anchors.onSpline) return;

    const elemA = nodeElementMapRef.current.get(anchors.uidA);
    const elemB = nodeElementMapRef.current.get(anchors.uidB);
    if (!elemA || !elemB) return;
    // A user-dragged parent must not move (#290), and pushing only the other
    // parent would shift the midpoint — the hovered diff would slide out from
    // under the cursor. Skip the nudge entirely for pinned pairs.
    if (elemA.pinned || elemB.pinned) return;

    const sc = scalesRef.current;
    if (!sc) return;

    const { positions } = layoutGet();
    const pA = positions.get(elemA.id) ?? elemA.center;
    const pB = positions.get(elemB.id) ?? elemB.center;
    const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };

    // Inflate the diff's logical box by insetHoverScale (mirrors framer-motion's visual scale).
    const rawDiff = hoveredRelationItem.element.getScreenBoundingBoxFor(mid, sc.x, sc.y);
    const inflate = insetHoverScale;
    const diffBox = {
      x: rawDiff.x + rawDiff.width * (1 - inflate) / 2,
      y: rawDiff.y + rawDiff.height * (1 - inflate) / 2,
      width:  rawDiff.width  * inflate,
      height: rawDiff.height * inflate,
    };

    const boxA = elemA.getScreenBoundingBoxFor(pA, sc.x, sc.y);
    const boxB = elemB.getScreenBoundingBoxFor(pB, sc.x, sc.y);

    const pxPerDataX = sc.x(1) - sc.x(0);
    const pxPerDataY = sc.y(1) - sc.y(0);
    if (Math.abs(pxPerDataX) < 1e-12 || Math.abs(pxPerDataY) < 1e-12) return;

    const nudge = computeDiffHoverNudge({
      diffBox, boxA, boxB,
      screenAX: sc.x(pA.x), screenAY: sc.y(pA.y),
      screenBX: sc.x(pB.x), screenBY: sc.y(pB.y),
      pxPerDataX, pxPerDataY,
    });

    if (nudge) {
      layoutApplyPartial(new Map([
        [elemA.id, { x: pA.x + nudge.dA.x, y: pA.y + nudge.dA.y }],
        [elemB.id, { x: pB.x + nudge.dB.x, y: pB.y + nudge.dB.y }],
      ]));
    }
  }, [hoveredRelationItem, insetHoverScale]);

  const zoomKRef = useRef(zoomTransform.k);
  useEffect(() => { zoomKRef.current = zoomTransform.k; }, [zoomTransform.k]);

  const scalesRef = useRef<{ x: typeof scales.xScale; y: typeof scales.yScale } | null>(null);
  useEffect(() => { scalesRef.current = { x: scales.xScale, y: scales.yScale }; }, [scales]);

  const viewboxRef = useRef(baseViewbox);
  useEffect(() => { viewboxRef.current = baseViewbox; }, [baseViewbox]);

  const weightsRef = useRef(weights);
  useEffect(() => { weightsRef.current = weights; }, [weights]);

  const annealRef = useRef(annealingSettings);
  useEffect(() => { annealRef.current = annealingSettings; }, [annealingSettings]);
  const positioningModeRef = useRef<LayoutPositioningMode>(clusterPositioningMode);
  useEffect(() => {
    positioningModeRef.current = clusterPositioningMode;
  }, [clusterPositioningMode]);
  const invk = 1 / zoomTransform.k;

  const midpointObstacles = useMemo(() => {
    if (!scales) return [];
    return buildMidpointObstacles({
      items: edgeInsetItems.map(({ element }) => {
        const bb = element.renderer.getBoundingBox();
        return {
          id: element.id,
          x: element.sourcePosition.x,
          y: element.sourcePosition.y,
          kind: "inset" as const,
          insetWidth: bb.width * invk,
          insetHeight: bb.height * invk,
        };
      }),
      xScale: scales.xScale,
      yScale: scales.yScale,
    });
  }, [edgeInsetItems, scales, invk]);

  const contourObstacles = useMemo<ContourObstacle[]>(() => {
    const seen = new Set<string>();
    const out: ContourObstacle[] = [];

    for (const item of nodeItems) {
      const hull = item.hull;
      if (!hull) continue;

      const clusterUid = parseClusterUid(item.element.id);
      if (seen.has(clusterUid)) continue;

      // Pass the live 1/k explicitly: a hull created this render still has the
      // constructor-default currentCssScale until the setCssScale effect runs
      // after commit, which would bake an oversized obstacle here (issue #265).
      const rawPoints = hull.getScreenHull(scales.xScale, scales.yScale, invk);
      if (rawPoints.length < 3) continue;

      // Decimate for the annealer: clipper's round-join buffering emits
      // hundreds of vertices per hull, and the energy function walks every
      // edge per candidate move — point-in-polygon alone was 22% of the
      // budget-slider burst at 1M (issue #315). ~48 vertices keeps the
      // penalty geometry well within the padding slack.
      const stride = Math.ceil(rawPoints.length / 48);
      const points =
        stride > 1 ? rawPoints.filter((_, i) => i % stride === 0) : rawPoints;

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [px, py] of points) {
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }

      out.push({ clusterUid, points, minX, minY, maxX, maxY });
      seen.add(clusterUid);
    }

    return out;
  }, [nodeItems, scales.xScale, scales.yScale, invk]);

  // Node insets are the sole annealed set (first-class positioning).
  // Floating difference insets are excluded: they are pinned reactively to the midpoint of
  // their two node insets by `useRelationInsetMidpoints` below, keeping A→x→B collinear.
  // On-spline insets are also excluded (pinned to spline midpoint at creation).
  const movableElements = useMemo(
    () => nodeItems.map((i) => i.element),
    [nodeItems]
  );

  const nodeTreeRef = useRef(filteredNodeTree);
  useEffect(() => { nodeTreeRef.current = filteredNodeTree; }, [filteredNodeTree]);
  const segTreeRef = useRef(filteredSegmentsTree);
  useEffect(() => { segTreeRef.current = filteredSegmentsTree; }, [filteredSegmentsTree]);

  // Build DerivedInset list from all resolvable floating diff insets (not budget-filtered,
  // so off-budget diff positions are still penalised during annealing).
  const derivedDiffInsets = useMemo<DerivedInset[]>(
    () => {
      const result: DerivedInset[] = [];
      for (const { element } of resolvableFloating) {
        const anchors = element.relationAnchors;
        if (!anchors || anchors.onSpline) continue;
        const ea = nodeElementMap.get(anchors.uidA);
        const eb = nodeElementMap.get(anchors.uidB);
        if (!ea || !eb) continue;
        result.push({ element, nodeIdA: ea.id, nodeIdB: eb.id });
      }
      return result;
    },
    [resolvableFloating, nodeElementMap]
  );
  const derivedInsetsRef = useRef<DerivedInset[]>(derivedDiffInsets);
  useEffect(() => { derivedInsetsRef.current = derivedDiffInsets; }, [derivedDiffInsets]);

  const layoutEngine = useLayoutEngine({
    elements: movableElements,
    obstacles: midpointObstacles,
    contours: contourObstacles,
    zoomKRef,
    scalesRef,
    viewboxRef,
    weightsRef,
    annealRef,
    positioningModeRef,
    nodeTreeRef,
    segTreeRef,
    isZoomingRef,
    derivedInsetsRef,
  });

  // The engine sleeps once the layout converges (engineIdle.ts). Geometry
  // inputs it reads through refs must wake it here; element/obstacle/contour
  // changes wake it inside the hook, and external layoutStore writes wake it
  // via its store subscription. Weights/anneal settings are deliberately not
  // dependencies: with every element cold the annealer moves nothing
  // regardless of them, and whatever warms an element wakes the engine.
  useEffect(() => {
    layoutEngine.wake();
  }, [
    layoutEngine,
    scales,
    baseViewbox,
    clusterPositioningMode,
    derivedDiffInsets,
    zoomTransform,
  ]);

  // Pin ALL resolvable floating insets to midpoints (not just visible) so that hidden insets
  // stay position-correct; when they re-appear on hover-end they are already at the right spot.
  useRelationInsetMidpoints(resolvableFloating, nodeElementMap);

  // Memoized items for AnimatedLeaderLines — stable reference so the memo comparator
  // doesn't force a re-render on every hover or unrelated parent update.
  const leaderLineItems = useMemo(
    () => nodeItems.map((item) => ({ element: item.element, hull: item.hull! })),
    [nodeItems]
  );

  // Synthetic diff pairs for node-inset hover.
  const hoverDiffPairs = useHoverDiffPairs(effectiveHover, nodeElementMap, visibleFloatingRelationInsetItems);

  return (
    <div
      ref={annotationLayerRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        transformOrigin: "0 0",
        pointerEvents: "none",
        overflow: "visible",
      }}
    >
      <AnimatedConvexHullItems
        hulls={nodeItems.map((item) => item.hull!)}
        scales={scales}
        canvasWidth={canvasContainer.clientWidth}
        canvasHeight={canvasContainer.clientHeight}
        cssScale={invk}
        spotlightUids={spotlightUids}
      />

      <AnimatedLeaderLines
        items={leaderLineItems}
        scales={scales}
        canvasWidth={canvasContainer.clientWidth}
        canvasHeight={canvasContainer.clientHeight}
        cssScale={invk}
        spotlightUids={spotlightUids}
      />

      <AnimatedRelationLeaderLines
        items={relationLeaderItems}
        scales={scales}
        canvasWidth={canvasContainer.clientWidth}
        canvasHeight={canvasContainer.clientHeight}
        cssScale={invk}
        spotlightUids={spotlightUids}
        hoverUid={effectiveHover}
        hoverScale={insetHoverScale}
      />

      {/* Synthetic leaders for node-inset hover — below inset divs, same z-depth as real relation leaders */}
      <HoverDiffLeaders
        pairs={hoverDiffPairs}
        scales={scales}
        cssScale={invk}
      />

      <AnimatedAnnotationClusterItems
        annotationItems={annotationItems}
        scales={scales}
        version={annotationVersion}
        spotlightUids={spotlightUids}
      />

      <AnimatedInsetClusterItems
        insetItems={insetItems}
        scales={scales}
        version={insetVersion}
        onHoverCluster={onHoverCluster}
        hoverEnabled={true}
        spotlightUids={spotlightUids}
      />

      <AnimatedEdgeAnnotationClusterItems
        annotationItems={effectiveEdgeAnnotationItems}
        scales={scales}
        version={edgeAnnotationVersion}
        spotlightUids={spotlightUids}
      />

      {/* D2: diff insets receive hover; onHoverRelation wires both the WebGL spotlight
          and spotlightUids state so JSX layers dim unrelated clusters in sync. */}
      <AnimatedEdgeInsetClusterItems
        insetItems={[...visibleFloatingRelationInsetItems, ...visibleOnSplineRelationInsetItems]}
        scales={scales}
        version={edgeInsetVersion}
        hoverEnabled={showEdgeAnnotations}
        onHoverRelation={onHoverRelation}
        spotlightUids={spotlightUids}
      />

      {/* Synthetic glyph divs for node-inset hover — same z-depth as edge insets */}
      <HoverDiffInsets
        pairs={hoverDiffPairs}
        scales={scales}
      />

      <InlineLabelInput scales={scales} zoomTransform={zoomTransform} canvasContainer={canvasContainer} />

      {/*visibleClusters.map(({ cluster, element }) => {
        const stabilityText = cluster.stability?.toFixed(2);
        if (!stabilityText) {
          return null;
        }

        const x = scales.xScale(element.sourcePosition.x);
        const y = scales.yScale(element.sourcePosition.y);

        const fontSize = 24 / zoomTransform.k;
        const count = cluster.size || 1;
        const blur = Math.min(10, Math.sqrt(count) * 2) / zoomTransform.k;
        const offsetY = blur / 2;
        const color = 'rgba(0,0,0,0.5)';

        return (
          <svg
            key={`cluster-stability-${cluster.uid}`}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: 1,
              height: 1,
              overflow: 'visible',
              pointerEvents: 'none',
              filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})`
            }}
          >
            <text
              dy=".3em"
              paintOrder="stroke fill markers"
              textAnchor="middle"
              fontFamily="sans-serif"
              fontSize={fontSize}
              fill="black"
              stroke="white"
              strokeWidth={4 / zoomTransform.k}
            >
              {stabilityText}
            </text>
          </svg>
        );
      })*/}


    </div>
  );
};

// Guard wrapper: the early-out for a missing canvas container must not sit
// above hook calls (hook-order crash if it ever flips between renders), so
// it lives here and ClusterVisualizationsInner keeps every hook
// unconditional. A null rTree is legitimate on server-cut datasets (issue
// #315 A2) — the mount is gated by rTreeReady, which those datasets flip
// without building indexes.
const ClusterVisualizations: React.FC<ClusterVisualizationsProps> = (props) => {
  const rTree = useRTreeRef().current;
  if (!props.canvasContainer) {
    console.error("Canvas container is undefined.");
    return null;
  }
  return <ClusterVisualizationsInner {...props} rTree={rTree ?? null} />;
};

export default ClusterVisualizations;
