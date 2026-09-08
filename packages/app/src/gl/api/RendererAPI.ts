import type { PointColumns as SidecarPointColumns } from "../../dataPreprocessing/columnSidecar";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { SegmentColumns } from "../../dataPreprocessing/splineColumns";
import type { AggregateTileSource, ScatterTileSource } from "../../scaling.types";
import type { FalloffPreviewParams } from "../../doiPropagation/falloff";
import type { ColorMapping, OpacityFieldUpdateMode, OpacityParams, RendererVisualSettings, StyleSettings } from "./types";
import type { FrozenChainLayers } from "../../doiPropagation/fieldPreviewCore";
import type {
  ConvergedMotionFieldInput,
  ConvergedMotionTickParams,
} from "../core/systems/ConvergedMotionSystem";

export interface RendererAPI {
  /**
   * Heavy path: (re)build + upload geometry buffers when data references change.
   * Intended to be called on dataset/graph changes. `null` edges = point-only.
   */
  setData(nodes: DataPoint[], edges: SegmentColumns | null): void;

  /**
   * Boot columns-direct paint (issue #315 B1): upload node geometry straight
   * from the decoded binary sidecar BEFORE any DataPoint[] exists — positions,
   * per-column colors, and the uniform boot opacity, points only. Active until
   * the first non-empty setData replaces it wholesale. Optional: older
   * renderers/mocks without it degrade to the aggregate-only boot base.
   */
  setColumnData?(cols: SidecarPointColumns): void;

  /**
   * True once a non-empty setData/setDataWindow landed (issue #315 B3): the
   * boot paint uses this to tell a boot base instance (aggregate-first /
   * columns-first — paint INTO it) from a previous dataset's live data
   * renderer (replace it, or the new columns render under the old scales).
   */
  hasNodeData?(): boolean;

  /**
   * Streaming path: uses full dataset references but only renders the first
   * visibleNodeCount / visibleEdgeCount (segment count) items.
   */
  setDataWindow(
    nodes: DataPoint[],
    edges: SegmentColumns | null,
    visibleNodeCount: number,
    visibleEdgeCount: number
  ): void;

  /**
   * Applies visualization settings.
   * With the current renderer implementation, this should not trigger geometry rebuilds
   * if nodes/edges references are unchanged.
   */
  setVisualSettings(settings: RendererVisualSettings): void;

  /**
   * Back-compat alias for older call sites.
   * Prefer setVisualSettings.
   */
  setVisualSettingsFull(settings: RendererVisualSettings): void;

  /**
   * Style-only update (node radius / edge width / arrow scale).
   * Implemented via setVisualSettings without forcing geometry rebuilds when data refs are unchanged.
   */
  setStyle(style: StyleSettings): void;

  /**
   * Color mapping update (palette / encoding).
   * Implemented via setVisualSettings without forcing geometry rebuilds when data refs are unchanged.
   */
  setColorMapping(mapping: ColorMapping): void;

  /**
   * Canvas size update (CSS pixels). Does not recompute the transform matrix.
   * If the transform depends on canvas dimensions, call setTransform after resizing.
   */
  setSize(width: number, height: number, dpr?: number): void;

  /**
   * Interactive quality reduction (issue #315 §10.1): toggle a reduced-
   * resolution backing store for the duration of a gesture (proximity /
   * opacity-clamp drags) to cut fragment-fill cost on the 1M-point cloud.
   * Idempotent; turning it off repaints one full-quality frame.
   */
  setInteractiveQuality(on: boolean): void;

  /**
   * Transform update (typically uniform-only).
   */
  setTransform(matrix3: Float32Array | number[]): void;

  /**
   * Opacity knobs (uniform-only).
   */
  setOpacityParams(params: OpacityParams): void;
  setOpacityMix(mix: number): void;

  /**
   * Server-rendered tile base imagery (issue #315 phase E) — null clears.
   * Huge datasets then draw tiles instead of raw geometry at rest whenever
   * the view is within the pyramid.
   */
  setTileSource(source: ScatterTileSource | null): void;

  /**
   * Weighted-point aggregate LOD (issue #315 plan G, G3) — null clears.
   * At-rest frames on huge datasets then draw server aggregates instead of
   * the raw node pass (gated by `window.__lodAggregates` until parity).
   */
  setAggregateSource(source: AggregateTileSource | null): void;

  /**
   * Updates DOI/opacity field VBO + texture.
   */
  setOpacityField(values: Float32Array, mode?: OpacityFieldUpdateMode): void;

  /**
   * Updates the per-node emphasis field VBO + texture.
   * Emphasis ∈ [0,1] per node; nodes/edges with emphasis > 0 are rendered larger
   * (scaled by the current emphasisScale). Set to all-zeros to remove emphasis.
   */
  setEmphasisField(values: Float32Array, mode?: OpacityFieldUpdateMode): void;

  /**
   * Sets the emphasis scale multiplier: node radius / edge width multiplier at emphasis=1.
   * e.g. 0.75 → highlighted nodes grow by +75%. Default is 0 (no emphasis effect).
   */
  setEmphasisScale(scale: number): void;

  /**
   * GPU falloff preview (issue #315): uploads the geodesic distance field
   * (record order, +Infinity = unreachable) plus the FROZEN CHAIN a
   * proximity/falloff drag previews through — per point its best
   * trajectory-chain source, the decay gain to it, and the selection's
   * slider-independent chain contribution. The shader then evaluates
   * `max(seedChain, f(D), gain · f(srcDist))`, which is monotone in the slider,
   * so BOTH drag directions preview live; omitting `frozen` falls back to the
   * plain `v = f(D)`. Call once per freeze — see fieldPreviewCore's
   * `computeFrozenChain`.
   */
  setDistanceField(dist: Float32Array, frozen?: FrozenChainLayers | null): void;

  /**
   * GPU falloff preview: sets the per-tick falloff params (see
   * computeFalloffPreviewParams), or null to turn the preview off — the
   * default, byte-identical opacity-texture-only path.
   */
  setFalloffPreview(params: FalloffPreviewParams | null): void;

  /**
   * RELEASE CROSS-FADE weight in [0,1] (issue #315, CS 2026-07-26): 0 = the
   * preview the drag was showing, 1 = the committed opacity texture. The commit
   * path animates it 0→1 over ~150 ms and then calls `setFalloffPreview(null)`,
   * whose end state is the EXACT committed field (no lingering lerp). Optional:
   * an older renderer without it degrades to today's one-frame swap.
   */
  setFalloffPreviewBlend?(t: number): void;

  /**
   * GPU motion lane (plan-gpu-motion-lane.md): upload the per-field static
   * compute state for converged MOTION previews (null clears it). Returns
   * false when the lane is unavailable on this GL stack — the caller keeps
   * the worker preview lane. Optional: older renderers/mocks degrade cleanly.
   */
  setConvergedMotionField?(data: ConvergedMotionFieldInput | null): boolean;

  /**
   * GPU motion lane: one converged alternation tick computed on the GPU and
   * rendered into the opacity texture. Motion frames only — the exact CPU
   * flush (settle-commit / release) always supersedes it.
   */
  runConvergedMotionTick?(params: ConvergedMotionTickParams): boolean;

  /**
   * GPU motion lane: poll the tick-cost fence the last runConvergedMotionTick
   * left behind (adaptive raster res). Elapsed ms once the GPU signals it,
   * null while pending, undefined when no fence is outstanding. Non-blocking.
   */
  pollConvergedMotionTickMs?(): number | null | undefined;

  /**
   * Debug/bench readback of the last GPU motion tick's field (stalls the
   * pipeline — never on a production path).
   */
  readConvergedMotionField?(): Float32Array | null;

  /**
   * GPU motion lane truth blend (plan §5b): stage the worker's EXACT
   * converged field, then fade the opacity texture toward it frame by frame
   * with `blendConvergedMotionExact(t)` (t = 1 renders the exact field
   * verbatim). Optional like the rest of the lane.
   */
  uploadConvergedMotionExact?(values: Float32Array): boolean;
  blendConvergedMotionExact?(t: number): boolean;

  /**
   * Forces an immediate flush+draw of the current pending state.
   * Useful for explicit redraws (e.g., resize), but most setters already schedule frames.
   */
  render(): void;

  /**
   * Frees GPU resources owned by the renderer instance.
   */
  dispose(): void;

  /**
   * Escape hatch for debugging / incremental migration.
   */
  getRaw(): unknown;
}
