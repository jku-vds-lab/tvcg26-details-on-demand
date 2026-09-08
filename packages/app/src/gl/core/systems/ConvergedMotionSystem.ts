// packages/app/src/gl/core/systems/ConvergedMotionSystem.ts
//
// GPU executor of the converged DoI alternation for slider MOTION frames
// (plan-gpu-motion-lane.md). Owns the compute programs, the per-field static
// textures and the ping-pong work targets; `run()` renders the converged
// field straight INTO the renderer's opacity texture, so a preview tick is
// GPU passes + one shared-texture handoff — no CPU field math, no upload.
// The CPU engine (convergedField.ts) is the semantic authority: pass
// structure and formulas mirror it 1:1 (see convergedMotion.ts), fixed
// CONV_MAX_ROUNDS rounds instead of the eps early-exit (a readback would
// stall the pipe; extra rounds past the fixed point are no-ops — every stage
// is a monotone fold).
//
// Requires float-renderable R32F/RGBA32F targets (EXT_color_buffer_float —
// the same probe the HDR scene target uses). All GL state this system
// touches (blend/depth/viewport/FBO/program/textures) is restored to the
// neutral state drawScene re-establishes per frame.

import { createProgram } from "../../resources/ShaderProgram";
import {
  convergedQuadVertexSource,
  convergedInitFragmentSource,
  convergedChainFragmentSource,
  convergedScatterVertexSource,
  convergedScatterFragmentSource,
  convergedJfaFragmentSource,
  convergedGatherFragmentSource,
  convergedPresentFragmentSource,
  convergedBlendFragmentSource,
} from "../../shaders/convergedMotion";
import { CONV_EPS, CONV_MAX_ROUNDS } from "../../../doiPropagation/convergedField";
import { FALLOFF_DIST_SENTINEL } from "../../../doiPropagation/falloff";

/** Per-field static inputs (uploaded once per field revision). */
export interface ConvergedMotionFieldData {
  /** Record count (≤ texW·texH; the tail pads with inert values). */
  n: number;
  /** Record-texture dims — MUST equal the renderer's opacity texture dims. */
  texW: number;
  texH: number;
  recordDist: Float32Array;
  seedIdx: ArrayLike<number>;
  /** CPU raster (fieldDistanceCore.rasterize output — the cached per-field
   * raster the CPU lanes share). */
  raster: {
    rows: Int32Array;
    cols: Int32Array;
    frows: Float64Array;
    fcols: Float64Array;
    W: number;
    H: number;
    cellSize: number;
  };
  /** Chain doubling tables (chainJumpTables.buildChainJumpTables). */
  levels: number;
  predJumps: Int32Array;
  succJumps: Int32Array;
}

/** The caller-facing shape (hook side): the record-texture dims are the
 * RENDERER's concern (they must equal its opacity texture dims), injected by
 * webglRenderer.setConvergedMotionField. */
export type ConvergedMotionFieldInput = Omit<
  ConvergedMotionFieldData,
  "texW" | "texH"
>;

/** Per-tick params — all CPU-precomputed so the GLSL stays branch-light.
 * `mode`/`sScaled`/`invMaxEmb` are computeFalloffPreviewParams' contract;
 * `scaleD` = falloffScale(prox)·maxEmb feeds f⁻¹; `maxDist` =
 * falloffInverse(CONV_RESPREAD_FLOOR, …) is the futility crop. */
export interface ConvergedMotionTickParams {
  shapeCode: number;
  sScaled: number;
  invMaxEmb: number;
  mode: 1 | 2 | 3;
  past: number;
  future: number;
  scaleD: number;
  maxDist: number;
}

interface Programs {
  init: WebGLProgram;
  chain: WebGLProgram;
  scatter: WebGLProgram;
  jfa: WebGLProgram;
  gather: WebGLProgram;
  present: WebGLProgram;
  blend: WebGLProgram;
}

/** Memoized getUniformLocation — a tick issues ~50 uniform writes and the
 * lookups are pure per program. */
const ulocCache = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
function uloc(gl: WebGL2RenderingContext, p: WebGLProgram, name: string) {
  let perProgram = ulocCache.get(p);
  if (!perProgram) {
    perProgram = new Map();
    ulocCache.set(p, perProgram);
  }
  let loc = perProgram.get(name);
  if (loc === undefined) {
    loc = gl.getUniformLocation(p, name);
    perProgram.set(name, loc);
  }
  return loc;
}

function makeTexture(
  gl: WebGL2RenderingContext,
  internal: number,
  W: number,
  H: number,
  format: number,
  type: number,
  data: ArrayBufferView | null
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, W, H, 0, format, type, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

export class ConvergedMotionSystem {
  private programs: Programs | null = null;
  // Static per-field textures.
  private texDist: WebGLTexture | null = null;
  private texSeed: WebGLTexture | null = null;
  private texRaster: WebGLTexture | null = null;
  private texJumpPred: WebGLTexture | null = null;
  private texJumpSucc: WebGLTexture | null = null;
  // THREE rotating field buffers — per round, the round-start buffer stays
  // untouched as the scatter's raised-only reference (the CPU loop's
  // `before`) while the chain passes ping-pong the other two, and the gather
  // reuses the round-start slot as its target (safe: the scatter draw
  // ordered before it already consumed it). No per-round copy pass.
  private vTex: Array<WebGLTexture | null> = [null, null, null];
  private vFbo: Array<WebGLFramebuffer | null> = [null, null, null];
  private gridTex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private gridFbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  private gridDepth: WebGLRenderbuffer | null = null;
  private presentFbo: WebGLFramebuffer | null = null;
  private presentTarget: WebGLTexture | null = null;
  // Truth blend (§5b): the worker's exact field, uploaded per arrival, and a
  // SNAPSHOT of the opacity texture taken at fade start — the blend's FROM
  // side. Blending from the resident GPU field instead popped the screen
  // back to the preview whenever a fade started while the screen already
  // showed an exact field (the settle-after-truth double-pulse, CS feel
  // round 3); from-the-screen makes any same-field fade a visual no-op.
  private exactTex: WebGLTexture | null = null;
  private exactScratch: Float32Array | null = null;
  private fromTex: WebGLTexture | null = null;
  private fromFbo: WebGLFramebuffer | null = null;

  private n = 0;
  private texW = 0;
  private texH = 0;
  private gridW = 0;
  private gridH = 0;
  private cellSize = 0;
  private levels = 0;
  /** Index of the v ping-pong texture holding the latest result. */
  private cur = 0;
  private broken = false;
  // ── Adaptive round count (occlusion feedback) ─────────────────────────────
  // The CPU loop stops when a round's chain raises nothing; the GPU cannot
  // read that back without stalling, so an ANY_SAMPLES_PASSED_CONSERVATIVE
  // query brackets each round's SCATTER draw and the NEXT tick polls the
  // results: rounds = (deepest round that scattered anything) + 1 headroom.
  // The estimate lags one tick and ratchets up one round per tick when
  // saturated — a transient under-convergence the exact CPU flush at rest
  // supersedes anyway. Measured: chess drags settle to ~6-7 of the 12-round
  // ceiling, nearly halving the grid-pass bill.
  private roundQueries: WebGLQuery[] = [];
  private queriesIssued = 0;
  private queriesPending = false;
  private roundsEstimate = CONV_MAX_ROUNDS;
  // ── Tick-cost fence (adaptive raster res, gpuMotionAdaptiveRes.ts) ────────
  // The CPU-side encode is ~0.2 ms regardless of GPU speed, so the only
  // honest tick-cost signal is a sync fence after the tick's submission:
  // time-to-signal ≈ the GPU's queue latency for this tick (a saturated
  // queue pushes it far past a frame). One fence at a time — while one is
  // pending, later ticks skip fencing, so the sample naturally includes the
  // backlog those ticks created. Poll granularity is the caller's (per rAF).
  private tickFence: WebGLSync | null = null;
  private tickFenceStart = 0;

  constructor(private gl: WebGL2RenderingContext) {}

  ready(): boolean {
    return !this.broken && this.texDist !== null;
  }

  /** Upload the per-field static state. Returns false (and clears) when the
   * inputs cannot be represented (jump texture rows past MAX_TEXTURE_SIZE) or
   * program compilation fails — the caller then keeps the worker lane. */
  setField(data: ConvergedMotionFieldData | null): boolean {
    this.clearField();
    if (!data || this.broken) return false;
    const gl = this.gl;
    if (!this.ensurePrograms()) return false;
    const { texW, texH, n } = data;
    const maxSide = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (
      texW * texH < n ||
      texW > maxSide ||
      Math.max(1, data.levels) * texH > maxSide ||
      data.raster.W > maxSide ||
      data.raster.H > maxSide
    ) {
      return false;
    }
    const size = texW * texH;

    // Record distances, +Inf sanitized to the sentinel; tail padded with the
    // sentinel so tail texels evaluate to 0 (they are never fetched anyway).
    const dist = new Float32Array(size).fill(FALLOFF_DIST_SENTINEL);
    for (let i = 0; i < n; i++) {
      const d = data.recordDist[i];
      dist[i] = d < FALLOFF_DIST_SENTINEL ? d : FALLOFF_DIST_SENTINEL;
    }
    const seed = new Float32Array(size);
    for (let k = 0; k < data.seedIdx.length; k++) seed[data.seedIdx[k]] = 1;
    const raster = new Float32Array(size * 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      raster[o] = data.raster.fcols[i];
      raster[o + 1] = data.raster.frows[i];
      raster[o + 2] = data.raster.cols[i];
      raster[o + 3] = data.raster.rows[i];
    }
    // Jump tables, level-major rows; a chain-free dataset (levels 0) still
    // allocates one all -1 level so the sampler is complete.
    const levels = Math.max(1, data.levels);
    const packJumps = (src: Int32Array): Int32Array => {
      const out = new Int32Array(size * levels).fill(-1);
      for (let k = 0; k < data.levels; k++) {
        for (let i = 0; i < n; i++) out[k * size + i] = src[k * n + i];
      }
      return out;
    };

    try {
      this.texDist = makeTexture(gl, gl.R32F, texW, texH, gl.RED, gl.FLOAT, dist);
      this.texSeed = makeTexture(gl, gl.R32F, texW, texH, gl.RED, gl.FLOAT, seed);
      this.texRaster = makeTexture(gl, gl.RGBA32F, texW, texH, gl.RGBA, gl.FLOAT, raster);
      this.texJumpPred = makeTexture(
        gl, gl.R32I, texW, texH * levels, gl.RED_INTEGER, gl.INT, packJumps(data.predJumps)
      );
      this.texJumpSucc = makeTexture(
        gl, gl.R32I, texW, texH * levels, gl.RED_INTEGER, gl.INT, packJumps(data.succJumps)
      );
      for (let s = 0; s < 3; s++) {
        this.vTex[s] = makeTexture(gl, gl.R32F, texW, texH, gl.RED, gl.FLOAT, null);
        const fbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.vTex[s], 0
        );
        this.vFbo[s] = fbo;
      }
      for (let s = 0; s < 2; s++) {
        this.gridTex[s] = makeTexture(
          gl, gl.RG32F, data.raster.W, data.raster.H, gl.RG, gl.FLOAT, null
        );
        const gfbo = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, gfbo);
        gl.framebufferTexture2D(
          gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.gridTex[s], 0
        );
        this.gridFbo[s] = gfbo;
      }
      // Depth for the scatter's co-cell min-offset resolve (grid slot 0 only —
      // the scatter always targets slot 0, JFA ping-pongs from there).
      this.exactTex = makeTexture(gl, gl.R32F, texW, texH, gl.RED, gl.FLOAT, null);
      this.fromTex = makeTexture(gl, gl.R32F, texW, texH, gl.RED, gl.FLOAT, null);
      this.fromFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fromFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fromTex, 0
      );
      this.gridDepth = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.gridDepth);
      gl.renderbufferStorage(
        gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, data.raster.W, data.raster.H
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gridFbo[0]);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.gridDepth
      );
      const complete =
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      if (!complete) {
        // Float targets not renderable on this stack — permanent fallback.
        this.broken = true;
        this.clearField();
        return false;
      }
    } catch {
      this.broken = true;
      this.clearField();
      return false;
    }

    this.n = n;
    this.texW = texW;
    this.texH = texH;
    this.gridW = data.raster.W;
    this.gridH = data.raster.H;
    this.cellSize = data.raster.cellSize;
    this.levels = data.levels;
    return true;
  }

  /**
   * One converged tick into `target` (the renderer's opacity texture, whose
   * dims must match the field's record dims). Returns false when the system
   * is not ready or the dims mismatch — the caller falls back to the worker.
   */
  run(params: ConvergedMotionTickParams, target: WebGLTexture, targetW: number, targetH: number): boolean {
    const gl = this.gl;
    const p = this.programs;
    if (!p || !this.ready()) return false;
    if (targetW !== this.texW || targetH !== this.texH) return false;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);

    // Static textures on fixed units; ping-pong sources bound per pass on 0/1.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texDist);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.texSeed);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.texRaster);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.texJumpPred);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.texJumpSucc);

    const bindV = (slot: number, unit: number) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.vTex[slot]);
    };
    const bindGrid = (slot: number, unit: number) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.gridTex[slot]);
    };
    const recordViewport = () => gl.viewport(0, 0, this.texW, this.texH);
    const gridViewport = () => gl.viewport(0, 0, this.gridW, this.gridH);

    // ── Init: v = f(D) + seed clamp → v[0] ──────────────────────────────────
    let cur = 0;
    gl.useProgram(p.init);
    gl.uniform1i(uloc(gl, p.init, "u_dist"), 2);
    gl.uniform1i(uloc(gl, p.init, "u_seed"), 3);
    gl.uniform1i(uloc(gl, p.init, "u_shape"), params.shapeCode);
    gl.uniform1f(uloc(gl, p.init, "u_sScaled"), params.sScaled);
    gl.uniform1f(uloc(gl, p.init, "u_invMaxEmb"), params.invMaxEmb);
    gl.uniform1i(uloc(gl, p.init, "u_mode"), params.mode);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vFbo[cur]);
    recordViewport();
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The CPU's spatialFinite guard: no finite spatial term at the endpoints —
    // the trailing chain closure still runs once (rounds collapse to 1).
    const spatial = params.mode === 1 && params.invMaxEmb > 0;

    // Poll last tick's occlusion queries (non-blocking): rounds this tick =
    // deepest round that scattered + 1 headroom, ratcheting up when saturated.
    if (this.queriesPending) {
      let allDone = true;
      for (let r = 0; r < this.queriesIssued; r++) {
        if (!gl.getQueryParameter(this.roundQueries[r], gl.QUERY_RESULT_AVAILABLE)) {
          allDone = false;
          break;
        }
      }
      if (allDone) {
        let deepest = 0;
        for (let r = 0; r < this.queriesIssued; r++) {
          if (gl.getQueryParameter(this.roundQueries[r], gl.QUERY_RESULT)) {
            deepest = r + 1;
          }
        }
        const saturated = deepest >= this.queriesIssued;
        this.roundsEstimate = Math.min(
          CONV_MAX_ROUNDS,
          Math.max(2, saturated ? this.queriesIssued + 1 : deepest + 1)
        );
        this.queriesPending = false;
      }
    }
    const rounds = spatial ? this.roundsEstimate : 1;
    const issueQueries = spatial && !this.queriesPending;
    if (issueQueries) {
      while (this.roundQueries.length < rounds) {
        this.roundQueries.push(gl.createQuery()!);
      }
    }

    // JFA step schedule: halving from the futility-crop radius in cells (no
    // candidate is useful past it), plus one clean-up 1-step.
    const steps: number[] = [];
    if (spatial) {
      const span = Math.min(
        Math.max(this.gridW, this.gridH),
        Math.max(1, Math.ceil(params.maxDist / Math.max(this.cellSize, 1e-30)))
      );
      let s = 1;
      while (s < span) s <<= 1;
      for (s >>= 1; s >= 1; s >>= 1) steps.push(s);
      steps.push(1);
    }

    for (let round = 0; round < rounds; round++) {
      // The round-start buffer stays untouched through the chain: it is the
      // raised-only scatter's `before` reference. Chain passes ping-pong the
      // two other buffers; the gather writes back into the round-start slot.
      const snap = cur;

      // ── Chain closure: fused doubling passes (both directions per level) ──
      const gainF0 = params.future > 0 ? Math.min(params.future, 1) : 0;
      const gainP0 = params.past > 0 ? Math.min(params.past, 1) : 0;
      if (this.levels > 0 && (gainF0 > 0 || gainP0 > 0)) {
        gl.useProgram(p.chain);
        const uV = uloc(gl, p.chain, "u_v");
        gl.uniform1i(uloc(gl, p.chain, "u_jumpPred"), 5);
        gl.uniform1i(uloc(gl, p.chain, "u_jumpSucc"), 6);
        const uLevel = uloc(gl, p.chain, "u_level");
        const uGainF = uloc(gl, p.chain, "u_gainF");
        const uGainP = uloc(gl, p.chain, "u_gainP");
        gl.uniform1i(uloc(gl, p.chain, "u_rows"), this.texH);
        gl.uniform1i(uloc(gl, p.chain, "u_texW"), this.texW);
        recordViewport();
        const scratchA = (snap + 1) % 3;
        const scratchB = (snap + 2) % 3;
        let gainF = gainF0;
        let gainP = gainP0;
        for (let k = 0; k < this.levels; k++) {
          gl.uniform1i(uLevel, k);
          gl.uniform1f(uGainF, gainF);
          gl.uniform1f(uGainP, gainP);
          bindV(cur, 0);
          gl.uniform1i(uV, 0);
          const dst = cur === scratchA ? scratchB : scratchA;
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.vFbo[dst]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          cur = dst;
          gainF *= gainF;
          gainP *= gainP;
        }
      }

      if (!spatial) break;

      // ── Scatter: the round's chain-raised records → grid[0] (min-offset
      // depth argmin; raised-only vs the round-start buffer, the CPU loop's
      // exact source set) ───────────────────────────────────────────────────
      gl.useProgram(p.scatter);
      gl.uniform1i(uloc(gl, p.scatter, "u_v"), 0);
      bindV(cur, 0);
      gl.uniform1i(uloc(gl, p.scatter, "u_vBefore"), 1);
      bindV(snap, 1);
      gl.uniform1i(uloc(gl, p.scatter, "u_raster"), 4);
      gl.uniform1i(uloc(gl, p.scatter, "u_texW"), this.texW);
      gl.uniform2f(uloc(gl, p.scatter, "u_gridDim"), this.gridW, this.gridH);
      gl.uniform1i(uloc(gl, p.scatter, "u_shape"), params.shapeCode);
      gl.uniform1f(uloc(gl, p.scatter, "u_scaleD"), params.scaleD);
      gl.uniform1f(uloc(gl, p.scatter, "u_maxDist"), params.maxDist);
      gl.uniform1f(uloc(gl, p.scatter, "u_eps"), CONV_EPS);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.gridFbo[0]);
      gridViewport();
      gl.clearColor(-1, 0, 0, 0); // packedCell < 0 = empty cell
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      if (issueQueries) {
        gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, this.roundQueries[round]);
      }
      gl.drawArrays(gl.POINTS, 0, this.n);
      if (issueQueries) gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      gl.disable(gl.DEPTH_TEST);

      // ── JFA over the candidate grid ───────────────────────────────────────
      gl.useProgram(p.jfa);
      gl.uniform1i(uloc(gl, p.jfa, "u_grid"), 1);
      gl.uniform2i(uloc(gl, p.jfa, "u_gridDim"), this.gridW, this.gridH);
      gl.uniform1f(uloc(gl, p.jfa, "u_cellSize"), this.cellSize);
      const uStep = uloc(gl, p.jfa, "u_step");
      let gcur = 0;
      for (const step of steps) {
        gl.uniform1i(uStep, step);
        bindGrid(gcur, 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.gridFbo[1 - gcur]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gcur = 1 - gcur;
      }

      // ── Gather + fold back into the record field ─────────────────────────
      gl.useProgram(p.gather);
      gl.uniform1i(uloc(gl, p.gather, "u_v"), 0);
      gl.uniform1i(uloc(gl, p.gather, "u_grid"), 1);
      gl.uniform1i(uloc(gl, p.gather, "u_raster"), 4);
      gl.uniform2i(uloc(gl, p.gather, "u_gridDim"), this.gridW, this.gridH);
      gl.uniform1f(uloc(gl, p.gather, "u_cellSize"), this.cellSize);
      gl.uniform1f(uloc(gl, p.gather, "u_maxDist"), params.maxDist);
      gl.uniform1i(uloc(gl, p.gather, "u_shape"), params.shapeCode);
      gl.uniform1f(uloc(gl, p.gather, "u_sScaled"), params.sScaled);
      gl.uniform1f(uloc(gl, p.gather, "u_invMaxEmb"), params.invMaxEmb);
      gl.uniform1i(uloc(gl, p.gather, "u_mode"), params.mode);
      bindV(cur, 0);
      bindGrid(gcur, 1);
      // Reuse the round-start slot as the gather target (already consumed by
      // the ordered scatter draw). A chain-free round leaves cur === snap —
      // sampling and rendering the same texture is a feedback loop, so
      // divert to a scratch slot then.
      const dst = cur === snap ? (snap + 1) % 3 : snap;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.vFbo[dst]);
      recordViewport();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      cur = dst;
    }

    if (issueQueries) {
      this.queriesIssued = rounds;
      this.queriesPending = true;
    }

    // ── Present into the renderer's opacity texture ───────────────────────
    if (!this.presentFbo) this.presentFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.presentFbo);
    if (this.presentTarget !== target) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0
      );
      this.presentTarget = target;
    }
    gl.useProgram(p.present);
    gl.uniform1i(uloc(gl, p.present, "u_v"), 0);
    bindV(cur, 0);
    recordViewport();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = cur;

    // Tick-cost fence: only when none is pending (see the field comment).
    if (!this.tickFence) {
      this.tickFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.tickFenceStart = performance.now();
      gl.flush(); // the fence must reach the GPU even before the next present
    }

    // Neutral state back (drawScene re-establishes its own per frame).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let u = 6; u >= 0; u--) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.useProgram(null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    return true;
  }

  /**
   * Snapshot the CURRENT on-screen field (the opacity texture) as the blend's
   * FROM side. Called at fade start, right after uploadExact — a fade then
   * always departs from exactly what the viewer sees, so re-fading toward a
   * field the screen already shows changes nothing.
   */
  snapshotBlendSource(source: WebGLTexture, srcW: number, srcH: number): boolean {
    const gl = this.gl;
    const p = this.programs;
    if (!p || !this.ready() || !this.fromFbo) return false;
    if (srcW !== this.texW || srcH !== this.texH) return false;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    gl.useProgram(p.present);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(uloc(gl, p.present, "u_v"), 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fromFbo);
    gl.viewport(0, 0, this.texW, this.texH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    return true;
  }

  /** Upload the worker's EXACT converged field for the truth blend. Padded to
   * the record-texture size via a reused scratch. */
  uploadExact(values: Float32Array): boolean {
    const gl = this.gl;
    if (!this.ready() || !this.exactTex || values.length < this.n) return false;
    const size = this.texW * this.texH;
    let scratch = this.exactScratch;
    if (!scratch || scratch.length !== size) {
      scratch = new Float32Array(size);
      this.exactScratch = scratch;
    }
    scratch.set(values.subarray(0, Math.min(values.length, size)));
    gl.bindTexture(gl.TEXTURE_2D, this.exactTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, this.texW, this.texH, gl.RED, gl.FLOAT, scratch
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return true;
  }

  /**
   * One truth-blend frame into `target`: mix(residentGpuField, exactField, t).
   * Requires a GPU field from run() this revision and a prior uploadExact.
   * t = 1 renders the exact field verbatim.
   */
  blendExact(t: number, target: WebGLTexture, targetW: number, targetH: number): boolean {
    const gl = this.gl;
    const p = this.programs;
    if (!p || !this.ready() || !this.exactTex || !this.fromTex) return false;
    if (targetW !== this.texW || targetH !== this.texH) return false;

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);

    if (!this.presentFbo) this.presentFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.presentFbo);
    if (this.presentTarget !== target) {
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0
      );
      this.presentTarget = target;
    }
    gl.useProgram(p.blend);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fromTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.exactTex);
    gl.uniform1i(uloc(gl, p.blend, "u_v"), 0);
    gl.uniform1i(uloc(gl, p.blend, "u_exact"), 1);
    gl.uniform1f(uloc(gl, p.blend, "u_t"), t < 0 ? 0 : t > 1 ? 1 : t);
    gl.viewport(0, 0, this.texW, this.texH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    return true;
  }

  /**
   * Poll the pending tick-cost fence: elapsed ms once the GPU signals it,
   * null while still pending, undefined when no fence is outstanding.
   * Non-blocking (SYNC_STATUS query, never clientWaitSync).
   */
  pollTickGpuMs(): number | null | undefined {
    if (!this.tickFence) return undefined;
    const gl = this.gl;
    const status = gl.getSyncParameter(this.tickFence, gl.SYNC_STATUS);
    if (status !== gl.SIGNALED) return null;
    const ms = performance.now() - this.tickFenceStart;
    gl.deleteSync(this.tickFence);
    this.tickFence = null;
    return ms;
  }

  /** Debug/bench readback of the last run's converged field (n values). NOT
   * for production paths — stalls the pipeline. */
  readback(): Float32Array | null {
    const gl = this.gl;
    if (!this.ready() || !this.vFbo[this.cur]) return null;
    const size = this.texW * this.texH;
    const rgba = new Float32Array(size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vFbo[this.cur]);
    try {
      gl.readPixels(0, 0, this.texW, this.texH, gl.RGBA, gl.FLOAT, rgba);
    } catch {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const out = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = rgba[i * 4];
    return out;
  }

  private ensurePrograms(): boolean {
    if (this.programs) return true;
    if (this.broken) return false;
    const gl = this.gl;
    try {
      this.programs = {
        init: createProgram(gl, convergedQuadVertexSource, convergedInitFragmentSource, "convergedMotion init"),
        chain: createProgram(gl, convergedQuadVertexSource, convergedChainFragmentSource, "convergedMotion chain"),
        scatter: createProgram(gl, convergedScatterVertexSource, convergedScatterFragmentSource, "convergedMotion scatter"),
        jfa: createProgram(gl, convergedQuadVertexSource, convergedJfaFragmentSource, "convergedMotion jfa"),
        gather: createProgram(gl, convergedQuadVertexSource, convergedGatherFragmentSource, "convergedMotion gather"),
        present: createProgram(gl, convergedQuadVertexSource, convergedPresentFragmentSource, "convergedMotion present"),
        blend: createProgram(gl, convergedQuadVertexSource, convergedBlendFragmentSource, "convergedMotion blend"),
      };
      return true;
    } catch {
      this.broken = true;
      this.programs = null;
      return false;
    }
  }

  private clearField(): void {
    const gl = this.gl;
    const del = (t: WebGLTexture | null) => t && gl.deleteTexture(t);
    del(this.texDist);
    del(this.texSeed);
    del(this.texRaster);
    del(this.texJumpPred);
    del(this.texJumpSucc);
    this.texDist = this.texSeed = this.texRaster = null;
    this.texJumpPred = this.texJumpSucc = null;
    for (let s = 0; s < 3; s++) {
      del(this.vTex[s]);
      if (this.vFbo[s]) gl.deleteFramebuffer(this.vFbo[s]);
      this.vTex[s] = null;
      this.vFbo[s] = null;
    }
    for (let s = 0; s < 2; s++) {
      del(this.gridTex[s]);
      if (this.gridFbo[s]) gl.deleteFramebuffer(this.gridFbo[s]);
      this.gridTex[s] = null;
      this.gridFbo[s] = null;
    }
    if (this.gridDepth) {
      gl.deleteRenderbuffer(this.gridDepth);
      this.gridDepth = null;
    }
    del(this.exactTex);
    this.exactTex = null;
    del(this.fromTex);
    this.fromTex = null;
    if (this.fromFbo) {
      gl.deleteFramebuffer(this.fromFbo);
      this.fromFbo = null;
    }
    if (this.tickFence) {
      gl.deleteSync(this.tickFence);
      this.tickFence = null;
    }
    // New field: forget the old drag's convergence depth (queries stay
    // reusable — re-beginning one discards its stale pending result).
    this.queriesPending = false;
    this.queriesIssued = 0;
    this.roundsEstimate = CONV_MAX_ROUNDS;
    if (this.presentFbo) {
      gl.deleteFramebuffer(this.presentFbo);
      this.presentFbo = null;
      this.presentTarget = null;
    }
    this.n = 0;
  }

  dispose(): void {
    this.clearField();
    const gl = this.gl;
    for (const q of this.roundQueries) gl.deleteQuery(q);
    this.roundQueries = [];
    if (this.programs) {
      for (const prog of Object.values(this.programs)) gl.deleteProgram(prog);
      this.programs = null;
    }
    this.broken = true;
  }
}
