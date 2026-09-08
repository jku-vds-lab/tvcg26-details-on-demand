// packages/app/src/gl/core/textures.ts
//
// Float data-texture upload helpers for the instanced edge pipeline
// (issue #315 phase B2). Node positions / node colors / per-edge control
// indices live in textures so the edge vertex shader can derive segment
// geometry per instance instead of the CPU expanding 4×16 floats per
// segment. Layout mirrors OpacityFieldSystem: row-major, W capped at
// MAX_TEXTURE_SIZE, index i at texel (i % W, i / W), NEAREST/no filtering,
// fetched with texelFetch.

export function computeDataTexDims(gl: WebGL2RenderingContext, count: number): { W: number; H: number } {
  const maxTexSide = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const W = Math.min(count || 1, maxTexSide);
  const H = Math.max(1, Math.ceil((count || 1) / W));
  return { W, H };
}

/**
 * Uploads `count` items of `srcChannels` floats each into a float texture of
 * `dstChannels` channels (2 → RG32F, 4 → RGBA32F), padding channels and the
 * W×H tail with zeros. Owns a reusable scratch buffer and remembers the last
 * allocation so it re-issues texImage2D only when dimensions change.
 */
export class FloatDataTexture {
  private scratch: Float32Array = new Float32Array(0);
  private lastW = 0;
  private lastH = 0;

  constructor(private readonly dstChannels: 2 | 4) {}

  upload(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    W: number,
    H: number,
    values: Float32Array,
    srcChannels: number,
    count: number
  ): void {
    const dst = this.dstChannels;
    const needed = W * H * dst;
    if (this.scratch.length !== needed) this.scratch = new Float32Array(needed);
    this.scratch.fill(0);

    const n = Math.min(count, Math.floor(values.length / srcChannels));
    if (srcChannels === dst) {
      this.scratch.set(values.subarray(0, n * dst), 0);
    } else {
      for (let i = 0; i < n; i++) {
        const s = i * srcChannels;
        const d = i * dst;
        for (let c = 0; c < srcChannels; c++) this.scratch[d + c] = values[s + c];
      }
    }

    const internalFormat = dst === 2 ? gl.RG32F : gl.RGBA32F;
    const format = dst === 2 ? gl.RG : gl.RGBA;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (W !== this.lastW || H !== this.lastH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, W, H, 0, format, gl.FLOAT, this.scratch);
      this.lastW = W;
      this.lastH = H;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, format, gl.FLOAT, this.scratch);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}

/** Creates an unfiltered data texture (NEAREST, CLAMP_TO_EDGE). */
export function createDataTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
