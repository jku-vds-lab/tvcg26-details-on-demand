// packages/app/src/gl/core/aggregateLayer.ts
//
// Weighted-point aggregate layer (issue #315 plan G, G3). At-rest frames on
// huge datasets draw the server's per-level aggregated points instead of the
// raw node pass: each non-empty (bin, class) is ONE splat at the member
// centroid carrying weight w, and the shader composes the exact coverage k
// stacked raw splats would produce — alpha_eff = 1-(1-a)^w, computed as
// exp2(w*log2(1-a)) with the a==1 branch guarded (exactness contract #3).
// Edges/arrows keep the existing instanced path until G5; the raw node path
// is untouched for focus views and the paper build. The source is injected
// (`@scaling` resolves it in the server build), so this module stays open-core.
//
// Draw is ALL-OR-NOTHING per frame: unless every tile covering the viewport
// at the active level is resident, the caller falls back to raw geometry and
// fetched tiles invalidate() a later frame — levels never mix (no ancestor
// stretch: stretched aggregate POINTS would double-draw where siblings are
// resident, breaking density-completeness).
//
// Shader I/O: a_position (loc 0) = centroid in data space; a_weight (loc 1)
// = member count; a_class (loc 2) = class id as float, indexing u_palette
// (client colorScale colors — identical to the raw path's, contract #4).
// Point size/outline uniforms mirror the node program so splats match raw
// points pixel-for-pixel at weight 1.

import type { AggregateTile, AggregateTileSource } from "src/scaling.types";
import { createProgram } from "../resources/ShaderProgram";
import { GLSL_ALPHA_QUANTUM } from "../shaders/glslUtils";

const AGG_VS = `#version 300 es
layout(location=0) in vec2 a_position;
layout(location=1) in float a_weight;
layout(location=2) in float a_class;
uniform mat3 u_matrix;
uniform float u_nodeRadiusPx;
uniform float u_binPx;
uniform float u_alpha;
uniform float u_nodeOutlineWidthPx;
uniform bool u_nodeOutlineWhite;
uniform vec3 u_palette[64];
uniform int u_classCount;
out vec3 v_color;
out float v_alpha;
out float v_weight;
void main() {
  vec3 pos = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  // Multi-member bins draw square texels sized to the bin pitch (≥ 1px so
  // pixel centers are never missed); singletons keep the raw point size.
  gl_PointSize = a_weight > 1.5
    ? max(u_nodeRadiusPx, max(u_binPx, 1.0))
    : u_nodeRadiusPx;
  int ci = clamp(int(a_class + 0.5), 0, max(u_classCount - 1, 0));
  v_color = u_palette[ci];
  // Multi-member bins fold the node OUTLINE into the fill: in saturated
  // raw regions the visible color is the expectation over each point's
  // footprint = node color mixed with outline color by the outline ring's
  // AREA fraction (raw cores render visibly darker than the pure node
  // color because of exactly this).
  if (a_weight > 1.5 && u_nodeOutlineWidthPx > 0.0) {
    float ib = clamp((0.5 - u_nodeOutlineWidthPx / max(u_nodeRadiusPx, 1e-6)) / 0.5, 0.0, 1.0);
    float outlineFrac = 1.0 - ib * ib;
    vec3 outlineColor = u_nodeOutlineWhite ? vec3(1.0) : vec3(0.0);
    v_color = mix(v_color, outlineColor, outlineFrac);
  }
  float a = clamp(u_alpha, 0.0, 1.0);
  // Multi-member bins: each member is a raw AA circle of diameter
  // u_nodeRadiusPx spread somewhere inside the ~u_binPx bin, so it covers
  // only cbar = min(1, circleArea/binArea) of a bin-pixel. The pixel's
  // expected transmittance over w such members is (1 - a*cbar)^w, drawn as
  // a full-coverage square texel. Singletons render the literal AA circle
  // at alpha a (coverage comes from the fragment shader).
  float binArea = max(u_binPx * u_binPx, 1e-6);
  float cbar = min(0.7853982 * u_nodeRadiusPx * u_nodeRadiusPx / binArea, 1.0);
  float ac = a * cbar;
  v_alpha = a_weight > 1.5
    ? (ac >= 0.9999995 ? 1.0 : 1.0 - exp2(a_weight * log2(1.0 - ac)))
    : a;
  v_weight = a_weight;
}`;

// Weight-1 singletons replicate node.frag's AA circle + outline exactly
// (contract #2's outlier clause: a lone point renders like a raw point).
// Multi-member bins render the FULL square texel instead: their splats sit
// on the ~1px bin lattice, and circles on a lattice cannot tile a saturated
// region the way arbitrarily-positioned raw circles do — the sub-pixel
// corner gaps beat against the pixel grid as a visible quilt in dense
// cores. Squares tile exactly; at ~1 bin ≈ 1px the shape difference of a
// multi-member bin is sub-pixel.
const AGG_FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_alpha;
in float v_weight;
uniform float u_nodeRadiusPx;
uniform float u_nodeOutlineWidthPx;
uniform bool u_nodeOutlineWhite;
${GLSL_ALPHA_QUANTUM}
out vec4 outColor;
void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  float aa = fwidth(dist);
  float coverage;
  vec3 finalColor = v_color;
  if (v_weight > 1.5) {
    coverage = 1.0;
  } else {
    coverage = 1.0 - smoothstep(0.5 - aa, 0.5, dist);
    if (coverage <= 0.001) discard;
    if (u_nodeOutlineWidthPx > 0.0) {
      float innerBoundary = 0.5 - (u_nodeOutlineWidthPx / max(u_nodeRadiusPx, 1e-6));
      float outlineFraction = smoothstep(innerBoundary - aa, innerBoundary + aa, dist);
      vec3 outlineColor = u_nodeOutlineWhite ? vec3(1.0) : vec3(0.0);
      finalColor = mix(v_color, outlineColor, outlineFraction);
    }
  }
  // #315: sub-quantum floor for singleton splats — see GLSL_ALPHA_QUANTUM.
  float base = v_alpha > 0.0 ? max(v_alpha, ALPHA_QUANTUM) : 0.0;
  float alpha = base * coverage;
  // Straight (non-premultiplied) alpha output (issue #315 §10.3): RGB is the
  // literal splat color, alpha the coverage; the aggregate pass runs under the
  // scene's blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA). See node.frag for why.
  outColor = vec4(finalColor, alpha);
}`;

const RESIDENT_CAP = 96;
const MAX_PALETTE = 64;

interface ResidentAggTile {
  /** null for empty (404) tiles — resident so they are never refetched. */
  vao: WebGLVertexArrayObject | null;
  buffer: WebGLBuffer | null;
  count: number;
  lastUsed: number;
}

/** Per-frame draw parameters mirroring the node pass uniforms. */
export interface AggregateDrawParams {
  /** gl_PointSize in device px (nodeRadius * dpr * densityPointScale). */
  pointSizePx: number;
  /** The raw per-point alpha at uniform-DoI rest (= u_maxOpacity). */
  alpha: number;
  outlineWidthPx: number;
  outlineWhite: boolean;
  /**
   * Device-px canvas width at FULL quality (i.e. `canvas.width` with the
   * interactive-quality scale divided out) — used for pyramid LEVEL selection
   * ONLY, while the bin pitch keeps using the real drawing-buffer width.
   *
   * Issue #315, CS 2026-07-26 regression b: `levelFor` CEILs a log2, so halving
   * the device width during a drag drops the level by exactly one. Every
   * quality-reduced frame therefore asked for a coarser level whose tiles were
   * not resident — all-or-nothing → raw-geometry fallback → a refetch of a
   * whole level → visibly coarser splats on top of the half-resolution upscale
   * ("max opacity turns everything blurry"). Level selection is a property of
   * the VIEW, not of the render resolution.
   */
  levelCanvasWidth: number;
}

export class AggregateLayer {
  private source: AggregateTileSource | null = null;
  private readonly resident = new Map<string, ResidentAggTile>();
  private readonly inFlight = new Set<string>();
  private readonly program: WebGLProgram;
  private readonly uMatrix: WebGLUniformLocation | null;
  private readonly uNodeRadiusPx: WebGLUniformLocation | null;
  private readonly uBinPx: WebGLUniformLocation | null;
  private readonly uAlpha: WebGLUniformLocation | null;
  private readonly uPalette: WebGLUniformLocation | null;
  private readonly uClassCount: WebGLUniformLocation | null;
  private readonly uOutlineWidthPx: WebGLUniformLocation | null;
  private readonly uOutlineWhite: WebGLUniformLocation | null;
  private useCounter = 0;
  /** Lazily built from the source's class table on first draw (the global
   * colorScale is populated by then); rebuilt when the source changes. */
  private palette: Float32Array | null = null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /** Re-render request — called when a fetched tile becomes drawable. */
    private readonly invalidate: () => void,
    /** Maps a class VALUE to the same color the raw path uses. */
    private readonly colorFor: (key: string | number) => [number, number, number]
  ) {
    this.program = createProgram(gl, AGG_VS, AGG_FS, "aggregates");
    this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
    this.uNodeRadiusPx = gl.getUniformLocation(this.program, "u_nodeRadiusPx");
    this.uBinPx = gl.getUniformLocation(this.program, "u_binPx");
    this.uAlpha = gl.getUniformLocation(this.program, "u_alpha");
    this.uPalette = gl.getUniformLocation(this.program, "u_palette");
    this.uClassCount = gl.getUniformLocation(this.program, "u_classCount");
    this.uOutlineWidthPx = gl.getUniformLocation(this.program, "u_nodeOutlineWidthPx");
    this.uOutlineWhite = gl.getUniformLocation(this.program, "u_nodeOutlineWhite");
  }

  setSource(source: AggregateTileSource | null): void {
    if (source === this.source) return;
    this.source = source;
    this.palette = null;
    for (const t of this.resident.values()) this.dropTile(t);
    this.resident.clear();
    this.inFlight.clear();
  }

  hasSource(): boolean {
    return this.source !== null;
  }

  /** The prep-time column the aggregate classes were derived from — the only
   * color encoding this layer can represent (issue #315 color-by fix). */
  colorColumn(): string | null {
    return this.source?.meta.colorColumn ?? null;
  }

  /** True when the pyramid has at most one class (derive_point_classes'
   * missing/uniform-column marker) — every splat then renders the same
   * default color a NO-encoding raw pass would, so the two are visually
   * interchangeable (issue #315 color-by UX). */
  hasDegenerateClasses(): boolean {
    return (this.source?.meta.classes.length ?? 0) <= 1;
  }

  /**
   * The shallowest pyramid level whose bins are ≤ 1 output pixel at the
   * current scale (contract #1), or null past the deepest level — the
   * caller draws real geometry there. Unlike the raster tile client this
   * CEILs instead of rounding: stretched textures fill their rect either
   * way, but point splats smaller than the bin pitch leave a visible
   * sub-pixel lattice in dense regions when bins exceed a pixel.
   */
  levelFor(transformMatrix: Float32Array, canvasWidth: number): number | null {
    const meta = this.source?.meta;
    if (!meta) return null;
    const pxPerUnit = (Math.abs(transformMatrix[0]) * canvasWidth) / 2;
    const spanX = meta.maxX - meta.minX;
    const ideal = Math.ceil(Math.log2(Math.max(1e-9, (spanX * pxPerUnit) / meta.binsPerTile)));
    if (ideal > meta.maxLevel) return null;
    return Math.max(0, ideal);
  }

  /**
   * Draw the aggregate splats for the viewport at the active level. Returns
   * false when the layer cannot serve this frame EXACTLY (no source, zoomed
   * past the pyramid, or any covering tile not yet resident — fetches are
   * kicked and invalidate() re-renders when they land); the caller then
   * draws the raw node pass instead.
   */
  draw(transformMatrix: Float32Array, canvasWidth: number, params: AggregateDrawParams): boolean {
    const source = this.source;
    const meta = source?.meta;
    if (!source || !meta) return false;
    // Level from the full-quality width (see AggregateDrawParams.levelCanvasWidth).
    const z = this.levelFor(transformMatrix, params.levelCanvasWidth);
    if (z === null) return false;

    // Viewport in data space: clip corners through the inverse transform.
    const m = transformMatrix;
    const a = m[0], d = m[4], tx = m[6], ty = m[7];
    if (!a || !d) return false;
    const dataX = (clipX: number) => (clipX - tx) / a;
    const dataY = (clipY: number) => (clipY - ty) / d;
    const vx0 = Math.min(dataX(-1), dataX(1));
    const vx1 = Math.max(dataX(-1), dataX(1));
    const vy0 = Math.min(dataY(-1), dataY(1));
    const vy1 = Math.max(dataY(-1), dataY(1));

    const grid = 1 << z;
    const spanX = (meta.maxX - meta.minX) / grid;
    const spanY = (meta.maxY - meta.minY) / grid;
    const cx0 = Math.max(0, Math.floor((vx0 - meta.minX) / spanX));
    const cx1 = Math.min(grid - 1, Math.floor((vx1 - meta.minX) / spanX));
    // Tile row 0 is the TOP of the bbox.
    const cy0 = Math.max(0, Math.floor((meta.maxY - vy1) / spanY));
    const cy1 = Math.min(grid - 1, Math.floor((meta.maxY - vy0) / spanY));
    if (cx1 < cx0 || cy1 < cy0) return true; // viewport fully outside bbox

    // All-or-nothing: collect the covering set; kick fetches for gaps.
    const cover: ResidentAggTile[] = [];
    let complete = true;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${z}/${cx}/${cy}`;
        const tile = this.resident.get(key);
        if (tile) {
          cover.push(tile);
        } else {
          complete = false;
          this.fetchTile(source, key, z, cx, cy);
        }
      }
    }
    if (!complete) return false;

    const gl = this.gl;
    if (!this.palette) this.buildPalette(meta.classes);
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uMatrix, false, m);
    gl.uniform1f(this.uNodeRadiusPx, params.pointSizePx);
    // Bin pitch in device px at the active level (≤ 1 by level selection,
    // but computed exactly — the shader sizes multi-member squares to it).
    const pxPerUnit = (Math.abs(a) * canvasWidth) / 2;
    gl.uniform1f(this.uBinPx, (spanX / meta.binsPerTile) * pxPerUnit);
    gl.uniform1f(this.uAlpha, params.alpha);
    gl.uniform1f(this.uOutlineWidthPx, params.outlineWidthPx);
    gl.uniform1i(this.uOutlineWhite, params.outlineWhite ? 1 : 0);
    gl.uniform3fv(this.uPalette, this.palette!);
    gl.uniform1i(this.uClassCount, Math.min(this.source!.meta.classes.length, MAX_PALETTE));
    this.useCounter++;
    for (const tile of cover) {
      tile.lastUsed = this.useCounter;
      if (!tile.vao || tile.count === 0) continue;
      gl.bindVertexArray(tile.vao);
      gl.drawArrays(gl.POINTS, 0, tile.count);
    }
    gl.bindVertexArray(null);
    this.evict();
    return true;
  }

  private buildPalette(classes: (string | number)[]): void {
    const n = Math.min(classes.length, MAX_PALETTE);
    const palette = new Float32Array(MAX_PALETTE * 3);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = this.colorFor(classes[i]);
      palette[i * 3] = r;
      palette[i * 3 + 1] = g;
      palette[i * 3 + 2] = b;
    }
    this.palette = palette;
  }

  private fetchTile(source: AggregateTileSource, key: string, z: number, x: number, y: number): void {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void source.getTile(z, x, y).then((tile: AggregateTile | null) => {
      this.inFlight.delete(key);
      // Source swapped while fetching (or transient failure) — drop silently.
      if (this.source !== source || !tile) return;
      this.resident.set(key, this.uploadTile(tile));
      this.invalidate();
    });
  }

  private uploadTile(tile: AggregateTile): ResidentAggTile {
    if (tile.count === 0) {
      return { vao: null, buffer: null, count: 0, lastUsed: this.useCounter };
    }
    const gl = this.gl;
    const n = tile.count;
    // Interleaved x, y, weight, class — weight as f32 is exact below 2^24,
    // far above any per-bin member count.
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = tile.xs[i];
      data[i * 4 + 1] = tile.ys[i];
      data[i * 4 + 2] = tile.weights[i];
      data[i * 4 + 3] = tile.classes[i];
    }
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return { vao, buffer, count: n, lastUsed: this.useCounter };
  }

  private dropTile(tile: ResidentAggTile): void {
    if (tile.vao) this.gl.deleteVertexArray(tile.vao);
    if (tile.buffer) this.gl.deleteBuffer(tile.buffer);
  }

  private evict(): void {
    if (this.resident.size <= RESIDENT_CAP) return;
    const entries = [...this.resident.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = this.resident.size - RESIDENT_CAP;
    for (let i = 0; i < drop; i++) {
      this.dropTile(entries[i][1]);
      this.resident.delete(entries[i][0]);
    }
  }

  dispose(): void {
    this.setSource(null);
  }
}
