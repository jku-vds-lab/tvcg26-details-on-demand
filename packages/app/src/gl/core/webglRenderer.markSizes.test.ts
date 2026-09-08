// Visual-appearance regression suite (issue #315, CS 2026-07-26).
//
// Three reported regressions, all mechanised here so they cannot come back
// silently:
//   (a) `setStyle` must reach EVERY live draw path — the raw node pass, the
//       aggregate splat pass and the arrow pass — and a node-radius change
//       must actually MOVE the size on a >300k dataset (the density cap used
//       to swallow it whole).
//   (b/c) The interactive-quality reduction must not change APPARENT sizes:
//       it shrinks only the backing store, so device-px sizes must shrink with
//       it and the CSS-px result must be identical at scale 1 and 1/2. Turning
//       it off must restore the exact full-resolution backing store.
//   Opacity params must never move a mark size.
//
// jsdom has no WebGL, so the renderer runs against a recording mock context:
// `getUniformLocation` hands back the uniform NAME, so every uniform write is
// observable by name. That keeps the assertions on the real drawScene →
// computeMarkSizesPx → uniform path instead of a re-implementation of it.

import * as d3 from "d3";
import { createRendererAPI } from "../api/createRendererAPI";
import type { RendererVisualSettings } from "../api/types";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { SegmentColumns } from "../../dataPreprocessing/splineColumns";
import type { AggregateTileSource } from "../../scaling.types";
import {
  INTERACTIVE_QUALITY_SCALE,
  backingStorePx,
  computeMarkSizesPx,
  effectiveDpr,
  initWebGLRenderer,
  type MarkSizesPx,
  type WebGLRenderer,
} from "./webglRenderer";

const CSS_W = 1000;
const CSS_H = 800;
const DPR = 2;

type MockGl = {
  uniforms: Record<string, number | number[]>;
  draws: string[];
  /** (w, h) of every RGBA16F allocation — the HDR scene target's history. */
  sceneTargets: Array<[number, number]>;
};

/** Recording stand-in for WebGL2RenderingContext (see the file header).
 *  `hdr` advertises EXT_color_buffer_float so the offscreen scene-target path
 *  runs (it is skipped otherwise, exactly like on a driver without the ext). */
function installMockGl(canvas: HTMLCanvasElement, opts: { hdr?: boolean } = {}): MockGl {
  const uniforms: Record<string, number | number[]> = {};
  const draws: string[] = [];
  const sceneTargets: Array<[number, number]> = [];
  const enums: Record<string, number> = {};
  let nextEnum = 1;
  const enumOf = (key: string): number => {
    if (!(key in enums)) enums[key] = nextEnum++;
    return enums[key];
  };

  const impl: Record<string, unknown> = {
    canvas,
    getExtension: (name: string) =>
      opts.hdr === true && name === "EXT_color_buffer_float" ? {} : null,
    checkFramebufferStatus: () => enumOf("FRAMEBUFFER_COMPLETE"),
    texImage2D: (
      _target: number,
      _level: number,
      internalFormat: number,
      w: number,
      h: number
    ) => {
      if (internalFormat === enumOf("RGBA16F")) sceneTargets.push([w, h]);
    },
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    getInternalformatParameter: () => null,
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createVertexArray: () => ({}),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    getUniformLocation: (_program: unknown, name: string) => name,
    getAttribLocation: () => 0,
    framebufferTexture2D: () => undefined,
    uniform1f: (loc: unknown, v: number) => {
      uniforms[String(loc)] = v;
    },
    uniform1i: (loc: unknown, v: number) => {
      uniforms[String(loc)] = v;
    },
    uniform2f: (loc: unknown, a: number, b: number) => {
      uniforms[String(loc)] = [a, b];
    },
    drawArrays: (_mode: number, _first: number, count: number) => {
      draws.push(`arrays:${count}`);
    },
    drawElements: (_mode: number, count: number) => {
      draws.push(`elements:${count}`);
    },
    drawArraysInstanced: (_mode: number, _f: number, _c: number, instances: number) => {
      draws.push(`instanced:${instances}`);
    },
  };

  const gl = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const key = String(prop);
      // GL enums are SCREAMING_CASE and only ever passed through / added to.
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return enumOf(key);
      return () => undefined; // any other GL call is a no-op for these tests
    },
  });

  jest
    .spyOn(canvas, "getContext")
    .mockImplementation(() => gl as unknown as WebGL2RenderingContext);

  return { uniforms, draws, sceneTargets };
}

const BASE_SETTINGS: RendererVisualSettings = {
  nodeRadius: 5,
  nodeOutlineWidth: 1,
  nodeOutlineWhite: false,
  edgeWidth: 2,
  arrowScale: 6,
  colorPalette: ["#66c2a5", "#fc8d62"],
  colorEncoding: "DoI",
  grayOutDoiThreshold: 0.2,
  annotationDoiThreshold: 0.5,
  insetDoiThreshold: 0.8,
  minimumOpacityClamping: 0.1,
  maximumOpacityClamping: 1,
  canvasBgColor: "#ffffff",
};

function tinyNodes(): DataPoint[] {
  return [
    { id: 1, x: 0.1, y: 0.1, line: 0, DoI: 1 },
    { id: 2, x: 0.5, y: 0.4, line: 0, DoI: 1 },
    { id: 3, x: 0.9, y: 0.8, line: 0, DoI: 1 },
  ] as unknown as DataPoint[];
}

/** Two materialized segments (one arrow-bearing) — enough to exercise the CPU
 *  edge pass and the CPU arrow pass. */
function tinySegments(): SegmentColumns {
  return {
    segmentCount: 2,
    edgeCount: 1,
    segX0: new Float64Array([0.1, 0.5]),
    segY0: new Float64Array([0.1, 0.4]),
    segX1: new Float64Array([0.5, 0.9]),
    segY1: new Float64Array([0.4, 0.8]),
    segStartPct: new Float32Array([0, 0.5]),
    segEndPct: new Float32Array([0.5, 1]),
    segArrow: new Uint8Array([0, 1]),
    segEdge: new Int32Array([0, 0]),
    edgeSegOffset: new Int32Array([0, 2]),
    edgeStart: new Int32Array([0]),
    edgeEnd: new Int32Array([2]),
    edgeStartId: new Int32Array([1]),
    edgeEndId: new Int32Array([3]),
    edgeDoi: new Float32Array([1]),
  };
}

function aggregateStub(pointCount?: number): AggregateTileSource {
  return {
    meta: {
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
      binsPerTile: 256,
      maxLevel: 6,
      colorColumn: "algo",
      classes: ["a"],
      pointCount,
    },
    getTile: async () => null,
  };
}

function setup(
  opts: { aggregate?: AggregateTileSource | null; withData?: boolean; hdr?: boolean } = {}
) {
  const canvas = document.createElement("canvas");
  const mock = installMockGl(canvas, { hdr: opts.hdr });
  const xScale = d3.scaleLinear().domain([0, 1]).range([0, CSS_W]);
  const yScale = d3.scaleLinear().domain([0, 1]).range([CSS_H, 0]);
  const renderer = initWebGLRenderer(
    canvas,
    CSS_W,
    CSS_H,
    xScale,
    yScale,
    [],
    tinySegments(),
    BASE_SETTINGS
  );
  const api = createRendererAPI(renderer, {
    initialEdges: tinySegments(),
    initialVisualSettings: BASE_SETTINGS,
  });
  if (opts.withData !== false) api.setData(tinyNodes(), tinySegments());
  if (opts.aggregate !== undefined) api.setAggregateSource(opts.aggregate);
  api.render();
  return { api, renderer, canvas, mock };
}

function beacon(): {
  marks: MarkSizesPx;
  dpr: number;
  aggEligible: boolean;
  aggPointSizePx: number | null;
  canvas: { w: number; h: number };
} {
  return (window as unknown as { __baseDrawDebug: ReturnType<typeof beacon> }).__baseDrawDebug;
}

beforeEach(() => {
  // Force the CPU edge/arrow path: the instanced path needs real data textures,
  // and the CPU path is the one whose sizes used to drift from the instanced
  // pass. Both now read the same computeMarkSizesPx output.
  (window as unknown as { __edgeCpuPath?: boolean }).__edgeCpuPath = true;
  Object.defineProperty(window, "devicePixelRatio", { value: DPR, configurable: true });
});

afterEach(() => {
  delete (window as unknown as { __edgeCpuPath?: boolean }).__edgeCpuPath;
  jest.restoreAllMocks();
});

// ── (a) setStyle reaches every draw path ────────────────────────────────────

test("setStyle commit reaches the node, edge and arrow passes", () => {
  const { api, mock } = setup();

  api.setStyle({ nodeRadius: 12, nodeOutlineWidth: 3, edgeWidth: 4, arrowScale: 7 });
  api.render();

  // Small dataset ⇒ no density cap, so device px = value × dpr exactly.
  expect(mock.uniforms.u_nodeRadiusPx).toBeCloseTo(12 * DPR, 10);
  expect(mock.uniforms.u_nodeOutlineWidthPx).toBeCloseTo(3 * DPR, 10);
  expect(mock.uniforms.u_edgeWidth).toBeCloseTo(4 * DPR, 10);
  expect(mock.uniforms.u_arrowLengthPx).toBeCloseTo(7 * DPR, 10);
  // Every pass actually ran (points, edge quads, arrow triangles).
  expect(mock.draws).toContain("arrays:3");
  expect(mock.draws.some((d) => d.startsWith("elements:"))).toBe(true);
  expect(mock.draws).toContain("arrays:3");
});

test("setStyle commit reaches the aggregate splat pass' pointSizePx", () => {
  const { api } = setup({ aggregate: aggregateStub() });

  // The server-base color gate (issue #315 color-by fix) drops aggregates
  // for encodings their baked colorColumn cannot represent — this test is
  // about STYLE propagation, so use the compatible pairing.
  api.setColorMapping({ colorPalette: BASE_SETTINGS.colorPalette, colorEncoding: "algo" });
  api.setStyle({ nodeRadius: 12, nodeOutlineWidth: 3, edgeWidth: 4, arrowScale: 7 });
  api.render();

  const b = beacon();
  expect(b.aggEligible).toBe(true);
  // The value handed to AggregateLayer.draw as `pointSizePx`.
  expect(b.aggPointSizePx).toBeCloseTo(12 * DPR, 10);
  expect(b.aggPointSizePx).toBeCloseTo(b.marks.nodeRadiusPx, 10);
});

test("node radius and arrow scale still move at 1M-point density", () => {
  // The regression: the density cap was an ABSOLUTE pixel target, so
  // nodeRadius × dpr × densityPointScale collapsed to the budget and the
  // slider did nothing (and arrows shrank as nodes grew).
  // No raw geometry: the aggregate meta's point count is the density input
  // (exactly the synth1m at-rest state, where the splat base is what draws).
  const { api } = setup({ aggregate: aggregateStub(1_000_000), withData: false });

  api.setStyle({ nodeRadius: 5, nodeOutlineWidth: 1, edgeWidth: 2, arrowScale: 6 });
  api.render();
  const small = beacon().marks;

  api.setStyle({ nodeRadius: 20, nodeOutlineWidth: 1, edgeWidth: 2, arrowScale: 6 });
  api.render();
  const big = beacon().marks;

  expect(small.densityScale).toBeLessThan(1); // the cap IS engaged here
  expect(big.nodeRadiusPx).toBeGreaterThan(small.nodeRadiusPx * 3);

  api.setStyle({ nodeRadius: 5, nodeOutlineWidth: 1, edgeWidth: 2, arrowScale: 18 });
  api.render();
  const longArrows = beacon().marks;
  expect(longArrows.arrowLengthPx).toBeCloseTo(small.arrowLengthPx * 3, 10);
});

// ── (b/c) interactive-quality invariance ────────────────────────────────────

test("interactive quality halves the backing store and restores it exactly", () => {
  const { api, canvas } = setup();
  const fullW = canvas.width;
  const fullH = canvas.height;
  expect(fullW).toBe(backingStorePx(CSS_W, DPR, 1));

  api.setInteractiveQuality(true);
  api.render();
  expect(canvas.width).toBe(backingStorePx(CSS_W, DPR, INTERACTIVE_QUALITY_SCALE));
  expect(canvas.height).toBe(backingStorePx(CSS_H, DPR, INTERACTIVE_QUALITY_SCALE));

  api.setInteractiveQuality(false);
  api.render();
  expect(canvas.width).toBe(fullW);
  expect(canvas.height).toBe(fullH);
});

test("apparent (CSS-px) mark sizes are identical at quality 1 and 1/2", () => {
  const { api, canvas, mock } = setup();
  api.setStyle({ nodeRadius: 9, nodeOutlineWidth: 2, edgeWidth: 3, arrowScale: 5 });
  api.render();

  const cssPx = (devicePx: number) => devicePx / (canvas.width / CSS_W);
  const full = {
    node: cssPx(mock.uniforms.u_nodeRadiusPx as number),
    outline: cssPx(mock.uniforms.u_nodeOutlineWidthPx as number),
    edge: cssPx(mock.uniforms.u_edgeWidth as number),
    arrow: cssPx(mock.uniforms.u_arrowLengthPx as number),
  };
  expect(beacon().dpr).toBe(DPR);

  api.setInteractiveQuality(true);
  api.render();
  const reduced = {
    node: cssPx(mock.uniforms.u_nodeRadiusPx as number),
    outline: cssPx(mock.uniforms.u_nodeOutlineWidthPx as number),
    edge: cssPx(mock.uniforms.u_edgeWidth as number),
    arrow: cssPx(mock.uniforms.u_arrowLengthPx as number),
  };

  // The device-px sizes must shrink with the buffer …
  expect(beacon().dpr).toBeCloseTo(DPR * INTERACTIVE_QUALITY_SCALE, 10);
  // … so that what the user SEES does not move (the "jump until commit").
  expect(reduced.node).toBeCloseTo(full.node, 10);
  expect(reduced.outline).toBeCloseTo(full.outline, 10);
  expect(reduced.edge).toBeCloseTo(full.edge, 10);
  expect(reduced.arrow).toBeCloseTo(full.arrow, 10);
});

test("the RGBA16F scene target follows the backing store both ways", () => {
  // The named suspect for blur that OUTLIVES the drag: a scene target sized
  // once and then upscaled forever. ensureSceneTarget must reallocate on every
  // drawing-buffer change, including the restore.
  const { api, canvas, mock } = setup({ hdr: true });
  const full: [number, number] = [canvas.width, canvas.height];
  expect(mock.sceneTargets[mock.sceneTargets.length - 1]).toEqual(full);

  api.setInteractiveQuality(true);
  api.render();
  expect(mock.sceneTargets[mock.sceneTargets.length - 1]).toEqual([
    canvas.width,
    canvas.height,
  ]);
  expect(canvas.width).toBeLessThan(full[0]);

  api.setInteractiveQuality(false);
  api.render();
  expect(mock.sceneTargets[mock.sceneTargets.length - 1]).toEqual(full);
});

test("effectiveDpr reads the backing store, not window.devicePixelRatio", () => {
  expect(effectiveDpr(backingStorePx(CSS_W, DPR, 1), CSS_W, 99)).toBe(DPR);
  expect(effectiveDpr(backingStorePx(CSS_W, DPR, INTERACTIVE_QUALITY_SCALE), CSS_W, 99)).toBe(
    DPR * INTERACTIVE_QUALITY_SCALE
  );
  // Degenerate inputs fall back instead of producing 0 / NaN sizes.
  expect(effectiveDpr(0, CSS_W, 1.5)).toBe(1.5);
  expect(effectiveDpr(100, 0, 1.5)).toBe(1.5);
});

test("mark sizes scale linearly in the effective dpr (quality invariance, pure)", () => {
  const renderer = {
    nodeCount: 3,
    dataBboxW: 1,
    dataBboxH: 1,
    densityHint: null,
    transformMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    currentVisualSettings: { nodeRadius: 9, nodeOutlineWidth: 2, edgeWidth: 3, arrowScale: 5 },
  } as unknown as WebGLRenderer;

  const full = computeMarkSizesPx(renderer, 2000, 1600, 2);
  const half = computeMarkSizesPx(renderer, 1000, 800, 1);
  expect(half.nodeRadiusPx).toBeCloseTo(full.nodeRadiusPx / 2, 10);
  expect(half.nodeOutlineWidthPx).toBeCloseTo(full.nodeOutlineWidthPx / 2, 10);
  expect(half.edgeWidthPx).toBeCloseTo(full.edgeWidthPx / 2, 10);
  expect(half.arrowLengthPx).toBeCloseTo(full.arrowLengthPx / 2, 10);
});

test("density-capped mark sizes are quality-invariant too", () => {
  // Same view, same data, only the backing-store scale differs: the cap is
  // computed in device px, so every term has to scale with it.
  const renderer = {
    nodeCount: 1_000_000,
    dataBboxW: 2,
    dataBboxH: 2,
    densityHint: null,
    transformMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    currentVisualSettings: { nodeRadius: 9, nodeOutlineWidth: 2, edgeWidth: 3, arrowScale: 5 },
  } as unknown as WebGLRenderer;

  const full = computeMarkSizesPx(renderer, 2000, 1600, 2);
  const half = computeMarkSizesPx(renderer, 1000, 800, 1);
  expect(full.densityScale).toBeLessThan(1);
  expect(half.densityScale).toBeCloseTo(full.densityScale, 10);
  expect(half.nodeRadiusPx).toBeCloseTo(full.nodeRadiusPx / 2, 10);
  expect(half.arrowLengthPx).toBeCloseTo(full.arrowLengthPx / 2, 10);
});

// ── opacity params must not touch sizes ─────────────────────────────────────

test("opacity params change alpha uniforms and nothing about mark sizes", () => {
  const { api, mock } = setup();
  api.setStyle({ nodeRadius: 9, nodeOutlineWidth: 2, edgeWidth: 3, arrowScale: 5 });
  api.render();
  const before = { ...mock.uniforms };

  api.setOpacityParams({ threshold: 0.4, minAlpha: 0.05, maxAlpha: 0.3 });
  api.render();

  expect(mock.uniforms.u_maxOpacity).toBeCloseTo(0.3, 10);
  expect(mock.uniforms.u_minOpacity).toBeCloseTo(0.05, 10);
  expect(mock.uniforms.u_nodeRadiusPx).toBe(before.u_nodeRadiusPx);
  expect(mock.uniforms.u_nodeOutlineWidthPx).toBe(before.u_nodeOutlineWidthPx);
  expect(mock.uniforms.u_edgeWidth).toBe(before.u_edgeWidth);
  expect(mock.uniforms.u_arrowLengthPx).toBe(before.u_arrowLengthPx);
});
