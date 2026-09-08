import * as d3 from "d3";
import type { ScaleLinear } from "d3-scale";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "../../dataPreprocessing/columnSidecar";
import { areRowsResident } from "../../dataPreprocessing/lazyRows";
import { columnsOf } from "../../dataPreprocessing/pointColumns";
import type { SegmentColumns } from "../../dataPreprocessing/splineColumns";
import type { OpacityFieldUpdateMode, RendererVisualSettings } from "../api/types";
import { FALLOFF_DIST_SENTINEL, type FalloffPreviewParams } from "../../doiPropagation/falloff";
import type { FrozenChainLayers } from "../../doiPropagation/fieldPreviewCore";
import type { AggregateTileSource, ScatterTileSource } from "../../scaling.types";
import { AggregateLayer } from "./aggregateLayer";
import { TileLayer } from "./tileLayer";
import { dataMatrix, multiplyMatrix, projectionMatrix, zoomMatrix } from "../math/matrices2d";
import { createProgram } from "../resources/ShaderProgram";
import { arrowFragmentShaderSource } from "../shaders/arrow.frag";
import { arrowVertexShaderSource } from "../shaders/arrow.vert";
import { arrowInstancedVertexShaderSource } from "../shaders/arrowInstanced.vert";
import { edgeFragmentShaderSource } from "../shaders/edge.frag";
import { edgeInstancedVertexShaderSource } from "../shaders/edgeInstanced.vert";
import { edgeQuadVertexShaderSource } from "../shaders/edgeQuad.vert";
import { nodeFragmentShaderSource } from "../shaders/node.frag";
import { nodeVertexShaderSource } from "../shaders/node.vert";
import { ColorSystem } from "./systems/ColorSystem";
import {
  ConvergedMotionSystem,
  type ConvergedMotionFieldInput,
  type ConvergedMotionTickParams,
} from "./systems/ConvergedMotionSystem";
import { colorScale, onColorScaleRebuild, resolveNumericColorRamp } from "../../utils/colorScale";
import { recordAllCounts } from "../../utils/colorDiscoveryStore";
import { encodeColorToVec3, getColorEncodingKey } from "../utils/colors";
import { GeometrySystem, meanEdgeChordDataLen, uniformSamplesPerEdge } from "./systems/GeometrySystem";
import { OpacityFieldSystem } from "./systems/OpacityFieldSystem";
import { computeDataTexDims, createDataTexture, FloatDataTexture } from "./textures";
import { createArrowsInstVAO, createArrowsVAO, createEdgesInstVAO, createEdgesQuadVAO, createNodesVAO } from "./vao";

/* ============================
   Renderer interface
   ============================ */

/**
 * State of the instanced edge path (issue #315 phase B2): geometry is
 * tessellated in edgeInstanced.vert from three data textures, so nothing
 * per-segment lives on the CPU or in vertex buffers. Active (instanceCount
 * > 0) only for uniformly tessellated SegmentColumns; the CPU quad path
 * remains as fallback.
 */
export interface EdgesInstState {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  programArrows: WebGLProgram;
  vaoArrows: WebGLVertexArrayObject;
  nodePosTex: WebGLTexture;
  nodeColorTex: WebGLTexture;
  edgeCtrlTex: WebGLTexture;
  texWidthNodes: number;
  texWidthEdges: number;
  samplesPerEdge: number;
  /** Visible segment count = drawArraysInstanced instance count. */
  instanceCount: number;
  /** Mean edge chord length in data units — drives auto tessellation. */
  avgEdgeDataLen: number;
  u: Record<string, WebGLUniformLocation | null>;
  uArrows: Record<string, WebGLUniformLocation | null>;
  /** GPU falloff-preview uniform set for the instanced-edge program (#315). */
  falloff: FalloffUniformLocs;
}

/**
 * GPU falloff-preview uniform locations for one program (issue #315). The node
 * pass, the edge-quad pass, and the instanced-edge pass each get a set; the
 * distance sampler is bound to a dedicated texture unit so it never collides
 * with the opacity/emphasis/edge-instance units.
 */
export interface FalloffUniformLocs {
  mode: WebGLUniformLocation | null;
  shape: WebGLUniformLocation | null;
  sScaled: WebGLUniformLocation | null;
  invMaxEmb: WebGLUniformLocation | null;
  /** Release cross-fade weight: 0 = preview, 1 = committed opacity field. */
  blend: WebGLUniformLocation | null;
  tex: WebGLUniformLocation | null;
  dim: WebGLUniformLocation | null;
}

/** Texture unit for the falloff distance field — above opacity(0), emphasis(1),
 * the edge-instance node/color/ctrl textures (2,3,4), below the snapshot(7). */
const FALLOFF_DIST_TEX_UNIT = 5;

function getFalloffUniformLocs(
  gl: WebGL2RenderingContext,
  program: WebGLProgram
): FalloffUniformLocs {
  return {
    mode: gl.getUniformLocation(program, "u_falloffMode"),
    shape: gl.getUniformLocation(program, "u_falloffShape"),
    sScaled: gl.getUniformLocation(program, "u_falloffSScaled"),
    invMaxEmb: gl.getUniformLocation(program, "u_falloffInvMaxEmb"),
    blend: gl.getUniformLocation(program, "u_falloffBlend"),
    tex: gl.getUniformLocation(program, "u_distFieldTex"),
    dim: gl.getUniformLocation(program, "u_distFieldTexDim"),
  };
}

export interface WebGLRenderer {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;

  nodesList: DataPoint[];

  programNodes: WebGLProgram;
  programEdges: WebGLProgram;
  programArrows: WebGLProgram;
  programEdgesQuad: WebGLProgram;

  nodeBuffer: WebGLBuffer;
  nodeColorBuffer: WebGLBuffer;
  nodeOpacityFieldBuffer: WebGLBuffer;
  nodeEmphasisFieldBuffer: WebGLBuffer;
  nodeCount: number;

  vaoNodes: WebGLVertexArrayObject;
  vaoEdgesQuad: WebGLVertexArrayObject;
  vaoArrows: WebGLVertexArrayObject;

  edgeBuffer: WebGLBuffer;
  edgeIndexBuffer: WebGLBuffer;
  edgeIndexCount: number;
  edgeIndexType: number;

  arrowBuffer: WebGLBuffer;
  arrowCount: number;

  edgesInst: EdgesInstState | null;

  /** Data-space bbox extents of the current nodes — density scaling input. */
  dataBboxW: number;
  dataBboxH: number;

  /** Dataset-scale stand-in for density-adaptive sizing while no raw
   * geometry is loaded (issue #315 G4 aggregate-first base): point count +
   * data bbox from the aggregate pyramid meta. Consulted only while
   * nodeCount / dataBbox are still empty — a real geometry upload wins. */
  densityHint: { count: number; bboxW: number; bboxH: number } | null;

  opacityFieldTex: WebGLTexture;
  opacityFieldTexW: number;
  opacityFieldTexH: number;

  emphasisFieldTex: WebGLTexture;
  emphasisFieldTexW: number;
  emphasisFieldTexH: number;
  emphasisScale: number;

  /** GPU falloff-preview distance field (issue #315): R32F, same record-index
   * W×H mapping as the opacity texture. Uploaded once per field revision. */
  distFieldTex: WebGLTexture;
  distFieldTexW: number;
  distFieldTexH: number;
  /** Active preview params, or null = off (byte-identical opacity-only path). */
  falloffPreview: FalloffPreviewParams | null;
  /** RELEASE CROSS-FADE weight (issue #315, CS 2026-07-26): 0 = the preview the
   * drag was showing, 1 = the committed opacity texture. Animated by the commit
   * path so a slider release fades instead of stepping; the fade's END state is
   * `falloffPreview = null` (the exact committed field), never a lerp of it. */
  falloffPreviewBlend: number;

  u_matrixNodes: WebGLUniformLocation | null;
  u_matrixEdges: WebGLUniformLocation | null;
  u_matrixArrows: WebGLUniformLocation | null;
  u_matrixEdgesQuad: WebGLUniformLocation | null;

  u_resolutionArrows: WebGLUniformLocation | null;
  u_resolutionEdgesQuad: WebGLUniformLocation | null;

  u_edgeWidth: WebGLUniformLocation | null;

  u_nodeRadiusPx: WebGLUniformLocation | null;
  u_nodeOutlineWidthPx: WebGLUniformLocation | null;
  u_nodeOutlineWhite: WebGLUniformLocation | null;
  u_emphasisScaleNodes: WebGLUniformLocation | null;
  u_arrowLengthPx: WebGLUniformLocation | null;

  u_opacityThresholdNodes: WebGLUniformLocation | null;
  u_minOpacityNodes: WebGLUniformLocation | null;
  u_maxOpacityNodes: WebGLUniformLocation | null;
  u_applyGrayBelowThresholdNodes: WebGLUniformLocation | null;

  u_opacityThresholdEdges: WebGLUniformLocation | null;
  u_minOpacityEdges: WebGLUniformLocation | null;
  u_maxOpacityEdges: WebGLUniformLocation | null;
  u_applyGrayBelowThresholdEdges: WebGLUniformLocation | null;
  u_opacityMixEdges: WebGLUniformLocation | null;
  u_opacityFieldTexEdges: WebGLUniformLocation | null;
  u_opacityFieldTexDimEdges: WebGLUniformLocation | null;
  u_emphasisScaleEdgesQuad: WebGLUniformLocation | null;
  u_emphasisFieldTexEdges: WebGLUniformLocation | null;
  u_emphasisFieldTexDimEdges: WebGLUniformLocation | null;

  u_opacityThresholdArrows: WebGLUniformLocation | null;
  u_minOpacityArrows: WebGLUniformLocation | null;
  u_maxOpacityArrows: WebGLUniformLocation | null;
  u_applyGrayBelowThresholdArrows: WebGLUniformLocation | null;
  u_opacityMixArrows: WebGLUniformLocation | null;
  u_opacityFieldTexArrows: WebGLUniformLocation | null;
  u_opacityFieldTexDimArrows: WebGLUniformLocation | null;

  // GPU falloff preview (issue #315): node + edge-quad program uniform sets
  // (the instanced-edge path carries its own set in EdgesInstState.u).
  falloffNodes: FalloffUniformLocs;
  falloffEdges: FalloffUniformLocs;

  // GPU motion lane (plan-gpu-motion-lane.md): while true the node pass reads
  // opacity from the TEXTURE (which a converged motion tick just wrote)
  // instead of the CPU-uploaded VBO attribute — the edges/arrows read that
  // texture already. Set by runConvergedMotionTick, cleared by every CPU
  // opacity upload (the exact flush always wins) and dataset swaps.
  gpuOpacityOverride: boolean;
  u_opacityFromTexNodes: WebGLUniformLocation | null;
  u_opacityFieldTexNodes: WebGLUniformLocation | null;
  u_opacityFieldTexDimNodes: WebGLUniformLocation | null;
  /** Lazy GPU motion-lane executor (null until the first setConvergedMotionField). */
  convergedMotion: ConvergedMotionSystem | null;

  transformMatrix: Float32Array;
  /** Timestamp of the last transform change (issue #315 gesture LOD): while
   * a gesture is in flight (recent transform updates) the >2M-segment draw
   * path renders coarser splines and skips arrows; a debounced restore
   * frame re-renders full quality at rest. */
  lastTransformChangeAt: number;
  edgeWidth: number;

  currentVisualSettings: RendererVisualSettings;
  opacityParams: { threshold: number; minAlpha: number; maxAlpha: number; forceApplyGray?: boolean };
  opacityMix: number;

  updateData(
    newNodes: DataPoint[],
    newEdges: SegmentColumns,
    visualSettings: RendererVisualSettings,
    visibleNodeCount?: number,
    visibleEdgeCount?: number
  ): void;
  /** Boot columns mode (issue #315 B1): paint node geometry straight from the
   * decoded binary sidecar while no DataPoint[] exists yet. Active only until
   * the first non-empty updateData replaces it. Optional so renderer mocks
   * predating it stay valid. */
  updateColumnData?(cols: SidecarPointColumns): void;
  updateTransform(matrix: number[]): void;
  /** Server-rendered tile base imagery (issue #315 phase E) — null clears. */
  setTileSource(source: ScatterTileSource | null): void;
  /** Weighted-point aggregate LOD (issue #315 plan G, G3) — null clears. */
  setAggregateSource(source: AggregateTileSource | null): void;

  setOpacityParams(params: { threshold: number; minAlpha: number; maxAlpha: number }): void;
  setOpacityField(values: Float32Array, mode?: OpacityFieldUpdateMode): void;
  setOpacityMix(mix: number): void;

  setEmphasisField(values: Float32Array, mode?: OpacityFieldUpdateMode): void;
  setEmphasisScale(scale: number): void;

  /** GPU falloff preview (issue #315): upload the geodesic distance field
   * (record order, +Infinity = unreachable) and, optionally, the frozen chain
   * layers the drag previews through (omitted ⇒ the plain v = f(D) preview).
   * Once per freeze — see fieldPreviewCore's computeFrozenChain. */
  setDistanceField(dist: Float32Array, frozen?: FrozenChainLayers | null): void;
  /** GPU falloff preview: set the per-tick falloff params, or null to turn the
   * preview off (the default, byte-identical opacity-texture-only path). */
  setFalloffPreview(params: FalloffPreviewParams | null): void;
  /** GPU motion lane: upload the per-field static compute state (null clears
   * it and drops the override). False = the lane is unavailable on this
   * stack (no float render targets / compile failure) — callers keep the
   * worker lane. */
  setConvergedMotionField(data: ConvergedMotionFieldInput | null): boolean;
  /** GPU motion lane: one converged tick rendered into the opacity texture
   * (motion frames only — the exact CPU flush supersedes at rest/release). */
  runConvergedMotionTick(params: ConvergedMotionTickParams): boolean;
  /** Poll the tick-cost fence (adaptive raster res): ms once signaled, null
   * while pending, undefined when none. Non-blocking. */
  pollConvergedMotionTickMs(): number | null | undefined;
  /** Debug/bench readback of the last GPU tick's field. Stalls the pipe —
   * never call on a production path. */
  readConvergedMotionField(): Float32Array | null;
  /** Truth blend (plan §5b): stage the worker's EXACT converged field. */
  uploadConvergedMotionExact(values: Float32Array): boolean;
  /** One truth-blend frame: opacity texture = mix(gpuField, exactField, t). */
  blendConvergedMotionExact(t: number): boolean;
  /** Release cross-fade weight in [0,1] (issue #315): 0 = the drag preview,
   * 1 = the committed opacity texture. Only meaningful while a preview is
   * active; `setFalloffPreview(null)` resets it to 0. */
  setFalloffPreviewBlend(t: number): void;

  setSize(width: number, height: number, dpr?: number): void;
  /**
   * Interactive quality reduction (issue #315 §10.1, the drag "inertia"): while
   * on, the drawing buffer is scaled down (INTERACTIVE_QUALITY_SCALE) and CSS
   * stretches it back to full size, cutting fragment-fill cost during a gesture
   * on the fill-bound 1M-point cloud. Turning it off restores the full backing
   * store and repaints one full-quality frame. Cheap: only the backing-store
   * size + one render change — no texture/VAO/program rebuilds. Idempotent.
   */
  setInteractiveQuality(on: boolean): void;
  stop(): void;

  drawScene(): void;
}

/* ============================
   Internal rendering passes
   ============================ */

function bindOpacityFieldTexture(renderer: WebGLRenderer): void {
  const gl = renderer.gl;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, renderer.opacityFieldTex);
}

/**
 * Push the GPU falloff-preview uniforms + bind the distance texture for one
 * program (issue #315). When `renderer.falloffPreview` is null the mode is 0,
 * so the shader ignores the distance field and the pass is byte-identical to
 * the opacity-texture-only path. The distance texture is always bound (to its
 * own unit) so the sampler references a complete R32F texture even when off.
 */
function applyFalloffUniforms(renderer: WebGLRenderer, locs: FalloffUniformLocs): void {
  const gl = renderer.gl;
  const p = renderer.falloffPreview;
  gl.uniform1i(locs.mode, p ? p.mode : 0);
  if (p) {
    gl.uniform1i(locs.shape, p.shapeCode);
    gl.uniform1f(locs.sScaled, p.sScaled);
    gl.uniform1f(locs.invMaxEmb, p.invMaxEmb);
    gl.uniform1f(locs.blend, renderer.falloffPreviewBlend);
  }
  gl.activeTexture(gl.TEXTURE0 + FALLOFF_DIST_TEX_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, renderer.distFieldTex);
  gl.uniform1i(locs.tex, FALLOFF_DIST_TEX_UNIT);
  gl.uniform2f(locs.dim, renderer.distFieldTexW, renderer.distFieldTexH);
  gl.activeTexture(gl.TEXTURE0);
}

function bindEmphasisFieldTexture(renderer: WebGLRenderer): void {
  const gl = renderer.gl;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, renderer.emphasisFieldTex);
}

/**
 * Gesture LOD window (issue #315): a draw within this many ms of the last
 * transform change counts as mid-gesture — the >2M-segment path then renders
 * coarser splines and skips arrows, and a debounced restore frame re-renders
 * full quality at rest (map-style). Exactness at rest is untouched, and
 * paper-scale datasets (≤2M segments) never engage it.
 */
const GESTURE_LOD_HOLD_MS = 200;

function isGestureLod(renderer: WebGLRenderer): boolean {
  const inst = renderer.edgesInst;
  if (!inst || inst.instanceCount <= 2_000_000) return false;
  return performance.now() - renderer.lastTransformChangeAt < GESTURE_LOD_HOLD_MS;
}

// ── 3×3 column-major matrix helpers (gesture snapshot compositor) ───────────

/** result = a × b, column-major (matches gl.uniformMatrix3fv layout). */
function multiply3x3(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        a[row] * b[col * 3] + a[3 + row] * b[col * 3 + 1] + a[6 + row] * b[col * 3 + 2];
    }
  }
  return out;
}

/** General 3×3 inverse (column-major), or null when singular. */
function invert3x3(m: Float32Array): Float32Array | null {
  const a00 = m[0], a01 = m[3], a02 = m[6];
  const a10 = m[1], a11 = m[4], a12 = m[7];
  const a20 = m[2], a21 = m[5], a22 = m[8];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a12 * a20 - a10 * a22;
  const c02 = a10 * a21 - a11 * a20;
  const det = a00 * c00 + a01 * c01 + a02 * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const out = new Float32Array(9);
  out[0] = c00 * inv;
  out[3] = (a02 * a21 - a01 * a22) * inv;
  out[6] = (a01 * a12 - a02 * a11) * inv;
  out[1] = c01 * inv;
  out[4] = (a00 * a22 - a02 * a20) * inv;
  out[7] = (a02 * a10 - a00 * a12) * inv;
  out[2] = c02 * inv;
  out[5] = (a01 * a20 - a00 * a21) * inv;
  out[8] = (a00 * a11 - a01 * a10) * inv;
  return out;
}

/**
 * Live tessellation override (issue #315 B2 step 4, dev knob until phase C
 * drives it adaptively): u_samplesPerEdge is a per-frame uniform, so changing
 * `window.__edgeTessellation` re-tessellates every edge with ZERO CPU
 * rebuild — the control-index texture is tessellation-independent.
 */
function liveSamplesPerEdge(dataSamples: number): number {
  const v = typeof window !== "undefined"
    ? (window as unknown as { __edgeTessellation?: unknown }).__edgeTessellation
    : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return dataSamples;
  return Math.max(1, Math.min(64, Math.round(v)));
}

function drawEdgesInstancedPass(renderer: WebGLRenderer, canvasWidth: number, canvasHeight: number, marks: MarkSizesPx): void {
  const inst = renderer.edgesInst!;
  const gl = renderer.gl;
  const applyGrayBelowThreshold = renderer.opacityParams.forceApplyGray === true || renderer.currentVisualSettings.colorEncoding !== "DoI";

  gl.useProgram(inst.program);
  gl.uniformMatrix3fv(inst.u.u_matrix, false, renderer.transformMatrix);
  gl.uniform2f(inst.u.u_resolution, canvasWidth, canvasHeight);
  gl.uniform1f(inst.u.u_edgeWidth, marks.edgeWidthPx);

  gl.uniform1f(inst.u.u_opacityThreshold, renderer.opacityParams.threshold);
  gl.uniform1f(inst.u.u_minOpacity, renderer.opacityParams.minAlpha);
  gl.uniform1f(inst.u.u_maxOpacity, renderer.opacityParams.maxAlpha);
  gl.uniform1i(inst.u.u_applyGrayBelowThreshold, applyGrayBelowThreshold ? 1 : 0);
  gl.uniform1f(inst.u.u_opacityMix, renderer.opacityMix);

  gl.uniform1i(inst.u.u_opacityFieldTex, 0);
  gl.uniform2f(inst.u.u_opacityFieldTexDim, renderer.opacityFieldTexW, renderer.opacityFieldTexH);

  gl.uniform1i(inst.u.u_emphasisFieldTex, 1);
  gl.uniform2f(inst.u.u_emphasisFieldTexDim, renderer.emphasisFieldTexW, renderer.emphasisFieldTexH);
  gl.uniform1f(inst.u.u_emphasisScale, renderer.emphasisScale);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, inst.nodePosTex);
  gl.uniform1i(inst.u.u_nodePosTex, 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, inst.nodeColorTex);
  gl.uniform1i(inst.u.u_nodeColorTex, 3);
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, inst.edgeCtrlTex);
  gl.uniform1i(inst.u.u_edgeCtrlTex, 4);
  gl.activeTexture(gl.TEXTURE0);

  gl.uniform1i(inst.u.u_texWidthNodes, inst.texWidthNodes);
  gl.uniform1i(inst.u.u_texWidthEdges, inst.texWidthEdges);

  applyFalloffUniforms(renderer, inst.falloff);

  // instanceCount is tracked in DATA segments (samplesPerEdge from the
  // columns); rescale the instance count when the live tessellation differs.
  // Auto zoom-adaptive tessellation (issue #315 C2, per CS's 1M finding —
  // "laggy with the entire dataset in view"): segments scale with the mean
  // edge's ON-SCREEN length (~1 segment per 7 px of curve), so overview
  // draws ~1 segment per edge instead of 20 (78M → ~4M vertices) and
  // zoomed-in curves stay smooth. window.__edgeTessellation still overrides.
  // Only engages past 2M segments: small (paper-scale) datasets keep full
  // curve fidelity unconditionally.
  const dataS = inst.samplesPerEdge;
  let liveS = liveSamplesPerEdge(dataS);
  if (liveS === dataS && inst.avgEdgeDataLen > 0 && inst.instanceCount > 2_000_000) {
    const pxPerUnit = (Math.abs(renderer.transformMatrix[0]) * canvasWidth) / 2;
    const avgEdgePx = inst.avgEdgeDataLen * pxPerUnit;
    // Gesture LOD (issue #315): mid-gesture frames target 1 segment per
    // ~21 px of curve instead of ~7 — a third of the instances while the
    // view is moving; the debounced restore frame brings fidelity back.
    const pxPerSegment = isGestureLod(renderer) ? 21 : 7;
    liveS = Math.max(1, Math.min(dataS, Math.ceil(avgEdgePx / pxPerSegment)));
  }
  gl.uniform1i(inst.u.u_samplesPerEdge, liveS);
  const fullEdges = Math.floor(inst.instanceCount / dataS);
  const remainder = inst.instanceCount - fullEdges * dataS;
  const instances = fullEdges * liveS + Math.floor((remainder * liveS) / dataS);

  gl.bindVertexArray(inst.vao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);
}

function drawEdgesPass(renderer: WebGLRenderer, canvasWidth: number, canvasHeight: number, marks: MarkSizesPx): void {
  if (renderer.edgesInst && renderer.edgesInst.instanceCount > 0) {
    drawEdgesInstancedPass(renderer, canvasWidth, canvasHeight, marks);
    return;
  }

  const gl = renderer.gl;
  const applyGrayBelowThreshold = renderer.opacityParams.forceApplyGray === true || renderer.currentVisualSettings.colorEncoding !== "DoI";

  gl.useProgram(renderer.programEdgesQuad);
  gl.uniformMatrix3fv(renderer.u_matrixEdgesQuad, false, renderer.transformMatrix);
  gl.uniform2f(renderer.u_resolutionEdgesQuad, canvasWidth, canvasHeight);
  gl.uniform1f(renderer.u_edgeWidth!, marks.edgeWidthPx);

  gl.uniform1f(renderer.u_opacityThresholdEdges, renderer.opacityParams.threshold);
  gl.uniform1f(renderer.u_minOpacityEdges, renderer.opacityParams.minAlpha);
  gl.uniform1f(renderer.u_maxOpacityEdges, renderer.opacityParams.maxAlpha);
  gl.uniform1i(renderer.u_applyGrayBelowThresholdEdges, applyGrayBelowThreshold ? 1 : 0);
  gl.uniform1f(renderer.u_opacityMixEdges, renderer.opacityMix);

  gl.uniform1i(renderer.u_opacityFieldTexEdges, 0);
  gl.uniform2f(renderer.u_opacityFieldTexDimEdges, renderer.opacityFieldTexW, renderer.opacityFieldTexH);

  gl.uniform1i(renderer.u_emphasisFieldTexEdges, 1);
  gl.uniform2f(renderer.u_emphasisFieldTexDimEdges, renderer.emphasisFieldTexW, renderer.emphasisFieldTexH);
  gl.uniform1f(renderer.u_emphasisScaleEdgesQuad, renderer.emphasisScale);

  applyFalloffUniforms(renderer, renderer.falloffEdges);

  gl.bindVertexArray(renderer.vaoEdgesQuad);
  gl.drawElements(gl.TRIANGLES, renderer.edgeIndexCount, renderer.edgeIndexType, 0);
}

function drawArrowsInstancedPass(renderer: WebGLRenderer, canvasWidth: number, canvasHeight: number, marks: MarkSizesPx): void {
  const inst = renderer.edgesInst!;
  // One arrow per fully visible edge (its last segment must be visible),
  // mirroring the CPU path's per-segment prefix clamp.
  const arrowInstances = Math.floor(inst.instanceCount / inst.samplesPerEdge);
  if (arrowInstances <= 0) return;

  const gl = renderer.gl;
  const applyGrayBelowThreshold = renderer.opacityParams.forceApplyGray === true || renderer.currentVisualSettings.colorEncoding !== "DoI";

  gl.useProgram(inst.programArrows);
  gl.uniformMatrix3fv(inst.uArrows.u_matrix, false, renderer.transformMatrix);
  gl.uniform2f(inst.uArrows.u_resolution, canvasWidth, canvasHeight);
  // Same density scale as the points — arrows dominate fill at overview too.
  gl.uniform1f(inst.uArrows.u_arrowLengthPx, marks.arrowLengthPx);

  gl.uniform1f(inst.uArrows.u_opacityThreshold, renderer.opacityParams.threshold);
  gl.uniform1f(inst.uArrows.u_minOpacity, renderer.opacityParams.minAlpha);
  gl.uniform1f(inst.uArrows.u_maxOpacity, renderer.opacityParams.maxAlpha);
  gl.uniform1i(inst.uArrows.u_applyGrayBelowThreshold, applyGrayBelowThreshold ? 1 : 0);
  gl.uniform1f(inst.uArrows.u_opacityMix, renderer.opacityMix);

  gl.uniform1i(inst.uArrows.u_opacityFieldTex, 0);
  gl.uniform2f(inst.uArrows.u_opacityFieldTexDim, renderer.opacityFieldTexW, renderer.opacityFieldTexH);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, inst.nodePosTex);
  gl.uniform1i(inst.uArrows.u_nodePosTex, 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, inst.nodeColorTex);
  gl.uniform1i(inst.uArrows.u_nodeColorTex, 3);
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, inst.edgeCtrlTex);
  gl.uniform1i(inst.uArrows.u_edgeCtrlTex, 4);
  gl.activeTexture(gl.TEXTURE0);

  gl.uniform1i(inst.uArrows.u_texWidthNodes, inst.texWidthNodes);
  gl.uniform1i(inst.uArrows.u_texWidthEdges, inst.texWidthEdges);
  // Arrow COUNT stays data-tessellation-based (one per fully visible edge);
  // the live value only steers the rotation chord so the head matches the
  // drawn last segment.
  gl.uniform1i(inst.uArrows.u_samplesPerEdge, liveSamplesPerEdge(inst.samplesPerEdge));

  gl.bindVertexArray(inst.vaoArrows);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, arrowInstances);
}

function drawArrowsPass(renderer: WebGLRenderer, canvasWidth: number, canvasHeight: number, marks: MarkSizesPx): void {
  if (renderer.edgesInst && renderer.edgesInst.instanceCount > 0) {
    // Gesture LOD (issue #315): arrows are one instance per edge (~1M at
    // synth1m) of pure decoration while the view is moving — skip them
    // mid-gesture; the restore frame draws them back at rest.
    if (isGestureLod(renderer)) return;
    drawArrowsInstancedPass(renderer, canvasWidth, canvasHeight, marks);
    return;
  }

  if (renderer.arrowCount <= 0) return;

  const gl = renderer.gl;
  const applyGrayBelowThreshold = renderer.opacityParams.forceApplyGray === true || renderer.currentVisualSettings.colorEncoding !== "DoI";

  gl.useProgram(renderer.programArrows);
  gl.uniformMatrix3fv(renderer.u_matrixArrows, false, renderer.transformMatrix);
  gl.uniform2f(renderer.u_resolutionArrows, canvasWidth, canvasHeight);

  gl.uniform1f(renderer.u_opacityThresholdArrows, renderer.opacityParams.threshold);
  gl.uniform1f(renderer.u_minOpacityArrows, renderer.opacityParams.minAlpha);
  gl.uniform1f(renderer.u_maxOpacityArrows, renderer.opacityParams.maxAlpha);
  gl.uniform1i(renderer.u_applyGrayBelowThresholdArrows, applyGrayBelowThreshold ? 1 : 0);
  gl.uniform1f(renderer.u_opacityMixArrows, renderer.opacityMix);

  gl.uniform1i(renderer.u_opacityFieldTexArrows, 0);
  gl.uniform2f(renderer.u_opacityFieldTexDimArrows, renderer.opacityFieldTexW, renderer.opacityFieldTexH);

  // Same size input as the instanced arrow path (issue #315, CS 2026-07-26):
  // both consume computeMarkSizesPx, so the CPU fallback can no longer drift
  // from the instanced pass (it used to skip the density factor entirely).
  gl.uniform1f(renderer.u_arrowLengthPx, marks.arrowLengthPx);

  gl.bindVertexArray(renderer.vaoArrows);
  gl.drawArrays(gl.TRIANGLES, 0, renderer.arrowCount);
}

/**
 * Node radius the coverage budget below is expressed AT (issue #315, CS
 * 2026-07-26 regression a). Mirrors `initialVisualizationSettings.nodeRadius`
 * / the dataset presets' base size, restated here as a plain number because
 * `gl/` must not import the Redux store. See {@link densityPointScale} for
 * why the budget has to be relative to something.
 */
export const DENSITY_REFERENCE_NODE_RADIUS = 5;

/**
 * Density-adaptive point scale (issue #315 C2 slice 2, per CS's 1M finding —
 * still "laggy with the entire dataset in view" after edge decimation): at
 * overview, 1M constant-size sprites are FILL-bound. Bound the expected
 * screen coverage instead: density = points per on-screen pixel of the
 * dataset's projected bbox; the factor shrinks the radius toward a ~3×
 * coverage budget (never below ~1.25 px) and returns to 1 (the configured
 * size) as density falls while zooming in. Gated to >300k points —
 * paper-scale datasets render untouched.
 *
 * The budget is anchored at {@link DENSITY_REFERENCE_NODE_RADIUS} and the
 * user's deviation from it passes through (issue #315, CS 2026-07-26
 * regression a: "not even on commit do we see the correct updates to node
 * radius and arrow scale"). It used to be an ABSOLUTE pixel target, which
 * made `nodeRadius * dpr * densityPointScale` collapse algebraically to the
 * budget: the Node Radius slider was a no-op on every >300k dataset, and the
 * arrow length — which shares this factor — SHRANK as nodes grew. At the
 * reference radius the returned scale is unchanged, so the at-rest look of
 * the synth presets (nodeRadius 5) is byte-identical to before.
 */
export function densityPointScale(
  renderer: WebGLRenderer,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number
): number {
  // Before any raw geometry lands (aggregate-first base, issue #315 G4) the
  // node fields are empty — fall back to the aggregate meta's dataset scale
  // so 1M-point bases get the same thin splats the loaded dataset will.
  const hint = renderer.densityHint;
  const count = renderer.nodeCount > 0 ? renderer.nodeCount : hint?.count ?? 0;
  const bboxW = renderer.dataBboxW > 0 ? renderer.dataBboxW : hint?.bboxW ?? 0;
  const bboxH = renderer.dataBboxH > 0 ? renderer.dataBboxH : hint?.bboxH ?? 0;
  if (count <= 300_000 || bboxW <= 0 || bboxH <= 0) return 1;
  const pxPerUnitX = (Math.abs(renderer.transformMatrix[0]) * canvasWidth) / 2;
  const pxPerUnitY = (Math.abs(renderer.transformMatrix[4]) * canvasHeight) / 2;
  const bboxAreaPx = bboxW * pxPerUnitX * bboxH * pxPerUnitY;
  if (!(bboxAreaPx > 0)) return 1;
  const density = count / bboxAreaPx;
  const floorPx = 1.25 * dpr;
  const rConfig = Math.max(renderer.currentVisualSettings.nodeRadius * dpr, 0.5);
  // Coverage budget AT the reference radius, then scaled by how far the user
  // moved the slider from it — so the cap bounds fill without taking the
  // slider's authority away (see the doc comment).
  const budgetPx = Math.max(floorPx, Math.sqrt(3 / (Math.PI * density)));
  const capPx = budgetPx * (rConfig / Math.max(DENSITY_REFERENCE_NODE_RADIUS * dpr, 0.5));
  const rEff = Math.min(rConfig, Math.max(floorPx, capPx));
  return rEff / rConfig;
}

/**
 * Device-pixel sizes of every mark for ONE frame — the single place the visual
 * appearance settings (`setStyle`), the effective dpr and the density cap
 * combine (issue #315, CS 2026-07-26). Every draw path consumes this, so a
 * committed style change cannot reach one pass and miss another, and the sizes
 * are provably invariant under interactive-quality scaling: `dpr` must be the
 * EFFECTIVE dpr (see {@link effectiveDpr}), i.e. derived from the real backing
 * store, and every term here is linear in it.
 *
 * Pure and exported for the jsdom regression tests (a WebGL context cannot
 * exist there, so the uniform values are pinned at this seam instead).
 */
export interface MarkSizesPx {
  /** gl_PointSize for the node pass AND the aggregate splat pass. */
  nodeRadiusPx: number;
  nodeOutlineWidthPx: number;
  edgeWidthPx: number;
  arrowLengthPx: number;
  /** The density cap factor that produced these (1 = unscaled). */
  densityScale: number;
}

export function computeMarkSizesPx(
  renderer: WebGLRenderer,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number
): MarkSizesPx {
  const s = renderer.currentVisualSettings;
  const densityScale = densityPointScale(renderer, canvasWidth, canvasHeight, dpr);
  return {
    nodeRadiusPx: s.nodeRadius * dpr * densityScale,
    nodeOutlineWidthPx: s.nodeOutlineWidth * dpr * densityScale,
    // Edge width is NOT density-capped: edges are 1 quad per segment, and the
    // segment count is already zoom-adaptive (drawEdgesInstancedPass).
    edgeWidthPx: s.edgeWidth * dpr,
    arrowLengthPx: s.arrowScale * dpr * densityScale,
    densityScale,
  };
}

/**
 * Backing-store scale applied while a gesture is in flight (issue #315 §10.1).
 * The CSS box stays full size, so the smaller drawing buffer is stretched back
 * up: half resolution is ~a quarter of the fragments, which is where the drag
 * "inertia" on the fill-bound 1M cloud comes from. Restored to 1.0 the instant
 * the gesture commits.
 * 1/2 (was 2/3): the RGBA16F scene target doubles color-buffer bandwidth, so
 * 2/3 during drags lands back at the pre-16F fill cost on the iGPU — 1/2 puts
 * gesture frames clearly below it. CS judges the blur trade.
 */
export const INTERACTIVE_QUALITY_SCALE = 1 / 2;

/**
 * Backing-store extent in device px for a CSS extent (issue #315 §10.1).
 * `qualityScale` is 1 at rest and {@link INTERACTIVE_QUALITY_SCALE} while a
 * gesture holds the interactive-quality reduction.
 */
export function backingStorePx(cssPx: number, dpr: number, qualityScale: number): number {
  return Math.max(1, Math.round(cssPx * dpr * qualityScale));
}

/**
 * The dpr every draw pass must size marks with: the ACTUAL backing-store scale
 * (device px per CSS px), NOT `window.devicePixelRatio`.
 *
 * Issue #315, CS 2026-07-26 regression c ("during the max/min opacity slider
 * drag, nodes and edge width temporarily jump until commit"): the interactive
 * quality reduction shrinks ONLY canvas.width/height while CSS stretches the
 * buffer back to full size. Sizing marks with window.devicePixelRatio then
 * makes every mark 1/INTERACTIVE_QUALITY_SCALE times too large relative to the
 * buffer — and the CSS upscale multiplies the error again, so apparent sizes
 * doubled for the duration of the gesture. Derived from the real backing store,
 * apparent (CSS-px) sizes are invariant under the quality scale.
 */
export function effectiveDpr(backingPx: number, cssPx: number, fallbackDpr: number): number {
  if (!(backingPx > 0) || !(cssPx > 0)) return fallbackDpr;
  return backingPx / cssPx;
}

function drawNodesPass(renderer: WebGLRenderer, marks: MarkSizesPx): void {
  const gl = renderer.gl;
  const applyGrayBelowThreshold = renderer.opacityParams.forceApplyGray === true || renderer.currentVisualSettings.colorEncoding !== "DoI";

  gl.useProgram(renderer.programNodes);
  gl.uniformMatrix3fv(renderer.u_matrixNodes, false, renderer.transformMatrix);

  gl.uniform1f(renderer.u_opacityThresholdNodes, renderer.opacityParams.threshold);
  gl.uniform1f(renderer.u_minOpacityNodes, renderer.opacityParams.minAlpha);
  gl.uniform1f(renderer.u_maxOpacityNodes, renderer.opacityParams.maxAlpha);
  gl.uniform1i(renderer.u_applyGrayBelowThresholdNodes, applyGrayBelowThreshold ? 1 : 0);

  gl.uniform1f(renderer.u_nodeRadiusPx, marks.nodeRadiusPx);
  gl.uniform1f(renderer.u_nodeOutlineWidthPx, marks.nodeOutlineWidthPx);
  gl.uniform1i(renderer.u_nodeOutlineWhite, renderer.currentVisualSettings.nodeOutlineWhite ? 1 : 0);
  gl.uniform1f(renderer.u_emphasisScaleNodes, renderer.emphasisScale);

  // GPU motion lane: read opacity from the texture (bound scene-wide on
  // TEXTURE0) while a converged motion tick owns it; 0 = the attribute path,
  // byte-identical to before.
  gl.uniform1i(renderer.u_opacityFromTexNodes, renderer.gpuOpacityOverride ? 1 : 0);
  gl.uniform1i(renderer.u_opacityFieldTexNodes, 0);
  gl.uniform2f(
    renderer.u_opacityFieldTexDimNodes,
    renderer.opacityFieldTexW,
    renderer.opacityFieldTexH
  );

  applyFalloffUniforms(renderer, renderer.falloffNodes);

  gl.bindVertexArray(renderer.vaoNodes);
  gl.drawArrays(gl.POINTS, 0, renderer.nodeCount);
}

/* ============================
   Helpers
   ============================ */

function palettesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ============================
   Initialization
   ============================ */

export function initWebGLRenderer(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  xScale: ScaleLinear<number, number>,
  yScale: ScaleLinear<number, number>,
  nodes: DataPoint[],
  segments: SegmentColumns,
  initialVisualSettings: RendererVisualSettings
): WebGLRenderer {
  const initialDpr = window.devicePixelRatio || 1;
  canvas.width = width * initialDpr;
  canvas.height = height * initialDpr;
  function hexToRgb01(hex: string): [number, number, number] {
    const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
    const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
    if (!match) return [1, 1, 1];
    return [
      parseInt(match[1], 16) / 255,
      parseInt(match[2], 16) / 255,
      parseInt(match[3], 16) / 255,
    ];
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.backgroundColor = initialVisualSettings.canvasBgColor ?? "#ffffff";

  // powerPreference: on dual-GPU machines the browser's default adapter
  // choice can land all WebGL on the weak iGPU; ask for the fast one. A HINT
  // only — measured 2026-08-21 (deployed slider lag): Chrome on the demo
  // machine's AMD+NVIDIA stack ignores it and stays on the Radeon iGPU,
  // which is what the GPU motion lane's adaptive raster res covers.
  const gl = canvas.getContext("webgl2", {
    antialias: true,
    powerPreference: "high-performance",
  })!;

  // ── HDR scene target (issue #315 §11-C escalation) ──────────────────────────
  // All blended scene passes composite into an RGBA16F offscreen target and a
  // present pass quantizes to the RGBA8 backbuffer exactly ONCE per frame.
  // Per-draw 8-bit store rounding was the root of the emerald→cyan cast (the
  // smallest channel's blend increment rounds to zero every draw over heavy
  // overdraw), the discrete falloff "ring", and the knife-edge visibility
  // cliff near one alpha quantum — half-float accumulation removes all three.
  // EXT_color_buffer_float makes RGBA16F color-renderable (universally
  // available under ANGLE/D3D11 & Metal); without it we render directly to
  // the backbuffer as before.
  let hdrSupported = gl.getExtension("EXT_color_buffer_float") !== null;

  const geometrySystem = new GeometrySystem();
  const colorSystem = new ColorSystem(initialVisualSettings.colorPalette, {
    hidden: initialVisualSettings.grayOutDoiThreshold,
    labeled: initialVisualSettings.annotationDoiThreshold,
    inset: initialVisualSettings.insetDoiThreshold,
  }, colorScale, resolveNumericColorRamp);
  const opacityFieldSystem = new OpacityFieldSystem();

  const programNodes = createProgram(gl, nodeVertexShaderSource, nodeFragmentShaderSource, "nodes");
  const programEdgesQuad = createProgram(gl, edgeQuadVertexShaderSource, edgeFragmentShaderSource, "edgesQuad");
  const programEdges = programEdgesQuad;
  const programArrows = createProgram(gl, arrowVertexShaderSource, arrowFragmentShaderSource, "arrows");

  // ── Gesture snapshot compositor (issue #315 — the tile-client's client
  // half). While a gesture is in flight on a >2M-segment dataset, the scene
  // is NOT re-drawn from geometry: the last settled full-quality frame is
  // cached in a texture and re-drawn as ONE transformed fullscreen triangle
  // — exactly how a map client composites its tiles between fetches, and
  // why pan/zoom stays at refresh rate regardless of dataset size. Content
  // changes landing mid-gesture (cluster recolors, DoI fields) appear at
  // the gesture-end restore frame, which re-draws real geometry and
  // re-captures. Server-rendered tiles (phase E) later replace the capture
  // as the imagery source; the compositing path stays the same.
  //
  // Shader I/O: a_pos (location 0) = clip-space fullscreen triangle;
  // u_delta = M_snapshot × M_current⁻¹ (maps current clip coords back into
  // snapshot clip coords); u_snap = the cached frame on TEXTURE7.
  const snapshotVertexShaderSource = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_clip;
void main() { v_clip = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
  const snapshotFragmentShaderSource = `#version 300 es
precision highp float;
uniform mat3 u_delta;
uniform sampler2D u_snap;
in vec2 v_clip;
out vec4 outColor;
void main() {
  vec3 c0 = u_delta * vec3(v_clip, 1.0);
  vec2 uv = (c0.xy + 1.0) * 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  outColor = texture(u_snap, uv);
}`;
  const programSnapshot = createProgram(gl, snapshotVertexShaderSource, snapshotFragmentShaderSource, "snapshot");
  const u_snapshotDelta = gl.getUniformLocation(programSnapshot, "u_delta");
  const u_snapshotTex = gl.getUniformLocation(programSnapshot, "u_snap");
  const snapshotQuadBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, snapshotQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vaoSnapshot = gl.createVertexArray()!;
  gl.bindVertexArray(vaoSnapshot);
  gl.bindBuffer(gl.ARRAY_BUFFER, snapshotQuadBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const snapshotTex = gl.createTexture()!;
  let snapshotValid = false;
  let snapshotMatrix: Float32Array | null = null;
  let snapshotW = 0;
  let snapshotH = 0;

  // ── Present pass (HDR composite, issue #315 §11-C) ──────────────────────────
  // Shader I/O: a_pos (location 0) = the same clip-space fullscreen triangle
  // as the snapshot compositor (vaoSnapshot is reused); u_scene = the resolved
  // RGBA16F scene texture on TEXTURE5. Writes vec4(rgb, 1) with BLEND disabled
  // — the frame's single 8-bit quantization, and an always-opaque backbuffer.
  const presentFragmentShaderSource = `#version 300 es
precision highp float;
uniform sampler2D u_scene;
in vec2 v_clip;
out vec4 outColor;
void main() {
  vec2 uv = (v_clip + 1.0) * 0.5;
  outColor = vec4(texture(u_scene, uv).rgb, 1.0);
}`;
  const programPresent = createProgram(gl, snapshotVertexShaderSource, presentFragmentShaderSource, "present");
  const u_presentTex = gl.getUniformLocation(programPresent, "u_scene");

  // HDR scene target: a multisampled RGBA16F renderbuffer (so the offscreen
  // path keeps the MSAA the antialias:true backbuffer provided — edge/arrow
  // quads have no shader AA), resolved via blit into an RGBA16F texture the
  // present pass samples. Reallocated lazily on drawing-buffer size changes
  // (setSize, interactive-quality toggles). sceneSamples 0 ⇒ render into the
  // resolve FBO directly (no MSAA offered for RGBA16F on this driver).
  let sceneMsaaFbo: WebGLFramebuffer | null = null;
  let sceneMsaaRbo: WebGLRenderbuffer | null = null;
  let sceneResolveFbo: WebGLFramebuffer | null = null;
  let sceneTex: WebGLTexture | null = null;
  let sceneW = 0;
  let sceneH = 0;
  const sceneSampleCounts = hdrSupported
    ? (gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null)
    : null;
  const sceneSamples =
    sceneSampleCounts && sceneSampleCounts.length > 0 ? Math.min(4, sceneSampleCounts[0]) : 0;

  /** (Re)allocate the HDR scene target at the current drawing-buffer size.
   * Returns false when unsupported (direct-to-backbuffer RGBA8 fallback);
   * an incomplete framebuffer disables the HDR path for the session. */
  function ensureSceneTarget(w: number, h: number): boolean {
    if (!hdrSupported) return false;
    if (sceneW === w && sceneH === h && sceneResolveFbo !== null) return true;

    if (sceneTex === null) sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (sceneResolveFbo === null) sceneResolveFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneResolveFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
    if (sceneSamples > 0) {
      if (sceneMsaaRbo === null) sceneMsaaRbo = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, sceneMsaaRbo);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, sceneSamples, gl.RGBA16F, w, h);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      if (sceneMsaaFbo === null) sceneMsaaFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneMsaaFbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, sceneMsaaRbo);
    }
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      hdrSupported = false;
      return false;
    }
    sceneW = w;
    sceneH = h;
    return true;
  }

  // Server-rendered tile base imagery (issue #315 phase E): when a source is
  // set and the view is within the pyramid, at-rest frames draw tiles
  // instead of raw geometry on huge datasets — `invalidate` is hoisted, so
  // fetched tiles re-render as they land.
  const tileLayer = new TileLayer(gl, invalidate);

  // Weighted-point aggregate LOD (issue #315 plan G, G3): the at-rest node
  // pass on huge datasets, gated by `window.__lodAggregates` until the
  // parity bench passes. Class colors go through the SAME global colorScale
  // as raw points (contract #4); the server's degenerate single-class
  // marker "" (derive_point_classes: missing/uniform color column) maps to
  // the raw path's own no-key fallback (ColorSystem's "#1b9e77"), NOT
  // through the scale — raw points with a missing key never consult it.
  const aggregateLayer = new AggregateLayer(gl, invalidate, (key) =>
    encodeColorToVec3(key === "" ? "#1b9e77" : colorScale(key))
  );

  // Color-scale rebuilds (issue #315 dataset-switch recolor): stats landing
  // for the current encoding re-sorts the category → palette-slot mapping,
  // which no settings diff sees — without this, GPU colors keep the previous
  // dataset's mapping while the legend shows the new one.
  const offColorScaleRebuild = onColorScaleRebuild(() => {
    dirty.colors = true;
    invalidate();
  });

  const nodeBuffer = gl.createBuffer()!;
  const nodeColorBuffer = gl.createBuffer()!;
  const nodeOpacityFieldBuffer = gl.createBuffer()!;
  const nodeEmphasisFieldBuffer = gl.createBuffer()!;
  const edgeBuffer = gl.createBuffer()!;
  const edgeIndexBuffer = gl.createBuffer()!;
  const arrowBuffer = gl.createBuffer()!;

  const vaoNodes = createNodesVAO(gl, programNodes, nodeBuffer, nodeColorBuffer, nodeOpacityFieldBuffer, nodeEmphasisFieldBuffer);
  const vaoEdgesQuad = createEdgesQuadVAO(gl, programEdgesQuad, edgeBuffer, edgeIndexBuffer);
  const vaoArrows = createArrowsVAO(gl, programArrows, arrowBuffer);

  // Instanced edge path (issue #315 phase B2). `window.__edgeCpuPath = true`
  // (set before renderer init) forces the CPU quad path — the A/B parity
  // harness escape hatch.
  const forceCpuEdges =
    typeof window !== "undefined" &&
    (window as unknown as { __edgeCpuPath?: unknown }).__edgeCpuPath === true;

  let edgesInst: EdgesInstState | null = null;
  const nodePosUploader = new FloatDataTexture(2);
  const nodeColorUploader = new FloatDataTexture(4);
  const edgeCtrlUploader = new FloatDataTexture(4);
  if (!forceCpuEdges) {
    const programEdgesInst = createProgram(gl, edgeInstancedVertexShaderSource, edgeFragmentShaderSource, "edgesInst");
    const cornerBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    // Static TRIANGLE_STRIP quad corners, matching the old expansion order.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const name of [
      "u_matrix", "u_resolution", "u_edgeWidth",
      "u_opacityThreshold", "u_minOpacity", "u_maxOpacity", "u_applyGrayBelowThreshold", "u_opacityMix",
      "u_opacityFieldTex", "u_opacityFieldTexDim",
      "u_emphasisFieldTex", "u_emphasisFieldTexDim", "u_emphasisScale",
      "u_nodePosTex", "u_nodeColorTex", "u_edgeCtrlTex",
      "u_texWidthNodes", "u_texWidthEdges", "u_samplesPerEdge",
    ]) {
      u[name] = gl.getUniformLocation(programEdgesInst, name);
    }

    const programArrowsInst = createProgram(gl, arrowInstancedVertexShaderSource, arrowFragmentShaderSource, "arrowsInst");
    const arrowOffsetBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, arrowOffsetBuffer);
    // Static arrow triangle in local units, matching buildArrowsGeometry.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, -0.5, 1, 0.5, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    const uArrows: Record<string, WebGLUniformLocation | null> = {};
    for (const name of [
      "u_matrix", "u_resolution", "u_arrowLengthPx",
      "u_opacityThreshold", "u_minOpacity", "u_maxOpacity", "u_applyGrayBelowThreshold", "u_opacityMix",
      "u_opacityFieldTex", "u_opacityFieldTexDim",
      "u_nodePosTex", "u_nodeColorTex", "u_edgeCtrlTex",
      "u_texWidthNodes", "u_texWidthEdges", "u_samplesPerEdge",
    ]) {
      uArrows[name] = gl.getUniformLocation(programArrowsInst, name);
    }

    edgesInst = {
      program: programEdgesInst,
      vao: createEdgesInstVAO(gl, programEdgesInst, cornerBuffer),
      programArrows: programArrowsInst,
      vaoArrows: createArrowsInstVAO(gl, programArrowsInst, arrowOffsetBuffer),
      nodePosTex: createDataTexture(gl),
      nodeColorTex: createDataTexture(gl),
      edgeCtrlTex: createDataTexture(gl),
      texWidthNodes: 1,
      texWidthEdges: 1,
      samplesPerEdge: 1,
      instanceCount: 0,
      avgEdgeDataLen: 0,
      u,
      uArrows,
      falloff: getFalloffUniformLocs(gl, programEdgesInst),
    };
  }

  const opacityFieldTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, opacityFieldTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Emphasis texture: same layout as opacity texture but stores per-node emphasis values.
  // Bound to TEXTURE1 (opacity uses TEXTURE0). Sampled in edgeQuad.vert to scale line width.
  const emphasisFieldTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, emphasisFieldTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // GPU falloff-preview frozen-chain field (issue #315): a second texture with
  // the opacity texture's record-index W×H layout, RGBA32F — (D, chain source
  // distance, chain gain, seed chain), the four numbers `previewDoi` needs (see
  // doiPropagation/fieldPreviewCore.ts computeFrozenChain). Seeded 1×1 with the
  // unreachable sentinel + unit gain so the samplers reference a complete
  // texture before any field is uploaded (falloffMode stays 0, so it is never
  // sampled then).
  const distFieldTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, distFieldTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT,
    new Float32Array([FALLOFF_DIST_SENTINEL, FALLOFF_DIST_SENTINEL, 1, 0]));
  gl.bindTexture(gl.TEXTURE_2D, null);

  // CSS dims, NOT canvas.width/height: the backing store was scaled by
  // devicePixelRatio above, while the scales' ranges are CSS px. Building
  // the initial projection from backing px drew everything at 1/dpr scale
  // until the first transform update rebuilt the matrix with CSS dims —
  // invisible at dpr 1, but the pre-data aggregate base sits on THIS
  // matrix, so on scaled displays the boot base rendered shrunken and
  // offset from where the data later landed (issue #315, CS 2026-07-23).
  const proj = projectionMatrix(width, height);
  const zoomMat = zoomMatrix(d3.zoomIdentity);
  const dataMat = dataMatrix(xScale, yScale);
  const transformMat = multiplyMatrix(proj, multiplyMatrix(zoomMat, dataMat));

  const u_matrixNodes = gl.getUniformLocation(programNodes, "u_matrix");
  const u_matrixEdgesQuad = gl.getUniformLocation(programEdgesQuad, "u_matrix");
  const u_resolutionEdgesQuad = gl.getUniformLocation(programEdgesQuad, "u_resolution");
  const u_edgeWidth = gl.getUniformLocation(programEdgesQuad, "u_edgeWidth");
  const u_matrixArrows = gl.getUniformLocation(programArrows, "u_matrix");
  const u_resolutionArrows = gl.getUniformLocation(programArrows, "u_resolution");
  const u_nodeRadiusPx = gl.getUniformLocation(programNodes, "u_nodeRadiusPx");
  const u_nodeOutlineWidthPx = gl.getUniformLocation(programNodes, "u_nodeOutlineWidthPx");
  const u_nodeOutlineWhite = gl.getUniformLocation(programNodes, "u_nodeOutlineWhite");
  const u_emphasisScaleNodes = gl.getUniformLocation(programNodes, "u_emphasisScale");
  const u_arrowLengthPx = gl.getUniformLocation(programArrows, "u_arrowLengthPx");

  const u_opacityThresholdNodes = gl.getUniformLocation(programNodes, "u_opacityThreshold");
  const u_minOpacityNodes = gl.getUniformLocation(programNodes, "u_minOpacity");
  const u_maxOpacityNodes = gl.getUniformLocation(programNodes, "u_maxOpacity");
  const u_applyGrayBelowThresholdNodes = gl.getUniformLocation(programNodes, "u_applyGrayBelowThreshold");

  const u_opacityThresholdEdges = gl.getUniformLocation(programEdgesQuad, "u_opacityThreshold");
  const u_minOpacityEdges = gl.getUniformLocation(programEdgesQuad, "u_minOpacity");
  const u_maxOpacityEdges = gl.getUniformLocation(programEdgesQuad, "u_maxOpacity");
  const u_applyGrayBelowThresholdEdges = gl.getUniformLocation(programEdgesQuad, "u_applyGrayBelowThreshold");
  const u_opacityMixEdges = gl.getUniformLocation(programEdgesQuad, "u_opacityMix");
  const u_opacityFieldTexEdges = gl.getUniformLocation(programEdgesQuad, "u_opacityFieldTex");
  const u_opacityFieldTexDimEdges = gl.getUniformLocation(programEdgesQuad, "u_opacityFieldTexDim");

  const u_emphasisScaleEdgesQuad = gl.getUniformLocation(programEdgesQuad, "u_emphasisScale");
  const u_emphasisFieldTexEdges = gl.getUniformLocation(programEdgesQuad, "u_emphasisFieldTex");
  const u_emphasisFieldTexDimEdges = gl.getUniformLocation(programEdgesQuad, "u_emphasisFieldTexDim");

  const u_opacityThresholdArrows = gl.getUniformLocation(programArrows, "u_opacityThreshold");
  const u_minOpacityArrows = gl.getUniformLocation(programArrows, "u_minOpacity");
  const u_maxOpacityArrows = gl.getUniformLocation(programArrows, "u_maxOpacity");
  const u_applyGrayBelowThresholdArrows = gl.getUniformLocation(programArrows, "u_applyGrayBelowThreshold");
  const u_opacityMixArrows = gl.getUniformLocation(programArrows, "u_opacityMix");
  const u_opacityFieldTexArrows = gl.getUniformLocation(programArrows, "u_opacityFieldTex");
  const u_opacityFieldTexDimArrows = gl.getUniformLocation(programArrows, "u_opacityFieldTexDim");

  const falloffNodes = getFalloffUniformLocs(gl, programNodes);
  // GPU motion lane (plan-gpu-motion-lane.md): node-pass opacity-texture
  // override — the texture the converged motion tick renders into.
  const u_opacityFromTexNodes = gl.getUniformLocation(programNodes, "u_opacityFromTex");
  const u_opacityFieldTexNodes = gl.getUniformLocation(programNodes, "u_opacityFieldTex");
  const u_opacityFieldTexDimNodes = gl.getUniformLocation(programNodes, "u_opacityFieldTexDim");
  const falloffEdges = getFalloffUniformLocs(gl, programEdgesQuad);

  type DirtyFlags = {
    nodesGeom: boolean;
    edgesGeom: boolean;
    colors: boolean;
    counts: boolean;
    opacityField: boolean;
    emphasisField: boolean;
    distanceField: boolean;
    uniforms: boolean;
  };

  const dirty: DirtyFlags = {
    nodesGeom: false,
    edgesGeom: false,
    colors: false,
    counts: false,
    opacityField: false,
    emphasisField: false,
    distanceField: false,
    uniforms: false,
  };

  let hasUploadedOnce = false;
  let loggedEdgePath = false;
  let opacityTexAllocated = false;
  let opacityVboAllocated = false;
  let emphasisTexAllocated = false;
  let emphasisVboAllocated = false;
  let distTexAllocated = false;
  // Interleaved, sanitized (Inf/NaN → sentinel) [D, srcDist, gain, seedChain]
  // copy of the last setDistanceField payload, awaiting upload in flush. Reused
  // across revisions when the length matches.
  let pendingDistanceField: Float32Array | null = null;
  let distSanitizeScratch: Float32Array | null = null;

  let latestNodes: DataPoint[] = nodes;
  let latestEdges: SegmentColumns = segments;
  let latestVisibleNodeCount = nodes.length;
  let latestVisibleEdgeCount = segments.segmentCount;

  // Boot columns mode (issue #315 B1): while the dataset's DataPoint[] does
  // not exist yet, node positions/colors/opacity are built straight from the
  // decoded sidecar columns. Cleared by the first non-empty node upload.
  let latestColumns: SidecarPointColumns | null = null;
  let pendingColumns: SidecarPointColumns | null = null;

  let pendingNodes: DataPoint[] | null = null;
  let pendingEdges: SegmentColumns | null = null;
  let pendingSettings: RendererVisualSettings | null = null;
  let pendingOpacityField: Float32Array | null = null;
  let pendingEmphasisField: Float32Array | null = null;
  let pendingVisibleNodeCount: number | null = null;
  let pendingVisibleEdgeCount: number | null = null;
  let pendingOpacityFieldMode: OpacityFieldUpdateMode = "full";

  // During drag preview with DoI color encoding, color buffer rebuild/upload
  // can dominate frame time on large datasets. Throttle preview color uploads
  // adaptively by dataset size while keeping opacity updates every frame.
  const PREVIEW_NODE_COLOR_UPLOAD_BASE_INTERVAL_MS = 40;
  const PREVIEW_EDGE_COLOR_UPLOAD_BASE_INTERVAL_MS = 80;
  let lastPreviewNodeColorUploadMs = 0;
  let lastPreviewEdgeColorUploadMs = 0;

  function getPreviewNodeColorUploadIntervalMs(nodeCount: number): number {
    if (nodeCount > 300000) return 220;
    if (nodeCount > 150000) return 100;
    if (nodeCount > 60000) return 70;
    return PREVIEW_NODE_COLOR_UPLOAD_BASE_INTERVAL_MS;
  }

  function getPreviewEdgeColorUploadIntervalMs(nodeCount: number): number {
    if (nodeCount > 300000) return 340;
    if (nodeCount > 150000) return 160;
    if (nodeCount > 60000) return 120;
    return PREVIEW_EDGE_COLOR_UPLOAD_BASE_INTERVAL_MS;
  }

  let opacityFieldOverride: Float32Array | null = null;
  let emphasisFieldOverride: Float32Array | null = null;

  let indexById: Map<number, number> | null = null;
  let indexedNodeCount = 0;

  let cpuEdgeVerts: Float32Array | null = null;
  let cpuEdgeIdx: Uint16Array | Uint32Array | null = null;
  let cpuArrowVerts: Float32Array | null = null;

  let rafHandle: number | null = null;
  let rendererRef: WebGLRenderer | null = null;
  let stopped = false;
  /** Gesture-LOD restore timer — see updateTransform. */
  let lodRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Interactive quality reduction (issue #315 §10.1) ────────────────────────
  // See INTERACTIVE_QUALITY_SCALE at module scope for the rationale.
  let interactiveQuality = false;
  // Last CSS size + dpr seen by setSize — the basis for both the full and the
  // reduced backing-store size so a resize mid-gesture still lands correctly.
  let lastCssW = width;
  let lastCssH = height;
  let lastDpr = initialDpr;

  /** Size the drawing buffer from the last CSS dims × dpr × the active quality
   * scale. Only touches canvas.width/height (drawScene reads the viewport from
   * gl.canvas each frame), so it is a cheap resize with no GL rebuilds. */
  function applyBackingStore(): void {
    const scale = interactiveQuality ? INTERACTIVE_QUALITY_SCALE : 1;
    const pxW = backingStorePx(lastCssW, lastDpr, scale);
    const pxH = backingStorePx(lastCssH, lastDpr, scale);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
  }

  function cancelScheduledRender(): void {
    if (rafHandle === null) return;
    window.cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  function invalidate(): void {
    if (stopped) return;
    if (rafHandle !== null) return;

    rafHandle = window.requestAnimationFrame(() => {
      rafHandle = null;
      const r = rendererRef;
      if (!r || stopped) return;
      r.drawScene();
    });
  }

  function markFullUpload(): void {
    dirty.nodesGeom = true;
    dirty.edgesGeom = true;
    dirty.colors = true;
    dirty.opacityField = true;
    dirty.emphasisField = true;
  }

  function ensureIndexForVisibleNodes(visibleNodeCount: number): void {
    const target = Math.max(0, Math.min(visibleNodeCount, latestNodes.length));
    if (!indexById) {
      indexById = new Map<number, number>();
      indexedNodeCount = 0;
    }

    // If visibility shrank, rebuild a compact prefix index.
    if (target < indexedNodeCount) {
      indexById = geometrySystem.buildIndexById(latestNodes, target);
      indexedNodeCount = target;
      return;
    }

    // Columnar ids where available (issue #315 R1b) — the same source
    // buildIndexById uses, so a grown prefix stays consistent with a rebuilt
    // one, and a row-lazy array has no rows to dereference.
    const idCols = columnsOf(latestNodes);
    for (let i = indexedNodeCount; i < target; i++) {
      indexById.set(idCols ? idCols.id[i] : latestNodes[i].id, i);
    }
    indexedNodeCount = target;
  }

  /** Lazy index access (issue #315 I2): the canonical instanced edge path
   * resolves without the id→index Map, so the 1M-entry build (~220 ms on
   * the boot pre-pass) only runs when a consumer actually needs it. */
  function ensuredIndexById(): Map<number, number> {
    ensureIndexForVisibleNodes(latestVisibleNodeCount);
    return indexById!;
  }

  function applyPendingState(renderer: WebGLRenderer): void {
    const columnsNext = pendingColumns;
    const nodesNext = pendingNodes;
    const edgesNext = pendingEdges;
    const settingsNext = pendingSettings;
    const opacityNext = pendingOpacityField;
    const emphasisNext = pendingEmphasisField;
    const visibleNodesNext = pendingVisibleNodeCount;
    const visibleEdgesNext = pendingVisibleEdgeCount;

    pendingColumns = null;
    pendingNodes = null;
    pendingEdges = null;
    pendingSettings = null;
    pendingOpacityField = null;
    pendingEmphasisField = null;
    pendingVisibleNodeCount = null;
    pendingVisibleEdgeCount = null;

    const firstUpload = !hasUploadedOnce;

    if (nodesNext) {
      if (firstUpload || nodesNext !== latestNodes) {
        latestNodes = nodesNext;
        renderer.nodesList = latestNodes;
        // Real point data replaces the boot columns source wholesale — unless
        // the rows are LAZY (issue #315 R1b): a hole-bearing canonical array
        // cannot serve the per-point reads below, so the sidecar columns stay
        // the source until something materializes the rows.
        if (nodesNext.length > 0 && areRowsResident(nodesNext)) latestColumns = null;

        markFullUpload();
        dirty.counts = true;

        opacityFieldOverride = null;
        emphasisFieldOverride = null;
        indexById = null;
        indexedNodeCount = 0;
      }
    }

    if (columnsNext && (latestNodes.length === 0 || !areRowsResident(latestNodes))) {
      latestColumns = columnsNext;
      latestVisibleNodeCount = columnsNext.count;
      markFullUpload();
      dirty.counts = true;
      opacityFieldOverride = null;
      emphasisFieldOverride = null;
      indexById = null;
      indexedNodeCount = 0;
    }

    if (edgesNext) {
      if (firstUpload || edgesNext !== latestEdges) {
        latestEdges = edgesNext;

        dirty.edgesGeom = true;
        dirty.colors = true;
      }
    }

    if (visibleNodesNext !== null) {
      // Columns mode has no windowing: the sidecar count owns the visible
      // count until real data replaces it (settings-driven updateData calls
      // pass the empty nodes array's length and must not zero the paint).
      const clamped = latestColumns && latestNodes.length === 0
        ? latestColumns.count
        : Math.max(0, Math.min(visibleNodesNext, latestNodes.length));
      if (clamped !== latestVisibleNodeCount) {
        latestVisibleNodeCount = clamped;
        dirty.nodesGeom = true;
        dirty.colors = true;
        dirty.opacityField = true;
        dirty.emphasisField = true;
      }
    }

    if (visibleEdgesNext !== null) {
      const clamped = Math.max(0, Math.min(visibleEdgesNext, latestEdges.segmentCount));
      if (clamped !== latestVisibleEdgeCount) {
        latestVisibleEdgeCount = clamped;
        dirty.edgesGeom = true;
        dirty.colors = true;
      }
    }

    if (settingsNext) {
      const prev = renderer.currentVisualSettings;

      const paletteChanged = !palettesEqual(prev.colorPalette, settingsNext.colorPalette);
      const encodingChanged = prev.colorEncoding !== settingsNext.colorEncoding;
      const doiThresholdsChanged =
        prev.grayOutDoiThreshold !== settingsNext.grayOutDoiThreshold ||
        prev.annotationDoiThreshold !== settingsNext.annotationDoiThreshold ||
        prev.insetDoiThreshold !== settingsNext.insetDoiThreshold;

      if (paletteChanged) {
        colorSystem.updatePalette(settingsNext.colorPalette);
      }

      if (paletteChanged || doiThresholdsChanged) {
        colorSystem.updateDoiThresholds({
          hidden: settingsNext.grayOutDoiThreshold,
          labeled: settingsNext.annotationDoiThreshold,
          inset: settingsNext.insetDoiThreshold,
        });
      }

      if (paletteChanged || encodingChanged || doiThresholdsChanged) dirty.colors = true;
      if (paletteChanged || encodingChanged) dirty.counts = true;
      dirty.uniforms = true;

      renderer.currentVisualSettings = {
        ...settingsNext,
        colorPalette: [...settingsNext.colorPalette],
      };

      renderer.opacityParams.threshold = settingsNext.grayOutDoiThreshold;
      renderer.opacityParams.minAlpha = settingsNext.minimumOpacityClamping;
      renderer.opacityParams.maxAlpha = settingsNext.maximumOpacityClamping;
    }

    if (opacityNext) {
      opacityFieldOverride = opacityNext;
      dirty.opacityField = true;
    }

    if (emphasisNext) {
      emphasisFieldOverride = emphasisNext;
      dirty.emphasisField = true;
    }
  }

  function flushUpdates(renderer: WebGLRenderer): void {
    applyPendingState(renderer);

    // Columns mode survives past setData while the rows are lazy (issue #315
    // R1b): every per-point read below then stays a typed-array indexing. The
    // moment a contract member materializes the rows (labeling, the local
    // stats fallback) the lane hands back — which matters for correctness, not
    // just speed: getColorEncodingKey applies the assigned-label override that
    // no sidecar column carries. Checked before the dirty gate, and dirtying
    // itself, so the handover cannot wait on an unrelated invalidation.
    if (latestColumns !== null && latestNodes.length > 0 && areRowsResident(latestNodes)) {
      latestColumns = null;
      dirty.counts = true;
      dirty.colors = true;
      dirty.nodesGeom = true;
    }

    if (!dirty.nodesGeom && !dirty.edgesGeom && !dirty.colors && !dirty.opacityField && !dirty.emphasisField && !dirty.distanceField) return;

    const encoding = renderer.currentVisualSettings.colorEncoding;

    const columnsMode = latestColumns !== null;

    if (dirty.counts && encoding !== "DoI" && columnsMode) {
      // Columns-mode twin of the rows loop below: numeric keys from the
      // encoding's sidecar column; an absent column = all-null keys = {}.
      // Same numeric-domain skip as the rows branch (gradient legend).
      if (resolveNumericColorRamp(encoding)) {
        dirty.counts = false;
      } else {
        const map: Record<string, number> = {};
        const col = latestColumns!.byName[encoding];
        if (col) {
          for (let i = 0; i < latestColumns!.count; i++) {
            const k = String(col[i]);
            map[k] = (map[k] ?? 0) + 1;
          }
        }
        recordAllCounts(map);
        dirty.counts = false;
      }
    }

    if (dirty.counts && encoding !== "DoI" && latestNodes.length > 0) {
      // Numeric-domain encodings render a stats-driven GRADIENT legend — the
      // discovery counts feed only categorical rows, and the O(dataset)
      // String()-per-point scan was half the encoding-change freeze at 1M
      // (issue #315 color-by freeze). Discovery is wiped on every encoding
      // switch, so skipping leaves it empty, never stale.
      if (resolveNumericColorRamp(encoding)) {
        dirty.counts = false;
      } else {
        const map: Record<string, number> = {};
        for (const node of latestNodes) {
          const key = getColorEncodingKey(node, encoding);
          if (key !== null) {
            const k = String(key);
            map[k] = (map[k] ?? 0) + 1;
          }
        }
        recordAllCounts(map);
        dirty.counts = false;
      }
    }

    const doiValuesForColor = encoding === "DoI" ? opacityFieldOverride ?? undefined : undefined;
    const previewColorUpdate = pendingOpacityFieldMode === "preview" && encoding === "DoI";
    const nowMs = performance.now();
    const nodeCount = renderer.nodeCount || latestVisibleNodeCount;
    const previewNodeIntervalMs = getPreviewNodeColorUploadIntervalMs(nodeCount);
    const previewEdgeIntervalMs = getPreviewEdgeColorUploadIntervalMs(nodeCount);
    const shouldUploadPreviewNodeColors =
      !previewColorUpdate ||
      dirty.nodesGeom ||
      nowMs - lastPreviewNodeColorUploadMs >= previewNodeIntervalMs;
    const shouldUploadPreviewEdgeColors =
      !previewColorUpdate ||
      dirty.edgesGeom ||
      nowMs - lastPreviewEdgeColorUploadMs >= previewEdgeIntervalMs;

    if (dirty.nodesGeom) {
      const nodePositions = columnsMode
        ? geometrySystem.buildNodePositionsFromColumns(latestColumns!, latestVisibleNodeCount)
        : geometrySystem.buildNodePositions(latestNodes, latestVisibleNodeCount);
      renderer.nodeCount = latestVisibleNodeCount;

      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.nodeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, nodePositions, gl.STATIC_DRAW);

      if (edgesInst) {
        const { W, H } = computeDataTexDims(gl, latestVisibleNodeCount);
        edgesInst.texWidthNodes = W;
        nodePosUploader.upload(gl, edgesInst.nodePosTex, W, H, nodePositions, 2, latestVisibleNodeCount);
      }

      // Data bbox for density-adaptive sizing (issue #315 C2 slice 2) —
      // one pass over the just-built interleaved positions.
      {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < nodePositions.length; i += 2) {
          const x = nodePositions[i];
          const y = nodePositions[i + 1];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        renderer.dataBboxW = maxX > minX ? maxX - minX : 0;
        renderer.dataBboxH = maxY > minY ? maxY - minY : 0;
      }
    }

    if (dirty.edgesGeom) {
      // Instanced path: O(edges) control-index texture instead of the
      // O(segments) CPU vertex expansion (which is a ~5 GB allocation at 1M
      // points). Non-uniformly tessellated legacy columns fall back.
      const S = edgesInst ? uniformSamplesPerEdge(latestEdges) : null;
      if (!loggedEdgePath && latestEdges.segmentCount > 0) {
        loggedEdgePath = true;
        console.debug(`[gl] edge path: ${edgesInst && S !== null ? "instanced" : "cpu"} (${latestEdges.segmentCount} segments)`);
      }
      if (edgesInst && S !== null) {
        const ctrlData =
          geometrySystem.buildEdgeControlDataCanonical(
            latestEdges,
            latestNodes,
            latestVisibleNodeCount
          ) ?? geometrySystem.buildEdgeControlData(latestEdges, ensuredIndexById());
        const { W, H } = computeDataTexDims(gl, latestEdges.edgeCount);
        edgesInst.texWidthEdges = W;
        edgesInst.samplesPerEdge = S;
        edgeCtrlUploader.upload(gl, edgesInst.edgeCtrlTex, W, H, ctrlData, 4, latestEdges.edgeCount);
        edgesInst.instanceCount = Math.max(0, Math.min(latestVisibleEdgeCount, latestEdges.segmentCount));

        // Mean edge chord in DATA units (issue #315 C2): drives the
        // zoom-adaptive tessellation in drawEdgesInstancedPass. O(edges),
        // recomputed only on edge-geometry rebuilds.
        edgesInst.avgEdgeDataLen = meanEdgeChordDataLen(latestEdges, latestNodes);

        cpuEdgeVerts = null;
        cpuEdgeIdx = null;
        renderer.edgeIndexCount = 0;
        // Arrows are instanced off the same textures — no CPU arrow build.
        cpuArrowVerts = null;
        renderer.arrowCount = 0;
      } else {
        if (edgesInst) edgesInst.instanceCount = 0;
        const edgeGeom = geometrySystem.buildEdgesGeometry(gl, latestEdges, ensuredIndexById(), latestVisibleEdgeCount);
        cpuEdgeVerts = edgeGeom.edgeVerts;
        cpuEdgeIdx = edgeGeom.edgeIdx;
        renderer.edgeIndexType = edgeGeom.edgeIndexType;
        renderer.edgeIndexCount = edgeGeom.edgeIndexCount;

        const arrowGeom = geometrySystem.buildArrowsGeometry(latestEdges, ensuredIndexById(), latestVisibleEdgeCount);
        cpuArrowVerts = arrowGeom.arrowVerts;
        renderer.arrowCount = arrowGeom.arrowCount;
      }

      dirty.colors = true;
    }

    if (dirty.colors) {
      if (shouldUploadPreviewNodeColors) {
        // Dictionary columns (sidecar FORMAT v2) decode to category arrays;
        // they color through the same per-value LUT as numeric columns since
        // issue #315 R1a step 7 (previously they fell back to the flat default
        // until the rows path took over — which is not an option once rows are
        // lazy).
        const encodingColumn = columnsMode ? latestColumns!.byName[encoding] : undefined;
        const nodeColors = columnsMode
          ? colorSystem.buildNodeColorsFromColumn(
              encodingColumn ?? null,
              latestVisibleNodeCount,
              encoding === "DoI" ? doiValuesForColor : undefined,
              encoding
            )
          : colorSystem.buildNodeColors(latestNodes, encoding, doiValuesForColor, latestVisibleNodeCount);
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.nodeColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, nodeColors, gl.STATIC_DRAW);

        // The instanced edge shader reads endpoint colors from this texture,
        // replacing the fillEdgeColors rewrite of the CPU vertex array.
        if (edgesInst) {
          const { W, H } = computeDataTexDims(gl, latestVisibleNodeCount);
          nodeColorUploader.upload(gl, edgesInst.nodeColorTex, W, H, nodeColors, 3, latestVisibleNodeCount);
        }
      }

      if (cpuEdgeVerts && shouldUploadPreviewEdgeColors) {
        colorSystem.fillEdgeColors(
          cpuEdgeVerts,
          latestEdges,
          latestNodes,
          encoding,
          doiValuesForColor,
          ensuredIndexById(),
          latestVisibleEdgeCount
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.edgeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, cpuEdgeVerts, gl.STATIC_DRAW);
      }

      if (dirty.edgesGeom && cpuEdgeIdx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.edgeIndexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cpuEdgeIdx, gl.STATIC_DRAW);
      }

      if (cpuArrowVerts && shouldUploadPreviewEdgeColors) {
        colorSystem.fillArrowColors(
          cpuArrowVerts,
          latestEdges,
          latestNodes,
          encoding,
          doiValuesForColor,
          ensuredIndexById(),
          latestVisibleEdgeCount
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, renderer.arrowBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, cpuArrowVerts, gl.STATIC_DRAW);
      }

      if (previewColorUpdate && shouldUploadPreviewNodeColors) {
        lastPreviewNodeColorUploadMs = nowMs;
      }
      if (previewColorUpdate && shouldUploadPreviewEdgeColors) {
        lastPreviewEdgeColorUploadMs = nowMs;
      }
    } else if (dirty.edgesGeom && cpuEdgeIdx) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, renderer.edgeIndexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cpuEdgeIdx, gl.STATIC_DRAW);
    }

    if (dirty.opacityField) {
      const nodeCount = renderer.nodeCount || latestVisibleNodeCount;
      renderer.nodeCount = nodeCount;

      // Columns mode: the boot state is the server-cut implicit uniform
      // (DoI 1 everywhere) — the sidecar carries no DoI column.
      const values =
        opacityFieldOverride ??
        (columnsMode
          ? new Float32Array(nodeCount).fill(1)
          : opacityFieldSystem.buildOpacityField(latestNodes, nodeCount));

      const vboSlice = values.length > nodeCount ? values.subarray(0, nodeCount) : values;

      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.nodeOpacityFieldBuffer);
      if (!opacityVboAllocated || dirty.nodesGeom) {
        gl.bufferData(gl.ARRAY_BUFFER, vboSlice, gl.DYNAMIC_DRAW);
        opacityVboAllocated = true;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vboSlice);
      }

      const { W, H } = opacityFieldSystem.computeTextureDims(gl, nodeCount);
      const dimsChanged = W !== renderer.opacityFieldTexW || H !== renderer.opacityFieldTexH;

      renderer.opacityFieldTexW = W;
      renderer.opacityFieldTexH = H;

      const forceRealloc = dimsChanged || !opacityTexAllocated;

      opacityFieldSystem.uploadOpacityTexture(gl, renderer.opacityFieldTex, W, H, values, nodeCount, forceRealloc);
      opacityTexAllocated = true;
      // A CPU opacity upload is the exact flush — it always supersedes a GPU
      // motion tick's texture content (plan-gpu-motion-lane.md).
      renderer.gpuOpacityOverride = false;
    }

    if (dirty.emphasisField) {
      const nodeCount = renderer.nodeCount || latestVisibleNodeCount;
      renderer.nodeCount = nodeCount;

      // Null override = all zeros (no emphasis).
      const values = emphasisFieldOverride ?? new Float32Array(nodeCount);
      const vboSlice = values.length > nodeCount ? values.subarray(0, nodeCount) : values;

      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.nodeEmphasisFieldBuffer);
      if (!emphasisVboAllocated || dirty.nodesGeom) {
        gl.bufferData(gl.ARRAY_BUFFER, vboSlice, gl.DYNAMIC_DRAW);
        emphasisVboAllocated = true;
      } else {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, vboSlice);
      }

      const { W, H } = opacityFieldSystem.computeTextureDims(gl, nodeCount);
      const dimsChanged = W !== renderer.emphasisFieldTexW || H !== renderer.emphasisFieldTexH;
      renderer.emphasisFieldTexW = W;
      renderer.emphasisFieldTexH = H;

      const forceRealloc = dimsChanged || !emphasisTexAllocated;
      opacityFieldSystem.uploadOpacityTexture(gl, renderer.emphasisFieldTex, W, H, values, nodeCount, forceRealloc);
      emphasisTexAllocated = true;
    }

    // GPU falloff-preview frozen-chain field (issue #315): same nodeCount + dims
    // as the opacity texture (record-index W×H), four channels
    // (D, srcDist, gain, seedChain), uploaded once per freeze. Values are
    // pre-interleaved and sanitized in setDistanceField (Inf/NaN → sentinel).
    if (dirty.distanceField && pendingDistanceField) {
      const nodeCount = renderer.nodeCount || latestVisibleNodeCount;
      renderer.nodeCount = nodeCount;

      const { W, H } = opacityFieldSystem.computeTextureDims(gl, nodeCount);
      const dimsChanged = W !== renderer.distFieldTexW || H !== renderer.distFieldTexH;
      renderer.distFieldTexW = W;
      renderer.distFieldTexH = H;

      const forceRealloc = dimsChanged || !distTexAllocated;
      opacityFieldSystem.uploadQuadTexture(
        gl,
        renderer.distFieldTex,
        W,
        H,
        pendingDistanceField,
        nodeCount,
        forceRealloc
      );
      distTexAllocated = true;
      pendingDistanceField = null;
    }

    dirty.nodesGeom = false;
    dirty.edgesGeom = false;
    dirty.colors = false;
    dirty.opacityField = false;
    dirty.emphasisField = false;
    dirty.distanceField = false;
    dirty.uniforms = false;
    pendingOpacityFieldMode = "full";

    hasUploadedOnce = true;
  }

  const renderer: WebGLRenderer = {
    gl,
    canvas,
    nodesList: nodes,

    programNodes,
    programEdges,
    programArrows,
    programEdgesQuad,

    nodeBuffer,
    nodeColorBuffer,
    nodeOpacityFieldBuffer,
    nodeEmphasisFieldBuffer,
    nodeCount: 0,

    vaoNodes,
    vaoEdgesQuad,
    vaoArrows,

    edgeBuffer,
    edgeIndexBuffer,
    edgeIndexCount: 0,
    edgeIndexType: gl.UNSIGNED_SHORT,

    arrowBuffer,
    arrowCount: 0,

    edgesInst,

    dataBboxW: 0,
    dataBboxH: 0,
    densityHint: null,

    opacityFieldTex,
    opacityFieldTexW: 1,
    opacityFieldTexH: 1,

    emphasisFieldTex,
    emphasisFieldTexW: 1,
    emphasisFieldTexH: 1,
    emphasisScale: 0,

    distFieldTex,
    distFieldTexW: 1,
    distFieldTexH: 1,
    falloffPreview: null,
    falloffPreviewBlend: 0,

    u_matrixNodes,
    u_matrixEdges: gl.getUniformLocation(programEdges, "u_matrix"),
    u_matrixArrows,
    u_matrixEdgesQuad,

    u_resolutionArrows,
    u_resolutionEdgesQuad,

    u_edgeWidth,

    u_nodeRadiusPx,
    u_nodeOutlineWidthPx,
    u_nodeOutlineWhite,
    u_emphasisScaleNodes,
    u_arrowLengthPx,

    u_opacityThresholdNodes,
    u_minOpacityNodes,
    u_maxOpacityNodes,
    u_applyGrayBelowThresholdNodes,

    u_opacityThresholdEdges,
    u_minOpacityEdges,
    u_maxOpacityEdges,
    u_applyGrayBelowThresholdEdges,
    u_opacityMixEdges,
    u_opacityFieldTexEdges,
    u_opacityFieldTexDimEdges,
    u_emphasisScaleEdgesQuad,
    u_emphasisFieldTexEdges,
    u_emphasisFieldTexDimEdges,

    u_opacityThresholdArrows,
    u_minOpacityArrows,
    u_maxOpacityArrows,
    u_applyGrayBelowThresholdArrows,
    u_opacityMixArrows,
    u_opacityFieldTexArrows,
    u_opacityFieldTexDimArrows,

    falloffNodes,
    falloffEdges,

    gpuOpacityOverride: false,
    u_opacityFromTexNodes,
    u_opacityFieldTexNodes,
    u_opacityFieldTexDimNodes,
    convergedMotion: null,

    transformMatrix: new Float32Array(transformMat),
    lastTransformChangeAt: 0,
    edgeWidth: 1,

    currentVisualSettings: {
      ...initialVisualSettings,
      colorPalette: [...initialVisualSettings.colorPalette],
    },
    opacityParams: {
      threshold: initialVisualSettings.grayOutDoiThreshold,
      minAlpha: initialVisualSettings.minimumOpacityClamping,
      maxAlpha: initialVisualSettings.maximumOpacityClamping,
    },
    opacityMix: 1.0,

    updateData(newNodes, newEdges, visualSettings, visibleNodeCount, visibleEdgeCount) {
      if (stopped) return;
      pendingNodes = newNodes;
      pendingEdges = newEdges;
      pendingSettings = visualSettings;
      pendingVisibleNodeCount = visibleNodeCount ?? newNodes.length;
      pendingVisibleEdgeCount = visibleEdgeCount ?? newEdges.segmentCount;
      invalidate();
    },

    updateColumnData(cols) {
      if (stopped) return;
      // The boot paint needs positions; a sidecar without x/y (never emitted
      // today) has nothing to draw and is ignored.
      if (!cols.byName["x"] || !cols.byName["y"]) return;
      pendingColumns = cols;
      invalidate();
    },

    setTileSource(source: ScatterTileSource | null) {
      if (stopped) return;
      tileLayer.setSource(source);
      invalidate();
    },

    setAggregateSource(source: AggregateTileSource | null) {
      if (stopped) return;
      aggregateLayer.setSource(source);
      // Density-adaptive sizing input for empty-geometry renderers (issue
      // #315 G4): the meta's point count + bbox stand in for the not-yet-
      // loaded dataset; densityPointScale ignores this once real node
      // geometry populates nodeCount/dataBbox.
      const meta = source?.meta;
      this.densityHint =
        meta && (meta.pointCount ?? 0) > 0
          ? {
              count: meta.pointCount as number,
              bboxW: meta.maxX - meta.minX,
              bboxH: meta.maxY - meta.minY,
            }
          : null;
      invalidate();
    },

    updateTransform(matrix: number[]) {
      if (stopped) return;
      this.transformMatrix = new Float32Array(matrix);
      this.lastTransformChangeAt = performance.now();
      // Debounced full-quality restore (gesture LOD, issue #315): once the
      // transform stops changing, one extra frame re-renders at rest quality
      // (the on-demand loop would otherwise leave the coarse frame on screen).
      if (lodRestoreTimer !== null) clearTimeout(lodRestoreTimer);
      lodRestoreTimer = setTimeout(() => {
        lodRestoreTimer = null;
        if (!stopped) invalidate();
      }, GESTURE_LOD_HOLD_MS + 40);
      dirty.uniforms = true;
      invalidate();
    },

    setOpacityParams(params: { threshold: number; minAlpha: number; maxAlpha: number }) {
      if (stopped) return;
      this.opacityParams.threshold = params.threshold;
      this.opacityParams.minAlpha = params.minAlpha;
      this.opacityParams.maxAlpha = params.maxAlpha;
      dirty.uniforms = true;
      invalidate();
    },

    setOpacityField(values: Float32Array, mode: OpacityFieldUpdateMode = "full") {
      if (stopped) return;
      pendingOpacityField = values;
      pendingOpacityFieldMode = mode;
      if (this.currentVisualSettings.colorEncoding === "DoI") {
        dirty.colors = true;
      }
      invalidate();
    },

    setOpacityMix(mix: number) {
      if (stopped) return;
      this.opacityMix = Math.max(0, Math.min(1, mix));
      dirty.uniforms = true;
      invalidate();
    },

    setEmphasisField(values: Float32Array, mode: OpacityFieldUpdateMode = "full") {
      if (stopped) return;
      pendingEmphasisField = values;
      void mode; // reserved for future per-mode throttling
      invalidate();
    },

    setEmphasisScale(scale: number) {
      if (stopped) return;
      this.emphasisScale = Math.max(0, scale);
      dirty.uniforms = true;
      invalidate();
    },

    setDistanceField(dist: Float32Array, frozen?: FrozenChainLayers | null) {
      if (stopped) return;
      // Interleave into the RGBA32F payload the shader samples, sanitizing
      // +Infinity / NaN (unreachable) to a large finite sentinel so the upload +
      // GLSL compare (`d >= SENTINEL/2`) read them as DoI 0 without depending on
      // Inf surviving the texture path on every driver. Without frozen layers
      // the payload degenerates to the plain `v = f(D)` preview: the chain
      // source IS the point itself, unit gain, no seed chain.
      const n = dist.length;
      let scratch = distSanitizeScratch;
      if (!scratch || scratch.length !== n * 4) {
        scratch = new Float32Array(n * 4);
        distSanitizeScratch = scratch;
      }
      // NaN < x is false → sentinel.
      const sanitize = (d: number) =>
        d < FALLOFF_DIST_SENTINEL ? d : FALLOFF_DIST_SENTINEL;
      for (let i = 0; i < n; i++) {
        const o = 4 * i;
        scratch[o] = sanitize(dist[i]);
        scratch[o + 1] = frozen ? sanitize(frozen.srcDist[i]) : scratch[o];
        scratch[o + 2] = frozen ? frozen.gain[i] : 1;
        scratch[o + 3] = frozen ? frozen.seedChain[i] : 0;
      }
      pendingDistanceField = scratch;
      dirty.distanceField = true;
      invalidate();
    },

    setFalloffPreview(params: FalloffPreviewParams | null) {
      if (stopped) return;
      this.falloffPreview = params;
      // Turning the preview OFF is the end state of a cross-fade, so it also
      // resets the weight: the next drag must start at pure preview again.
      if (params === null) this.falloffPreviewBlend = 0;
      dirty.uniforms = true;
      invalidate();
    },

    setFalloffPreviewBlend(t: number) {
      if (stopped) return;
      const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
      if (this.falloffPreviewBlend === clamped) return; // idempotent per frame
      this.falloffPreviewBlend = clamped;
      dirty.uniforms = true;
      invalidate();
    },

    // ── GPU motion lane (plan-gpu-motion-lane.md) ────────────────────────────

    setConvergedMotionField(data: ConvergedMotionFieldInput | null) {
      if (stopped) return false;
      if (data === null) {
        this.convergedMotion?.setField(null);
        this.gpuOpacityOverride = false;
        return true;
      }
      // Float render targets share the HDR probe (EXT_color_buffer_float).
      if (!hdrSupported) return false;
      // The compute textures adopt the opacity texture's record dims — the
      // present pass renders straight into it, so they MUST agree. A stub
      // (pre-first-upload) or foreign-count texture refuses the lane.
      if (
        !opacityTexAllocated ||
        this.opacityFieldTexW * this.opacityFieldTexH < data.n
      ) {
        return false;
      }
      if (!this.convergedMotion) this.convergedMotion = new ConvergedMotionSystem(gl);
      return this.convergedMotion.setField({
        ...data,
        texW: this.opacityFieldTexW,
        texH: this.opacityFieldTexH,
      });
    },

    runConvergedMotionTick(params: ConvergedMotionTickParams) {
      if (stopped || !this.convergedMotion) return false;
      // The opacity texture must exist with the field's dims — always true
      // under a resident field (its commit uploaded one) — or the FBO attach
      // below would target a 1×1 stub.
      if (!opacityTexAllocated) return false;
      const ok = this.convergedMotion.run(
        params,
        this.opacityFieldTex,
        this.opacityFieldTexW,
        this.opacityFieldTexH
      );
      if (!ok) return false;
      this.gpuOpacityOverride = true;
      dirty.uniforms = true;
      invalidate();
      return true;
    },

    pollConvergedMotionTickMs() {
      if (stopped || !this.convergedMotion) return undefined;
      return this.convergedMotion.pollTickGpuMs();
    },

    readConvergedMotionField() {
      return this.convergedMotion?.readback() ?? null;
    },

    uploadConvergedMotionExact(values: Float32Array) {
      if (stopped || !this.convergedMotion || !opacityTexAllocated) return false;
      if (!this.convergedMotion.uploadExact(values)) return false;
      // Snapshot what is on screen RIGHT NOW as the blend's FROM side — a
      // fade must depart from the viewer's current field, never from the
      // GPU work buffer (whose content the screen may have moved past).
      return this.convergedMotion.snapshotBlendSource(
        this.opacityFieldTex,
        this.opacityFieldTexW,
        this.opacityFieldTexH
      );
    },

    blendConvergedMotionExact(t: number) {
      if (stopped || !this.convergedMotion || !opacityTexAllocated) return false;
      const ok = this.convergedMotion.blendExact(
        t,
        this.opacityFieldTex,
        this.opacityFieldTexW,
        this.opacityFieldTexH
      );
      if (!ok) return false;
      this.gpuOpacityOverride = true;
      dirty.uniforms = true;
      invalidate();
      return true;
    },

    setSize(w: number, h: number, nextDpr?: number) {
      if (stopped) return;

      lastCssW = w;
      lastCssH = h;
      lastDpr = nextDpr ?? window.devicePixelRatio ?? 1;

      applyBackingStore();

      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;

      dirty.uniforms = true;
      invalidate();
    },

    setInteractiveQuality(on: boolean) {
      if (stopped) return;
      if (interactiveQuality === on) return; // idempotent — safe to call per tick
      interactiveQuality = on;
      // Resize the drawing buffer only; the CSS box is unchanged so the browser
      // stretches the reduced buffer back to full size. drawScene sets the
      // viewport from gl.canvas.width/height, so one repaint picks it up. When
      // turning off, this repaint is the full-quality restore frame.
      applyBackingStore();
      dirty.uniforms = true;
      invalidate();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      offColorScaleRebuild();
      cancelScheduledRender();
      if (lodRestoreTimer !== null) {
        clearTimeout(lodRestoreTimer);
        lodRestoreTimer = null;
      }
      tileLayer.dispose();
      aggregateLayer.dispose();
      if (sceneMsaaFbo !== null) gl.deleteFramebuffer(sceneMsaaFbo);
      if (sceneMsaaRbo !== null) gl.deleteRenderbuffer(sceneMsaaRbo);
      if (sceneResolveFbo !== null) gl.deleteFramebuffer(sceneResolveFbo);
      if (sceneTex !== null) gl.deleteTexture(sceneTex);
      rendererRef = null;
    },

    drawScene() {
      if (stopped) return;

      cancelScheduledRender();
      flushUpdates(this);
      this.canvas.style.backgroundColor = this.currentVisualSettings.canvasBgColor ?? "#ffffff";

      const canvasWidth = gl.canvas.width;
      const canvasHeight = gl.canvas.height;
      const [r, g, b] = hexToRgb01(this.currentVisualSettings.canvasBgColor ?? "#ffffff");

      // Mark sizes come from the ACTUAL backing store, never
      // window.devicePixelRatio: under the interactive-quality reduction the
      // drawing buffer is smaller than dpr × CSS and the browser stretches it
      // back, so a dpr-derived size is scaled twice (issue #315 regression c).
      const dprNow = effectiveDpr(canvasWidth, lastCssW, window.devicePixelRatio || 1);
      const marks = computeMarkSizesPx(this, canvasWidth, canvasHeight, dprNow);

      // Gesture compositor path (see the snapshot block near program setup):
      // mid-gesture frames on huge datasets re-draw the cached settled frame
      // as one transformed triangle instead of the full geometry. It draws
      // straight to the backbuffer — the snapshot is already 8-bit, so an HDR
      // round-trip would only add a fullscreen pass to the fill-bound hot path.
      if (
        isGestureLod(this) &&
        snapshotValid &&
        snapshotMatrix !== null &&
        snapshotW === canvasWidth &&
        snapshotH === canvasHeight
      ) {
        const inv = invert3x3(this.transformMatrix);
        if (inv) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, canvasWidth, canvasHeight);
          gl.clearColor(r, g, b, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(programSnapshot);
          gl.uniformMatrix3fv(u_snapshotDelta, false, multiply3x3(snapshotMatrix, inv));
          gl.activeTexture(gl.TEXTURE7);
          gl.bindTexture(gl.TEXTURE_2D, snapshotTex);
          gl.uniform1i(u_snapshotTex, 7);
          gl.activeTexture(gl.TEXTURE0);
          gl.disable(gl.BLEND);
          gl.bindVertexArray(vaoSnapshot);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindVertexArray(null);
          gl.enable(gl.BLEND);
          return;
        }
      }

      // Scene passes render into the RGBA16F target (HDR, see the scene-target
      // block); fallback is the backbuffer when EXT_color_buffer_float is out.
      const hdr = ensureSceneTarget(canvasWidth, canvasHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, hdr ? (sceneSamples > 0 ? sceneMsaaFbo : sceneResolveFbo) : null);
      gl.viewport(0, 0, canvasWidth, canvasHeight);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      // Straight (non-premultiplied) alpha (issue #315 §10.3): the node/edge/
      // arrow/aggregate frag shaders output vec4(color, alpha) and the blender
      // multiplies by SRC_ALPHA — at half-float precision in the HDR target.
      // The tile pass composites a straight-alpha texture, so it is correct
      // under this mode too. Alpha uses ONE, not SRC_ALPHA: with SRC_ALPHA the
      // destination alpha decays toward the per-draw alpha under overdraw
      // (srcA² + dstA·(1−srcA)) — harmless inside the HDR target but a page
      // bleed-through on the direct-to-backbuffer fallback, whose context
      // composites premultiplied.
      gl.blendFuncSeparate(
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      );

      // Tile base imagery (issue #315 phase E): on huge datasets (or before
      // any geometry has loaded) draw server tiles instead of raw geometry
      // whenever the view is within the pyramid — a settle frame is then a
      // handful of textured quads instead of an O(dataset) GPU pass. Zoomed
      // past the deepest level, draw() returns false and real geometry
      // takes over (the visible subset is small there).
      const hugeDataset =
        !this.edgesInst || this.edgesInst.instanceCount === 0 || this.edgesInst.instanceCount > 2_000_000;
      // Server base imagery is colored by the PREP-TIME colorColumn baked
      // into its pyramid (contract #4 maps class VALUES through the client
      // colorScale — it cannot represent any OTHER encoding). When the user
      // selects a different color encoding the raw geometry pass must draw
      // instead, or the selection silently does nothing at rest (synth1m's
      // degenerate single-class aggregates stayed default-green under every
      // encoding). Before any node geometry exists (early boot) the base
      // draws regardless — there is nothing else to show. A tile source
      // whose meta predates colorColumn keeps today's behavior.
      const encodingNow = this.currentVisualSettings.colorEncoding;
      const noGeometryYet = this.nodeCount === 0;
      // An EMPTY encoding ("no color feature", the validated state for
      // datasets lacking their preset's column) is compatible with a
      // degenerate single-class pyramid: both render every point in the
      // same default color, so the LOD base stays.
      const aggColorOk =
        noGeometryYet ||
        aggregateLayer.colorColumn() === encodingNow ||
        (encodingNow === "" && aggregateLayer.hasDegenerateClasses());
      const tileColorColumn = tileLayer.colorColumn();
      const tileColorOk =
        noGeometryYet || tileColorColumn === null || tileColorColumn === encodingNow;
      // Weighted-point aggregates (plan G, G3): when eligible they REPLACE
      // the node pass (edges keep the instanced path until G5) and demote
      // the raster tile layer to a non-participant. DEFAULT ON since the
      // parity bench + CS eyeball passed (2026-07-19);
      // `window.__lodAggregates = false` is the explicit opt-out the parity
      // bench uses for its raw-mode boots.
      const aggEligible =
        hugeDataset &&
        aggColorOk &&
        aggregateLayer.hasSource() &&
        (window as unknown as { __lodAggregates?: boolean }).__lodAggregates !== false;
      const tileEligible = !aggEligible && tileLayer.hasSource() && hugeDataset && tileColorOk;
      let drewTiles = false;
      if (tileEligible) {
        drewTiles = tileLayer.draw(this.transformMatrix, canvasWidth);
      }

      let drewAgg = false;
      if (!drewTiles) {
        bindOpacityFieldTexture(this);
        bindEmphasisFieldTexture(this);
        drawEdgesPass(this, canvasWidth, canvasHeight, marks);
        drawArrowsPass(this, canvasWidth, canvasHeight, marks);
        if (aggEligible) {
          drewAgg = aggregateLayer.draw(this.transformMatrix, canvasWidth, {
            pointSizePx: marks.nodeRadiusPx,
            // Uniform-DoI at-rest: every raw point renders at u_maxOpacity
            // (field == 1 ⇒ t == 1), so that is the per-splat base alpha.
            alpha: this.opacityParams.maxAlpha,
            outlineWidthPx: marks.nodeOutlineWidthPx,
            outlineWhite: this.currentVisualSettings.nodeOutlineWhite === true,
            // LEVEL selection must not see the interactive-quality reduction:
            // halving the device width drops the pyramid level by exactly one,
            // which mid-drag means coarser imagery plus an all-or-nothing
            // refetch of a whole level (issue #315 regression b, "max opacity
            // turns everything blurry").
            levelCanvasWidth: backingStorePx(lastCssW, lastDpr, 1),
          });
        }
        if (!drewAgg) drawNodesPass(this, marks);
      }

      // Debug beacon (issue #315 G4, same convention as __lodAggregates):
      // which base path drew this frame and at what splat size — the headless
      // eyeball gates read this to attribute what is actually on screen.
      (window as unknown as { __baseDrawDebug?: object }).__baseDrawDebug = {
        drewTiles,
        drewAgg,
        aggEligible,
        nodeCount: this.nodeCount,
        densityHint: this.densityHint,
        // Full data→clip mapping + canvas size: lets headless gates compare
        // the FRAMING of the early base vs the loaded view (issue #315 2b).
        matrix: Array.from(this.transformMatrix),
        canvas: { w: canvasWidth, h: canvasHeight },
        nodeRadius: this.currentVisualSettings.nodeRadius,
        aggPointSizePx: aggEligible ? marks.nodeRadiusPx : null,
        // Every mark size actually pushed this frame + the effective dpr they
        // were derived from (issue #315: the headless gates and the jsdom
        // regression tests read this instead of the GL uniforms).
        marks,
        dpr: dprNow,
      };

      gl.bindVertexArray(null);

      if (hdr) {
        // Resolve MSAA into the scene texture, then present to the backbuffer
        // — the frame's single 8-bit quantization step.
        if (sceneSamples > 0) {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sceneMsaaFbo);
          gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneResolveFbo);
          gl.blitFramebuffer(
            0, 0, canvasWidth, canvasHeight,
            0, 0, canvasWidth, canvasHeight,
            gl.COLOR_BUFFER_BIT,
            gl.NEAREST,
          );
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(programPresent);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, sceneTex);
        gl.uniform1i(u_presentTex, 5);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindVertexArray(vaoSnapshot);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        gl.enable(gl.BLEND);
      }

      // Capture the settled frame for the compositor: only at-rest
      // full-quality draws refresh it, so mid-gesture frames always
      // composite the last exact rendering. Reads the backbuffer, which after
      // the present pass holds the final quantized frame.
      if (
        !isGestureLod(this) &&
        ((this.edgesInst && this.edgesInst.instanceCount > 2_000_000) || drewTiles || drewAgg)
      ) {
        gl.bindTexture(gl.TEXTURE_2D, snapshotTex);
        gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, canvasWidth, canvasHeight, 0);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        snapshotMatrix = new Float32Array(this.transformMatrix);
        snapshotW = canvasWidth;
        snapshotH = canvasHeight;
        snapshotValid = true;
      }
    },
  };

  rendererRef = renderer;

  renderer.updateData(nodes, segments, renderer.currentVisualSettings);
  invalidate();

  return renderer;
}
