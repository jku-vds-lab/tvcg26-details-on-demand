// packages/app/src/gl/core/tileLayer.ts
//
// Scatterplot raster-tile layer (issue #315 phase E — the map-client base
// imagery). Draws server-rendered tiles as textured quads in DATA space
// through the renderer's existing data→clip matrix, so at-rest frames on
// huge datasets stop costing O(dataset) GPU work: a settle frame becomes
// "draw ~a dozen cached textures". The source is injected (`@scaling`
// resolves it in the server build; the open-core stub never provides one), so
// this module stays open-core and dataset-agnostic.
//
// Shader I/O: a_corner (location 0) = unit-quad corner in [0,1]^2;
// u_matrix = the renderer's 3×3 data→clip transform (column-major);
// u_rect = (x0, y0, spanX, spanY) of the tile in data space (y0 = BOTTOM);
// u_tex = the tile texture on TEXTURE6. Tile image row 0 is the TOP of the
// tile, so v = 1 − corner.y.

import type { ScatterTileSource } from "src/scaling.types";
import { createProgram } from "../resources/ShaderProgram";

const TILE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
uniform mat3 u_matrix;
uniform vec4 u_rect;
uniform vec4 u_uvRect; // (u0, v0, uSpan, vSpan) — ancestor-tile sub-region
out vec2 v_uv;
void main() {
  vec2 dataPos = u_rect.xy + a_corner * u_rect.zw;
  vec3 clip = u_matrix * vec3(dataPos, 1.0);
  v_uv = vec2(
    u_uvRect.x + a_corner.x * u_uvRect.z,
    u_uvRect.y + (1.0 - a_corner.y) * u_uvRect.w
  );
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}`;

const TILE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`;

const RESIDENT_CAP = 96;

interface ResidentTile {
  tex: WebGLTexture;
  lastUsed: number;
}

export class TileLayer {
  private source: ScatterTileSource | null = null;
  private readonly resident = new Map<string, ResidentTile>();
  private readonly inFlight = new Set<string>();
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uMatrix: WebGLUniformLocation | null;
  private readonly uRect: WebGLUniformLocation | null;
  private readonly uUvRect: WebGLUniformLocation | null;
  private readonly uTex: WebGLUniformLocation | null;
  private useCounter = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /** Re-render request — called when a fetched tile becomes drawable. */
    private readonly invalidate: () => void
  ) {
    this.program = createProgram(gl, TILE_VS, TILE_FS, "tiles");
    this.uMatrix = gl.getUniformLocation(this.program, "u_matrix");
    this.uRect = gl.getUniformLocation(this.program, "u_rect");
    this.uUvRect = gl.getUniformLocation(this.program, "u_uvRect");
    this.uTex = gl.getUniformLocation(this.program, "u_tex");
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  setSource(source: ScatterTileSource | null): void {
    if (source === this.source) return;
    this.source = source;
    for (const t of this.resident.values()) this.gl.deleteTexture(t.tex);
    this.resident.clear();
    this.inFlight.clear();
  }

  hasSource(): boolean {
    return this.source !== null;
  }

  /** The prep-time column the tiles were colored by, when the source's meta
   * carries it (issue #315 color-by fix); null for legacy sources. */
  colorColumn(): string | null {
    return this.source?.meta.colorColumn ?? null;
  }

  /**
   * The pyramid level whose tiles render ~1:1 at the current scale, or null
   * when the view is zoomed past the deepest level (caller then draws real
   * geometry — the visible point count is small there).
   */
  levelFor(transformMatrix: Float32Array, canvasWidth: number): number | null {
    const meta = this.source?.meta;
    if (!meta) return null;
    const pxPerUnit = (Math.abs(transformMatrix[0]) * canvasWidth) / 2;
    const spanX = meta.maxX - meta.minX;
    const ideal = Math.round(Math.log2(Math.max(1e-9, (spanX * pxPerUnit) / meta.tilePx)));
    if (ideal > meta.maxZoom) return null;
    return Math.max(0, ideal);
  }

  /**
   * Draw every resident tile covering the viewport at the level for the
   * current scale; kick fetches for missing ones (invalidate() re-renders
   * when they land). Returns false when the layer cannot serve this frame
   * (no source, or zoomed past the pyramid) — the caller falls back to
   * geometry.
   */
  draw(transformMatrix: Float32Array, canvasWidth: number): boolean {
    const source = this.source;
    const meta = source?.meta;
    if (!source || !meta) return false;
    const z = this.levelFor(transformMatrix, canvasWidth);
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

    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uMatrix, false, m);
    gl.activeTexture(gl.TEXTURE6);
    gl.uniform1i(this.uTex, 6);
    gl.bindVertexArray(this.vao);
    this.useCounter++;

    for (let ty2 = cy0; ty2 <= cy1; ty2++) {
      for (let tx2 = cx0; tx2 <= cx1; tx2++) {
        const key = `${z}/${tx2}/${ty2}`;
        const rectX = meta.minX + tx2 * spanX;
        const rectY = meta.maxY - (ty2 + 1) * spanY; // y0 = tile BOTTOM
        const tile = this.resident.get(key);
        if (tile) {
          tile.lastUsed = this.useCounter;
          gl.bindTexture(gl.TEXTURE_2D, tile.tex);
          gl.uniform4f(this.uRect, rectX, rectY, spanX, spanY);
          gl.uniform4f(this.uUvRect, 0, 0, 1, 1);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          continue;
        }
        this.fetchTile(source, key, z, tx2, ty2);
        // Ancestor fallback (map-style): stretch the nearest resident
        // coarser tile's sub-region until the exact tile lands, so level
        // transitions scale smoothly instead of leaving holes.
        for (let k = 1; k <= z; k++) {
          const ancestor = this.resident.get(`${z - k}/${tx2 >> k}/${ty2 >> k}`);
          if (!ancestor) continue;
          ancestor.lastUsed = this.useCounter;
          const frac = 1 / (1 << k);
          const u0 = (tx2 - ((tx2 >> k) << k)) * frac;
          const v0 = (ty2 - ((ty2 >> k) << k)) * frac;
          gl.bindTexture(gl.TEXTURE_2D, ancestor.tex);
          gl.uniform4f(this.uRect, rectX, rectY, spanX, spanY);
          gl.uniform4f(this.uUvRect, u0, v0, frac, frac);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          break;
        }
      }
    }
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    this.evict();
    return true;
  }

  private fetchTile(source: ScatterTileSource, key: string, z: number, x: number, y: number): void {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void source.getTile(z, x, y).then((bitmap) => {
      this.inFlight.delete(key);
      // Source swapped while fetching — drop silently.
      if (this.source !== source || !bitmap) return;
      const gl = this.gl;
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      bitmap.close?.();
      this.resident.set(key, { tex, lastUsed: this.useCounter });
      this.invalidate();
    });
  }

  private evict(): void {
    if (this.resident.size <= RESIDENT_CAP) return;
    const entries = [...this.resident.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = this.resident.size - RESIDENT_CAP;
    for (let i = 0; i < drop; i++) {
      this.gl.deleteTexture(entries[i][1].tex);
      this.resident.delete(entries[i][0]);
    }
  }

  dispose(): void {
    this.setSource(null);
  }
}
