/**
 * Boot columns mode (issue #315 B1): the renderer paints node geometry
 * straight from the decoded binary sidecar before any DataPoint[] exists.
 *
 * Pinned here (each guards a specific hazard):
 *   (1) setColumnData uploads positions/colors/opacity BYTE-EQUAL to what the
 *       classic rows path uploads for the same data — the paint is a preview
 *       of the commit, never a different picture.
 *   (2) A settings-driven updateData with the empty boot nodes array must NOT
 *       zero the painted node count (createRendererAPI passes
 *       `lastNodes.length` as the visible count on every setStyle/palette
 *       call — the clamp has to keep answering the sidecar count).
 *   (3) The first real non-empty setData replaces columns mode wholesale.
 *   (4) The boot opacity is the server-cut implicit uniform (all ones).
 *
 * jsdom has no WebGL: the mock context records bufferData payloads per
 * buffer object so the assertions read actual uploads (markSizes-test model).
 */

import * as d3 from "d3";
import { createRendererAPI } from "../api/createRendererAPI";
import type { RendererVisualSettings } from "../api/types";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { PointColumns as SidecarPointColumns } from "../../dataPreprocessing/columnSidecar";
import { createLazyRowArray, ensureResidentRows } from "../../dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "../../dataPreprocessing/pointColumns";
import { EMPTY_SEGMENT_COLUMNS } from "../../dataPreprocessing/splineColumns";
import { initWebGLRenderer } from "./webglRenderer";
import { ColorSystem } from "./systems/ColorSystem";

const CSS_W = 1000;
const CSS_H = 800;

type MockGl = {
  /** Latest Float32Array payload uploaded to each buffer object. */
  bufferPayloads: Map<object, Float32Array>;
};

function installMockGl(canvas: HTMLCanvasElement): MockGl {
  const bufferPayloads = new Map<object, Float32Array>();
  const enums: Record<string, number> = {};
  let nextEnum = 1;
  const enumOf = (key: string): number => {
    if (!(key in enums)) enums[key] = nextEnum++;
    return enums[key];
  };

  let boundArrayBuffer: object | null = null;

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
    bindBuffer: (target: number, buf: object | null) => {
      if (target === enumOf("ARRAY_BUFFER")) boundArrayBuffer = buf;
    },
    bufferData: (target: number, data: unknown) => {
      if (target === enumOf("ARRAY_BUFFER") && boundArrayBuffer && data instanceof Float32Array) {
        bufferPayloads.set(boundArrayBuffer, new Float32Array(data));
      }
    },
    bufferSubData: (target: number, _offset: number, data: unknown) => {
      if (target === enumOf("ARRAY_BUFFER") && boundArrayBuffer && data instanceof Float32Array) {
        bufferPayloads.set(boundArrayBuffer, new Float32Array(data));
      }
    },
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

  return { bufferPayloads };
}

const BASE_SETTINGS: RendererVisualSettings = {
  nodeRadius: 5,
  nodeOutlineWidth: 1,
  nodeOutlineWhite: false,
  edgeWidth: 2,
  arrowScale: 6,
  colorPalette: ["#66c2a5", "#fc8d62", "#8da0cb"],
  colorEncoding: "action",
  grayOutDoiThreshold: 0.2,
  annotationDoiThreshold: 0.5,
  insetDoiThreshold: 0.8,
  minimumOpacityClamping: 0.1,
  maximumOpacityClamping: 1,
  canvasBgColor: "#ffffff",
};

/** Sidecar fixture: the columns a synth1m-style manifest decodes. */
function sidecarCols(): SidecarPointColumns {
  return {
    count: 3,
    byName: {
      x: new Float64Array([0.1, 0.5, 0.9]),
      y: new Float64Array([0.1, 0.4, 0.8]),
      line: new Uint16Array([0, 0, 1]),
      id: new Uint32Array([1, 2, 3]),
      action: new Uint8Array([0, 1, 0]),
    },
  };
}

/** The rows materializeRecords would produce from sidecarCols(), after the
 * boot normalize pass wrote DoI = 1 (so the classic opacity path matches the
 * columns-mode uniform). */
function materializedRows(): DataPoint[] {
  return [
    { x: 0.1, y: 0.1, line: 0, id: 1, action: 0, DoI: 1 },
    { x: 0.5, y: 0.4, line: 0, id: 2, action: 1, DoI: 1 },
    { x: 0.9, y: 0.8, line: 1, id: 3, action: 0, DoI: 1 },
  ] as unknown as DataPoint[];
}

function setup(settings: RendererVisualSettings = BASE_SETTINGS) {
  const canvas = document.createElement("canvas");
  const mock = installMockGl(canvas);
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
  return { api, renderer, mock };
}

function beaconNodeCount(): number {
  return (window as unknown as { __baseDrawDebug: { nodeCount: number } }).__baseDrawDebug
    .nodeCount;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("webglRenderer boot columns mode", () => {
  it("uploads positions, colors and opacity byte-equal to the rows path", () => {
    const a = setup();
    a.api.setColumnData!(sidecarCols());
    a.api.render();

    const b = setup();
    b.api.setData(materializedRows(), null);
    b.api.render();

    expect(beaconNodeCount()).toBe(3);
    const posA = a.mock.bufferPayloads.get(a.renderer.nodeBuffer as object)!;
    const posB = b.mock.bufferPayloads.get(b.renderer.nodeBuffer as object)!;
    expect(Array.from(posA)).toEqual(Array.from(posB));
    expect(Array.from(posA)).toEqual(
      Array.from(new Float32Array([0.1, 0.1, 0.5, 0.4, 0.9, 0.8]))
    );

    const colA = a.mock.bufferPayloads.get(a.renderer.nodeColorBuffer as object)!;
    const colB = b.mock.bufferPayloads.get(b.renderer.nodeColorBuffer as object)!;
    expect(Array.from(colA)).toEqual(Array.from(colB));

    const opA = a.mock.bufferPayloads.get(a.renderer.nodeOpacityFieldBuffer as object)!;
    expect(Array.from(opA)).toEqual([1, 1, 1]);
  });

  it("matches the rows path when the encoding column is absent (default color)", () => {
    const settings = { ...BASE_SETTINGS, colorEncoding: "algo" };
    const a = setup(settings);
    a.api.setColumnData!(sidecarCols());
    a.api.render();

    const b = setup(settings);
    b.api.setData(materializedRows(), null);
    b.api.render();

    const colA = a.mock.bufferPayloads.get(a.renderer.nodeColorBuffer as object)!;
    const colB = b.mock.bufferPayloads.get(b.renderer.nodeColorBuffer as object)!;
    expect(colA.length).toBe(9);
    expect(Array.from(colA)).toEqual(Array.from(colB));
  });

  it("keeps the painted count through settings-driven empty-node updates", () => {
    const { api, renderer, mock } = setup();
    api.setColumnData!(sidecarCols());
    api.render();
    expect(renderer.nodeCount).toBe(3);

    api.setStyle({ nodeRadius: 9, nodeOutlineWidth: 2, edgeWidth: 3, arrowScale: 5 });
    api.render();
    expect(renderer.nodeCount).toBe(3);
    expect(beaconNodeCount()).toBe(3);

    api.setColorMapping({ colorPalette: ["#000000", "#ffffff"], colorEncoding: "action" });
    api.render();
    expect(renderer.nodeCount).toBe(3);
    const col = mock.bufferPayloads.get(renderer.nodeColorBuffer as object)!;
    expect(col.length).toBe(9);
  });

  it("is replaced wholesale by the first real setData", () => {
    const { api, renderer, mock } = setup();
    api.setColumnData!(sidecarCols());
    api.render();
    expect(renderer.nodeCount).toBe(3);

    const twoNodes = [
      { x: 0.2, y: 0.2, line: 0, id: 7, action: 1, DoI: 1 },
      { x: 0.6, y: 0.7, line: 0, id: 8, action: 0, DoI: 1 },
    ] as unknown as DataPoint[];
    api.setData(twoNodes, null);
    api.render();

    expect(renderer.nodeCount).toBe(2);
    const pos = mock.bufferPayloads.get(renderer.nodeBuffer as object)!;
    expect(Array.from(pos)).toEqual(Array.from(new Float32Array([0.2, 0.2, 0.6, 0.7])));
  });

  it("ignores a sidecar without x/y columns", () => {
    const { api, renderer } = setup();
    api.setColumnData!({ count: 2, byName: { id: new Uint32Array([1, 2]) } });
    api.render();
    expect(renderer.nodeCount).toBe(0);
  });
});

describe("ColorSystem.buildNodeColorsFromColumn", () => {
  const thresholds = { hidden: 0.2, labeled: 0.5, inset: 0.8 };
  const palette = ["#66c2a5", "#fc8d62", "#8da0cb"];
  const scaleFn = (key: string | number) => palette[Math.abs(Number(key)) % palette.length];

  it("equals buildNodeColors over materialized rows for a numeric column", () => {
    const cs = new ColorSystem(palette, thresholds, scaleFn);
    const col = new Uint8Array([0, 1, 2, 1, 0]);
    const rows = Array.from(col, (v, i) => ({ id: i, x: 0, y: 0, action: v })) as unknown as DataPoint[];
    const fromColumn = cs.buildNodeColorsFromColumn(col, col.length);
    const fromRows = cs.buildNodeColors(rows, "action", undefined, rows.length);
    expect(Array.from(fromColumn)).toEqual(Array.from(fromRows));
  });

  it("equals the rows path's null-key default when the column is absent", () => {
    const cs = new ColorSystem(palette, thresholds, scaleFn);
    const rows = [{ id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 1 }] as unknown as DataPoint[];
    const fromColumn = cs.buildNodeColorsFromColumn(null, 2);
    const fromRows = cs.buildNodeColors(rows, "algo", undefined, 2);
    expect(Array.from(fromColumn)).toEqual(Array.from(fromRows));
  });

  it("equals the rows path for a DICTIONARY column (issue #315 R1a step 7)", () => {
    const cs = new ColorSystem(palette, thresholds, (key) => palette[String(key).length % palette.length]);
    // What a FORMAT v2 dictionary column decodes to: the category values.
    const col = ["left", "up", "downward", "up", "left"];
    const rows = col.map((v, i) => ({ id: i, x: 0, y: 0, action: v })) as unknown as DataPoint[];
    const fromColumn = cs.buildNodeColorsFromColumn(col, col.length);
    const fromRows = cs.buildNodeColors(rows, "action", undefined, rows.length);
    expect(Array.from(fromColumn)).toEqual(Array.from(fromRows));
    // Distinct categories really did get distinct colors (no flat default).
    expect(new Set(Array.from(fromColumn)).size).toBeGreaterThan(1);
  });

  it("colors a missing dictionary cell like the rows path's null key", () => {
    const cs = new ColorSystem(palette, thresholds, scaleFn);
    const fromColumn = cs.buildNodeColorsFromColumn([null], 1);
    const fromRows = cs.buildNodeColors(
      [{ id: 0, x: 0, y: 0 }] as unknown as DataPoint[],
      "algo",
      undefined,
      1
    );
    expect(Array.from(fromColumn)).toEqual(Array.from(fromRows));
  });

  it("matches the DoI LUT branch when doiValues are supplied", () => {
    const cs = new ColorSystem(palette, thresholds, scaleFn);
    const doi = new Float32Array([0, 0.3, 0.7, 1]);
    const rows = Array.from(doi, (_, i) => ({ id: i, x: 0, y: 0 })) as unknown as DataPoint[];
    const fromColumn = cs.buildNodeColorsFromColumn(null, doi.length, doi);
    const fromRows = cs.buildNodeColors(rows, "DoI", doi, doi.length);
    expect(Array.from(fromColumn)).toEqual(Array.from(fromRows));
  });
});

/**
 * Columns mode past setData (issue #315 R1b): on the row-lazy lane the
 * renderer receives the canonical array AND the sidecar columns, and every
 * per-point read has to keep coming from the columns — the rows are holes.
 * When a contract member materializes them the renderer must hand the lane
 * back, because `getColorEncodingKey` applies the assigned-label override that
 * no sidecar column carries.
 */
describe("webglRenderer columns mode with row-lazy nodes", () => {
  function lazyNodes(): DataPoint[] {
    const sc = sidecarCols();
    const cols = columnsFromSidecar(sc)!;
    // Eager prefix of 1 ⇒ indices 1..1 are holes, index 2 is the endpoint.
    return createLazyRowArray([], sc, cols, { eagerRows: 1 });
  }

  it("paints from the columns while the rows are lazy", () => {
    const a = setup();
    const nodes = lazyNodes();
    a.api.setData(nodes, null);
    a.api.setColumnData!(sidecarCols());
    a.api.render();

    const b = setup();
    b.api.setData(materializedRows(), null);
    b.api.render();

    expect(a.renderer.nodeCount).toBe(3);
    const posA = a.mock.bufferPayloads.get(a.renderer.nodeBuffer as object)!;
    const posB = b.mock.bufferPayloads.get(b.renderer.nodeBuffer as object)!;
    expect(Array.from(posA)).toEqual(Array.from(posB));

    const colA = a.mock.bufferPayloads.get(a.renderer.nodeColorBuffer as object)!;
    const colB = b.mock.bufferPayloads.get(b.renderer.nodeColorBuffer as object)!;
    expect(Array.from(colA)).toEqual(Array.from(colB));
  });

  it("hands the lane back to the rows once they are materialized", async () => {
    // The lane, not the pixels: which builder ran is the assertion, because
    // both produce the same colors until a row carries something the column
    // cannot (an assigned-label override).
    const fromColumn = jest.spyOn(ColorSystem.prototype, "buildNodeColorsFromColumn");
    const fromRows = jest.spyOn(ColorSystem.prototype, "buildNodeColors");

    const { api, renderer } = setup();
    const nodes = lazyNodes();
    api.setData(nodes, null);
    api.setColumnData!(sidecarCols());
    api.render();
    expect(fromColumn).toHaveBeenCalled();
    expect(fromRows).not.toHaveBeenCalled();

    await ensureResidentRows(nodes);
    fromColumn.mockClear();
    fromRows.mockClear();

    api.setColorMapping({ colorPalette: BASE_SETTINGS.colorPalette, colorEncoding: "action" });
    api.render();

    expect(fromRows).toHaveBeenCalled();
    expect(fromColumn).not.toHaveBeenCalled();
    expect(renderer.nodeCount).toBe(3);
  });
});

describe("ColorSystem.buildNodeColorsFromColumn numeric ramp", () => {
  it("uses the same ramp the rows path uses (no per-value memo blowup)", () => {
    const palette = ["#66c2a5", "#fc8d62", "#8da0cb"];
    const scaleFn = () => "#000000"; // would be WRONG if the ramp is skipped
    const ramp = {
      writeRgb01(key: number, out: Float32Array, base: number) {
        out[base] = key;
        out[base + 1] = key / 2;
        out[base + 2] = key / 4;
      },
    };
    const cs = new ColorSystem(palette, { hidden: 0.2, labeled: 0.5, inset: 0.8 }, scaleFn, () => ramp);
    const col = new Float64Array([0.25, 0.5, 0.75]);
    const rows = Array.from(col, (v, i) => ({ id: i, x: 0, y: 0, reward: v })) as unknown as DataPoint[];

    expect(Array.from(cs.buildNodeColorsFromColumn(col, col.length, undefined, "reward"))).toEqual(
      Array.from(cs.buildNodeColors(rows, "reward", undefined, rows.length))
    );
  });
});
