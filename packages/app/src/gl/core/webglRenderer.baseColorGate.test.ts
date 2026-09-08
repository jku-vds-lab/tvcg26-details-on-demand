/**
 * Server-base color-compatibility gate (issue #315 color-by fix): the
 * aggregate/tile base imagery is colored by the PREP-TIME colorColumn baked
 * into its pyramid, so it can only stand in for the raw geometry while the
 * client's colorEncoding IS that column. Before the fix, synth1m at rest
 * drew single-class aggregates for every encoding — the color dropdown
 * silently did nothing. Pinned here (via the __baseDrawDebug beacon):
 *   (1) matching encoding ⇒ aggregates eligible (the G3 LOD win intact),
 *   (2) any other encoding ⇒ NOT eligible — the raw node pass draws and
 *       client colors apply,
 *   (3) before any node geometry exists (early boot) the base draws
 *       regardless of encoding — there is nothing else to show,
 *   (4) switching back to the baked column restores eligibility.
 *
 * jsdom has no WebGL: same recording mock as webglRenderer.columnsMode.test.
 */

import * as d3 from "d3";
import { createRendererAPI } from "../api/createRendererAPI";
import type { RendererVisualSettings } from "../api/types";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { AggregateTileSource } from "../../scaling.types";
import { EMPTY_SEGMENT_COLUMNS } from "../../dataPreprocessing/splineColumns";
import { initWebGLRenderer } from "./webglRenderer";

const CSS_W = 1000;
const CSS_H = 800;

function installMockGl(canvas: HTMLCanvasElement): void {
  const enums: Record<string, number> = {};
  let nextEnum = 1;
  const enumOf = (key: string): number => {
    if (!(key in enums)) enums[key] = nextEnum++;
    return enums[key];
  };

  const impl: Record<string, unknown> = {
    canvas,
    getExtension: () => null,
    checkFramebufferStatus: () => enumOf("FRAMEBUFFER_COMPLETE"),
    getParameter: () => 4096,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createVertexArray: () => ({}),
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    getUniformLocation: (_p: unknown, name: string) => name,
    getAttribLocation: () => 0,
  };

  const gl = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const key = String(prop);
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return enumOf(key);
      return () => undefined;
    },
  });

  jest
    .spyOn(canvas, "getContext")
    .mockImplementation(() => gl as unknown as WebGL2RenderingContext);
}

const BASE_SETTINGS: RendererVisualSettings = {
  nodeRadius: 5,
  nodeOutlineWidth: 1,
  nodeOutlineWhite: false,
  edgeWidth: 2,
  arrowScale: 6,
  colorPalette: ["#66c2a5", "#fc8d62", "#8da0cb"],
  colorEncoding: "algo",
  grayOutDoiThreshold: 0.2,
  annotationDoiThreshold: 0.5,
  insetDoiThreshold: 0.8,
  minimumOpacityClamping: 0.1,
  maximumOpacityClamping: 1,
  canvasBgColor: "#ffffff",
};

function aggregateSourceStub(
  colorColumn: string,
  classes: (string | number)[] = [""]
): AggregateTileSource {
  return {
    meta: {
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
      binsPerTile: 256,
      maxLevel: 3,
      colorColumn,
      classes,
      pointCount: 3,
    },
    getTile: async () => null,
  };
}

function nodes(): DataPoint[] {
  return [
    { x: 0.1, y: 0.1, line: 0, id: 1, action: 0, DoI: 1 },
    { x: 0.5, y: 0.4, line: 0, id: 2, action: 1, DoI: 1 },
    { x: 0.9, y: 0.8, line: 1, id: 3, action: 0, DoI: 1 },
  ] as unknown as DataPoint[];
}

function setup(settings: RendererVisualSettings = BASE_SETTINGS) {
  const canvas = document.createElement("canvas");
  installMockGl(canvas);
  const xScale = d3.scaleLinear().domain([0, 1]).range([0, CSS_W]);
  const yScale = d3.scaleLinear().domain([0, 1]).range([CSS_H, 0]);
  const renderer = initWebGLRenderer(
    canvas,
    CSS_W,
    CSS_H,
    xScale,
    yScale,
    [],
    EMPTY_SEGMENT_COLUMNS,
    settings
  );
  const api = createRendererAPI(renderer, {
    initialEdges: EMPTY_SEGMENT_COLUMNS,
    initialVisualSettings: settings,
  });
  return { api, renderer };
}

function beaconAggEligible(): boolean {
  return (window as unknown as { __baseDrawDebug: { aggEligible: boolean } }).__baseDrawDebug
    .aggEligible;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("webglRenderer server-base color gate", () => {
  it("keeps aggregates eligible while the encoding matches the baked column", () => {
    const { api } = setup();
    api.setAggregateSource(aggregateSourceStub("algo"));
    api.setData(nodes(), null);
    api.render();
    expect(beaconAggEligible()).toBe(true);
  });

  it("drops to raw geometry when the user selects a different encoding", () => {
    const { api } = setup();
    api.setAggregateSource(aggregateSourceStub("algo"));
    api.setData(nodes(), null);
    api.setColorMapping({ colorPalette: BASE_SETTINGS.colorPalette, colorEncoding: "reward" });
    api.render();
    expect(beaconAggEligible()).toBe(false);
  });

  it("still draws the base before any node geometry exists, whatever the encoding", () => {
    const { api } = setup({ ...BASE_SETTINGS, colorEncoding: "reward" });
    api.setAggregateSource(aggregateSourceStub("algo"));
    api.render();
    expect(beaconAggEligible()).toBe(true);
  });

  it("keeps a DEGENERATE single-class pyramid eligible under an empty encoding", () => {
    // The validated "(none)" state for datasets lacking their preset column:
    // both paths render every point in the same default color, so the LOD
    // base must stay (issue #315 color-by UX).
    const { api } = setup({ ...BASE_SETTINGS, colorEncoding: "" });
    api.setAggregateSource(aggregateSourceStub("algo", [""]));
    api.setData(nodes(), null);
    api.render();
    expect(beaconAggEligible()).toBe(true);
  });

  it("drops a MULTI-class pyramid under an empty encoding", () => {
    const { api } = setup({ ...BASE_SETTINGS, colorEncoding: "" });
    api.setAggregateSource(aggregateSourceStub("algo", ["0", "1", "2"]));
    api.setData(nodes(), null);
    api.render();
    expect(beaconAggEligible()).toBe(false);
  });

  it("restores eligibility when the encoding returns to the baked column", () => {
    const { api } = setup();
    api.setAggregateSource(aggregateSourceStub("algo"));
    api.setData(nodes(), null);
    api.setColorMapping({ colorPalette: BASE_SETTINGS.colorPalette, colorEncoding: "reward" });
    api.render();
    expect(beaconAggEligible()).toBe(false);
    api.setColorMapping({ colorPalette: BASE_SETTINGS.colorPalette, colorEncoding: "algo" });
    api.render();
    expect(beaconAggEligible()).toBe(true);
  });
});
