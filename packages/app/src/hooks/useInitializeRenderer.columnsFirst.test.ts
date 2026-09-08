// Issue #315 B3 — columns-first boot renderer for client-complete sidecar
// datasets.
//
// Covers: installColumnsFirstRenderer installs an empty-geometry renderer
// with scales from the sidecar x/y extent and hands it the columns paint;
// it replaces (disposes) a previous dataset's live renderer (the switch
// case); and it refuses — touching nothing — when the sidecar lacks numeric
// x/y views or is empty.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import { installColumnsFirstRenderer } from "./useInitializeRenderer";
import type { PointColumns } from "../dataPreprocessing/columnSidecar";

// ── module mocks (mirror the aggregateSwitch test harness) ──────────────────
jest.mock("../contexts/DataContext", () => ({ useDataRef: () => ({ current: [] }) }));
jest.mock("../contexts/SegmentsContext", () => ({ useSegmentsRef: () => ({ current: [] }) }));

jest.mock("../utils/createAndAppendCanvas", () => ({
  createAndAppendCanvas: (container: HTMLElement) => {
    const canvas = global.document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    container.appendChild(canvas);
    return canvas;
  },
}));

const mockComputeScales = jest.fn((..._args: unknown[]) => {
  const d3 = jest.requireActual<typeof import("d3")>("d3");
  return {
    xScale: d3.scaleLinear().domain([0, 1]).range([0, 1]),
    yScale: d3.scaleLinear().domain([0, 1]).range([0, 1]),
  };
});
jest.mock("../utils/computeScales", () => ({
  computeScales: (...args: unknown[]) => mockComputeScales(...args),
}));

jest.mock("../utils/datasetLoadInstrumentation", () => ({
  markDatasetLoadPhase: () => undefined,
}));

const mockInitWebGLRenderer = jest.fn((..._args: unknown[]) => ({}));
jest.mock("../gl/core/webglRenderer", () => ({
  initWebGLRenderer: (...args: unknown[]) => mockInitWebGLRenderer(...args),
}));

let apiSeq = 0;
const mockCreateRendererAPI = jest.fn((..._args: unknown[]) => {
  apiSeq += 1;
  return {
    id: apiSeq,
    setColumnData: jest.fn(),
    dispose: jest.fn(),
  };
});
jest.mock("../gl/api/createRendererAPI", () => ({
  createRendererAPI: (...args: unknown[]) => mockCreateRendererAPI(...args),
}));

jest.mock("@scaling", () => ({
  resolveAggregateSource: async () => null,
  warmBootCut: () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makeCols(overrides?: Partial<Record<string, PointColumns["byName"][string]>>): PointColumns {
  const byName: PointColumns["byName"] = {
    x: new Float64Array([1.5, -2, 7]),
    y: new Float64Array([0.5, 3, -4]),
    line: new Int32Array([0, 0, 1]),
    id: new Int32Array([0, 1, 2]),
    ...overrides,
  };
  for (const key of Object.keys(byName)) {
    if (byName[key] === undefined) delete byName[key];
  }
  return { count: 3, byName };
}

function makeParams(rendererRef: { current: AnyApi }) {
  const container = global.document.createElement("div");
  const setScales = jest.fn();
  const setZoomTransform = jest.fn();
  const currentZoomParamsRef = { current: null as AnyApi };
  return {
    params: { container, rendererRef, currentZoomParamsRef, setScales, setZoomTransform },
    container,
    setScales,
    setZoomTransform,
    currentZoomParamsRef,
  };
}

beforeEach(() => {
  apiSeq = 0;
  mockCreateRendererAPI.mockClear();
  mockInitWebGLRenderer.mockClear();
  mockComputeScales.mockClear();
});

describe("installColumnsFirstRenderer (issue #315 B3)", () => {
  it("installs a boot renderer, sets scales from the column extent, paints the columns", () => {
    const rendererRef = { current: null as AnyApi };
    const cols = makeCols();
    const { params, container, setScales, setZoomTransform, currentZoomParamsRef } =
      makeParams(rendererRef);

    expect(installColumnsFirstRenderer(cols, params)).toBe(true);

    expect(container.querySelector("canvas")).not.toBeNull();
    // Extent corners handed to computeScales are the sidecar min/max.
    const corners = mockComputeScales.mock.calls[0][2] as Array<{ x: number; y: number }>;
    expect(corners).toEqual([
      { x: -2, y: -4 },
      { x: 7, y: 3 },
    ]);
    expect(setScales).toHaveBeenCalledTimes(1);
    expect(currentZoomParamsRef.current).toMatchObject({ width: 640, height: 480 });
    expect(setZoomTransform).toHaveBeenCalledTimes(1);
    expect(rendererRef.current).not.toBeNull();
    expect(rendererRef.current.setColumnData).toHaveBeenCalledWith(cols);
  });

  it("replaces a previous dataset's live renderer (the switch case)", () => {
    const oldApi = { dispose: jest.fn(), setColumnData: jest.fn() };
    const rendererRef = { current: oldApi as AnyApi };
    const { params } = makeParams(rendererRef);

    expect(installColumnsFirstRenderer(makeCols(), params)).toBe(true);

    expect(oldApi.dispose).toHaveBeenCalledTimes(1);
    expect(rendererRef.current).not.toBe(oldApi);
    // The paint lands on the FRESH instance, never the disposed one.
    expect(oldApi.setColumnData).not.toHaveBeenCalled();
    expect(rendererRef.current.setColumnData).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing x", makeCols({ x: undefined })],
    ["dictionary x", makeCols({ x: ["a", "b", "c"] as unknown as PointColumns["byName"][string] })],
    ["empty", { count: 0, byName: { x: new Float64Array(0), y: new Float64Array(0) } } as PointColumns],
  ])("refuses (%s) without touching the live renderer", (_label, cols) => {
    const oldApi = { dispose: jest.fn(), setColumnData: jest.fn() };
    const rendererRef = { current: oldApi as AnyApi };
    const { params, setScales } = makeParams(rendererRef);

    expect(installColumnsFirstRenderer(cols, params)).toBe(false);

    expect(oldApi.dispose).not.toHaveBeenCalled();
    expect(rendererRef.current).toBe(oldApi);
    expect(setScales).not.toHaveBeenCalled();
    expect(mockCreateRendererAPI).not.toHaveBeenCalled();
  });
});
