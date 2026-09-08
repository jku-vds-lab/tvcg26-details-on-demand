import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import { EMPTY_SEGMENT_COLUMNS, type SegmentColumns } from "../../dataPreprocessing/splineColumns";
import { disposeWebGLRenderer } from "../core/disposeWebGLRenderer";
import type { WebGLRenderer } from "../core/webglRenderer";
import type { RendererAPI } from "./RendererAPI";
import type { ColorMapping, OpacityFieldUpdateMode, OpacityParams, RendererVisualSettings, StyleSettings } from "./types";

export type CreateRendererAPIOptions = {
  initialEdges?: SegmentColumns | null;
  initialVisualSettings?: RendererVisualSettings;
};

function cloneSettings(s: RendererVisualSettings): RendererVisualSettings {
  return {
    ...s,
    colorPalette: [...s.colorPalette],
  };
}

export function createRendererAPI(renderer: WebGLRenderer, opts: CreateRendererAPIOptions = {}): RendererAPI {
  let lastNodes: DataPoint[] = renderer.nodesList ?? [];
  let lastEdges: SegmentColumns = opts.initialEdges ?? EMPTY_SEGMENT_COLUMNS;
  let lastVisibleNodeCount = lastNodes.length;
  let lastVisibleEdgeCount = lastEdges.segmentCount;
  let currentSettings: RendererVisualSettings = cloneSettings(
    opts.initialVisualSettings ?? (renderer.currentVisualSettings as RendererVisualSettings)
  );

  function applySettings(next: RendererVisualSettings): void {
    currentSettings = cloneSettings(next);
    renderer.updateData(lastNodes, lastEdges, currentSettings);
  }

  function applySettingsPatch(patch: Partial<RendererVisualSettings>): void {
    applySettings({
      ...currentSettings,
      ...patch,
      colorPalette: patch.colorPalette ? [...patch.colorPalette] : [...currentSettings.colorPalette],
    });
  }

  const api: RendererAPI = {
    setData(nodes: DataPoint[], edges: SegmentColumns | null) {
      lastNodes = nodes;
      lastEdges = edges ?? EMPTY_SEGMENT_COLUMNS;
      lastVisibleNodeCount = lastNodes.length;
      lastVisibleEdgeCount = lastEdges.segmentCount;
      renderer.updateData(
        lastNodes,
        lastEdges,
        currentSettings,
        lastVisibleNodeCount,
        lastVisibleEdgeCount
      );
    },

    setColumnData(cols) {
      renderer.updateColumnData?.(cols);
    },

    hasNodeData() {
      return lastNodes.length > 0;
    },

    setTileSource(source) {
      renderer.setTileSource(source);
    },

    setAggregateSource(source) {
      renderer.setAggregateSource(source);
    },

    setDataWindow(nodes: DataPoint[], edges: SegmentColumns | null, visibleNodeCount: number, visibleEdgeCount: number) {
      lastNodes = nodes;
      lastEdges = edges ?? EMPTY_SEGMENT_COLUMNS;
      lastVisibleNodeCount = Math.max(0, Math.min(visibleNodeCount, lastNodes.length));
      lastVisibleEdgeCount = Math.max(0, Math.min(visibleEdgeCount, lastEdges.segmentCount));
      renderer.updateData(
        lastNodes,
        lastEdges,
        currentSettings,
        lastVisibleNodeCount,
        lastVisibleEdgeCount
      );
    },

    setVisualSettings(settings: RendererVisualSettings) {
      applySettings(settings);
    },

    setVisualSettingsFull(settings: RendererVisualSettings) {
      applySettings(settings);
    },

    setStyle(style: StyleSettings) {
      applySettingsPatch({
        nodeRadius: style.nodeRadius,
        nodeOutlineWidth: style.nodeOutlineWidth,
        edgeWidth: style.edgeWidth,
        arrowScale: style.arrowScale,
      });
    },

    setColorMapping(mapping: ColorMapping) {
      applySettingsPatch({
        colorPalette: mapping.colorPalette,
        colorEncoding: mapping.colorEncoding,
      });
    },

    setSize(width: number, height: number, dpr?: number) {
      renderer.setSize(width, height, dpr);
    },

    setInteractiveQuality(on: boolean) {
      renderer.setInteractiveQuality(on);
    },

    setTransform(matrix3: Float32Array | number[]) {
      const asArray = Array.isArray(matrix3) ? matrix3 : Array.from(matrix3);
      renderer.updateTransform(asArray);
    },

    setOpacityParams(params: OpacityParams) {
      currentSettings = {
        ...currentSettings,
        grayOutDoiThreshold: params.threshold,
        minimumOpacityClamping: params.minAlpha,
        maximumOpacityClamping: params.maxAlpha,
      };
      renderer.setOpacityParams(params);
    },

    setOpacityMix(mix: number) {
      renderer.setOpacityMix(mix);
    },

    setOpacityField(values: Float32Array, mode?: OpacityFieldUpdateMode) {
      renderer.setOpacityField(values, mode);
    },

    setEmphasisField(values: Float32Array, mode?: OpacityFieldUpdateMode) {
      renderer.setEmphasisField(values, mode);
    },

    setEmphasisScale(scale: number) {
      renderer.setEmphasisScale(scale);
    },

    setDistanceField(dist, frozen) {
      renderer.setDistanceField(dist, frozen);
    },

    setFalloffPreview(params) {
      renderer.setFalloffPreview(params);
    },

    setFalloffPreviewBlend(t) {
      // Optional on the underlying renderer only in tests/mocks; guard so the
      // commit path's cross-fade degrades to a one-frame swap instead of
      // throwing (same defensive shape as the other preview setters).
      renderer.setFalloffPreviewBlend?.(t);
    },

    setConvergedMotionField(data) {
      return renderer.setConvergedMotionField?.(data) ?? false;
    },

    runConvergedMotionTick(params) {
      return renderer.runConvergedMotionTick?.(params) ?? false;
    },

    pollConvergedMotionTickMs() {
      return renderer.pollConvergedMotionTickMs?.();
    },

    readConvergedMotionField() {
      return renderer.readConvergedMotionField?.() ?? null;
    },

    uploadConvergedMotionExact(values) {
      return renderer.uploadConvergedMotionExact?.(values) ?? false;
    },

    blendConvergedMotionExact(t) {
      return renderer.blendConvergedMotionExact?.(t) ?? false;
    },

    render() {
      renderer.drawScene();
    },

    dispose() {
      disposeWebGLRenderer(renderer);
    },

    getRaw() {
      return renderer;
    },
  };

  return api;
}
