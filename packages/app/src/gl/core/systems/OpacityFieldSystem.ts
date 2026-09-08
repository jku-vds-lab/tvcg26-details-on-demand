import type { DataPoint } from "../../../dataPreprocessing/dataPreprocessing";
import { columnsOf } from "../../../dataPreprocessing/pointColumns";

export class OpacityFieldSystem {
  private texScratch: Float32Array = new Float32Array(0);
  private scratchSize = 0;
  private quadScratch: Float32Array = new Float32Array(0);
  private quadScratchSize = 0;

  buildOpacityField(nodes: DataPoint[], maxNodes = nodes.length): Float32Array {
    const count = Math.max(0, Math.min(maxNodes, nodes.length));
    // Columnar fast path (issue #315 D2): one typed-array copy instead of
    // an O(n) per-object accessor walk.
    const cols = columnsOf(nodes);
    if (cols) return new Float32Array(cols.doi.subarray(0, count));
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = nodes[i].DoI ?? 0;
    return out;
  }

  computeTextureDims(gl: WebGL2RenderingContext, nodeCount: number): { W: number; H: number } {
    const maxTexSide = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const W = Math.min(nodeCount || 1, maxTexSide);
    const H = Math.max(1, Math.ceil((nodeCount || 1) / W));
    return { W, H };
  }

  private ensureScratch(W: number, H: number): void {
    const needed = W * H;
    if (needed === this.scratchSize) return;
    this.texScratch = new Float32Array(needed);
    this.scratchSize = needed;
  }

  /**
   * Four-channel (RGBA32F) sibling of uploadOpacityTexture for the GPU falloff
   * preview's frozen-chain field (issue #315): `quads` is INTERLEAVED
   * [D, srcDist, gain, seedChain] per point in record order, padded to W×H×4.
   * Separate scratch so a preview upload never disturbs the opacity scratch
   * (the ping-pong buffer the preview worker hands back relies on it).
   */
  uploadQuadTexture(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    W: number,
    H: number,
    quads: Float32Array,
    nodeCount: number,
    forceRealloc: boolean
  ): void {
    const needed = W * H * 4;
    if (this.quadScratchSize !== needed) {
      this.quadScratch = new Float32Array(needed);
      this.quadScratchSize = needed;
    }
    this.quadScratch.fill(0);
    const copyN = Math.min(quads.length, nodeCount * 4);
    this.quadScratch.set(quads.subarray(0, copyN), 0);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (forceRealloc) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, this.quadScratch);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, this.quadScratch);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  uploadOpacityTexture(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    W: number,
    H: number,
    values: Float32Array,
    nodeCount: number,
    forceRealloc: boolean
  ): void {
    this.ensureScratch(W, H);

    // Pad to W*H; clear to ensure unused tail is deterministic.
    this.texScratch.fill(0);
    const copyN = Math.min(values.length, nodeCount);
    this.texScratch.set(values.subarray(0, copyN), 0);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    if (forceRealloc) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, W, H, 0, gl.RED, gl.FLOAT, this.texScratch);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, this.texScratch);
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }
}
