// Issue #315 G4 slice 2 — aggregate-first init helper + menu-switch epoch.
//
// Covers: the extracted initAggregateFirstRenderer helper (supersede aborts,
// null-backend no-op, mount-path guard parity, cleanup disposal) and the
// hook's beginDatasetSwitch epoch machinery (rapid double-switch disposal,
// data-landed-for-epoch abort).

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render } from "@testing-library/react";
import React, { useEffect, useRef } from "react";

import {
  initAggregateFirstRenderer,
  useInitializeRenderer,
  type InitializeRendererControls,
} from "./useInitializeRenderer";
import store from "../store";

// ── module mocks (mirror the colorOrder test harness) ──────────────────────
const dataRef = { current: [] as unknown[] };
jest.mock("../contexts/DataContext", () => ({ useDataRef: () => dataRef }));
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

jest.mock("../utils/computeScales", () => ({
  computeScales: () => {
    const d3 = jest.requireActual<typeof import("d3")>("d3");
    return {
      xScale: d3.scaleLinear().domain([0, 1]).range([0, 1]),
      yScale: d3.scaleLinear().domain([0, 1]).range([0, 1]),
    };
  },
}));

jest.mock("../utils/datasetLoadInstrumentation", () => ({
  markDatasetLoadPhase: () => undefined,
}));

const mockInitWebGLRenderer = jest.fn((..._args: unknown[]) => ({}));
jest.mock("../gl/core/webglRenderer", () => ({
  initWebGLRenderer: (...args: unknown[]) => mockInitWebGLRenderer(...args),
}));

// Each createRendererAPI call returns a FRESH mock api with its own dispose,
// so we can assert exactly which renderer instance was disposed.
let apiSeq = 0;
const mockCreateRendererAPI = jest.fn((..._args: unknown[]) => {
  apiSeq += 1;
  return {
    id: apiSeq,
    setVisualSettings: jest.fn(),
    setColorMapping: jest.fn(),
    setStyle: jest.fn(),
    setOpacityParams: jest.fn(),
    setData: jest.fn(),
    setAggregateSource: jest.fn(),
    dispose: jest.fn(),
  };
});
jest.mock("../gl/api/createRendererAPI", () => ({
  createRendererAPI: (...args: unknown[]) => mockCreateRendererAPI(...args),
}));

// Controllable @scaling.resolveAggregateSource.
const mockResolveAggregateSource = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock("@scaling", () => ({
  resolveAggregateSource: (...args: unknown[]) => mockResolveAggregateSource(...args),
}));

const AGG_META = {
  minX: 0,
  minY: 0,
  maxX: 10,
  maxY: 10,
  binsPerTile: 16,
  maxLevel: 4,
  colorColumn: "algo",
  classes: [],
};
const makeSource = () => ({ meta: AGG_META, getTile: async () => null });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function mockFetchManifest(withBackend: boolean) {
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    json: async () =>
      withBackend
        ? { backend: { kind: "tabular-stats", baseUrl: "http://127.0.0.1:1", datasetId: "x" } }
        : {},
  }));
}

const flush = async () => {
  // let the helper's awaited fetch + resolveAggregateSource microtasks settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

function callHelper(opts: {
  rendererRef: { current: AnyApi };
  isSuperseded: () => boolean;
  onInstalled?: () => void;
}) {
  const container = global.document.createElement("div");
  return initAggregateFirstRenderer({
    container,
    manifestPath: "/manifest.json",
    rendererRef: opts.rendererRef,
    currentZoomParamsRef: { current: null },
    setScales: () => undefined,
    setZoomTransform: () => undefined,
    isSuperseded: opts.isSuperseded,
    onInstalled: opts.onInstalled,
  });
}

describe("initAggregateFirstRenderer (G4 slice 2 helper)", () => {
  beforeEach(() => {
    apiSeq = 0;
    dataRef.current = [];
    mockInitWebGLRenderer.mockClear();
    mockCreateRendererAPI.mockClear();
    mockResolveAggregateSource.mockReset();
    mockResolveAggregateSource.mockResolvedValue(makeSource());
    mockFetchManifest(true);
  });

  it("installs the aggregate renderer when not superseded", async () => {
    const rendererRef = { current: null as AnyApi };
    const onInstalled = jest.fn();
    callHelper({ rendererRef, isSuperseded: () => false, onInstalled });
    await flush();
    expect(mockCreateRendererAPI).toHaveBeenCalledTimes(1);
    expect(rendererRef.current).not.toBeNull();
    expect(rendererRef.current.setAggregateSource).toHaveBeenCalledWith(expect.anything());
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it("aborts (no install, live renderer untouched) when superseded", async () => {
    const live = mockCreateRendererAPI();
    const rendererRef = { current: live as AnyApi };
    mockCreateRendererAPI.mockClear();
    callHelper({ rendererRef, isSuperseded: () => true });
    await flush();
    expect(mockCreateRendererAPI).not.toHaveBeenCalled();
    expect(rendererRef.current).toBe(live); // old renderer NOT disposed/replaced
    expect(live.dispose).not.toHaveBeenCalled();
  });

  it("is a no-op when the manifest declares no backend", async () => {
    mockFetchManifest(false);
    const rendererRef = { current: null as AnyApi };
    callHelper({ rendererRef, isSuperseded: () => false });
    await flush();
    expect(mockResolveAggregateSource).not.toHaveBeenCalled();
    expect(mockCreateRendererAPI).not.toHaveBeenCalled();
    expect(rendererRef.current).toBeNull();
  });

  it("is a no-op when the backend resolves no aggregate source (serverless)", async () => {
    mockResolveAggregateSource.mockResolvedValue(null);
    const rendererRef = { current: null as AnyApi };
    callHelper({ rendererRef, isSuperseded: () => false });
    await flush();
    expect(mockCreateRendererAPI).not.toHaveBeenCalled();
    expect(rendererRef.current).toBeNull();
  });

  describe("mount-path guard parity", () => {
    const mountGuard = (rendererRef: { current: AnyApi }) => () =>
      !!rendererRef.current || dataRef.current.length > 0;

    it("aborts when a renderer already exists", async () => {
      const live = mockCreateRendererAPI();
      const rendererRef = { current: live as AnyApi };
      mockCreateRendererAPI.mockClear();
      callHelper({ rendererRef, isSuperseded: mountGuard(rendererRef) });
      await flush();
      expect(mockCreateRendererAPI).not.toHaveBeenCalled();
    });

    it("aborts when data has already landed", async () => {
      dataRef.current = [{ x: 0, y: 0 }];
      const rendererRef = { current: null as AnyApi };
      callHelper({ rendererRef, isSuperseded: mountGuard(rendererRef) });
      await flush();
      expect(mockCreateRendererAPI).not.toHaveBeenCalled();
    });

    it("installs when neither renderer nor data exist", async () => {
      const rendererRef = { current: null as AnyApi };
      callHelper({ rendererRef, isSuperseded: mountGuard(rendererRef) });
      await flush();
      expect(mockCreateRendererAPI).toHaveBeenCalledTimes(1);
      expect(rendererRef.current).not.toBeNull();
    });
  });

  it("cleanup disposes the renderer it created while it is still live", async () => {
    const rendererRef = { current: null as AnyApi };
    const cleanup = callHelper({ rendererRef, isSuperseded: () => false });
    await flush();
    const created = rendererRef.current;
    cleanup();
    expect(created.dispose).toHaveBeenCalledTimes(1);
    expect(rendererRef.current).toBeNull();
  });

  it("cleanup does NOT dispose once the renderer has moved on", async () => {
    const rendererRef = { current: null as AnyApi };
    const cleanup = callHelper({ rendererRef, isSuperseded: () => false });
    await flush();
    const created = rendererRef.current;
    const replacement = mockCreateRendererAPI();
    rendererRef.current = replacement; // data init took over
    cleanup();
    expect(created.dispose).not.toHaveBeenCalled();
    expect(rendererRef.current).toBe(replacement);
  });
});

// ── beginDatasetSwitch epoch machinery (via the hook) ──────────────────────

function Harness(props: {
  internalData: unknown[] | null;
  aggregateBaseLiveRef: { current: boolean };
  onReady: (c: InitializeRendererControls, rendererRef: { current: AnyApi }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<AnyApi>(null);
  const currentZoomParamsRef = useRef(null);
  const controls = useInitializeRenderer({
    canvasContainerRef: containerRef,
    internalData: props.internalData as never,
    bootManifestPath: undefined, // no mount boot — isolate the switch path
    aggregateBaseLiveRef: props.aggregateBaseLiveRef,
    propKnnGraph: [],
    internalKnnGraph: [],
    visualSettings: store.getState().visualizationSettings,
    setScales: () => undefined,
    setZoomTransform: () => undefined,
    rendererRef,
    currentZoomParamsRef,
  });
  useEffect(() => {
    props.onReady(controls, rendererRef);
  });
  return React.createElement("div", { ref: containerRef });
}

/** Deferred whose resolve is captured for manual firing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useInitializeRenderer.beginDatasetSwitch (G4 slice 2 epoch)", () => {
  beforeEach(() => {
    apiSeq = 0;
    dataRef.current = [];
    mockInitWebGLRenderer.mockClear();
    mockCreateRendererAPI.mockClear();
    mockResolveAggregateSource.mockReset();
    mockFetchManifest(true);
  });

  it("rapid double-switch: first installed base is disposed, second survives", async () => {
    const dA = deferred<ReturnType<typeof makeSource>>();
    const dB = deferred<ReturnType<typeof makeSource>>();
    mockResolveAggregateSource
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise);

    let controls!: InitializeRendererControls;
    let rendererRef!: { current: AnyApi };
    render(
      React.createElement(Harness, {
        internalData: null,
        aggregateBaseLiveRef: { current: false },
        onReady: (c, r) => {
          controls = c;
          rendererRef = r;
        },
      })
    );

    // Switch A, let its aggregate land → base A installed.
    act(() => controls.beginDatasetSwitch("/A/manifest.json"));
    await act(async () => {
      dA.resolve(makeSource());
      await Promise.resolve();
      await Promise.resolve();
    });
    const apiA = rendererRef.current;
    expect(apiA).not.toBeNull();

    // Switch B supersedes A: A's cleanup disposes it immediately.
    act(() => controls.beginDatasetSwitch("/B/manifest.json"));
    expect(apiA.dispose).toHaveBeenCalledTimes(1);

    // B's aggregate lands → base B installed and NOT disposed.
    await act(async () => {
      dB.resolve(makeSource());
      await Promise.resolve();
      await Promise.resolve();
    });
    const apiB = rendererRef.current;
    expect(apiB).not.toBeNull();
    expect(apiB).not.toBe(apiA);
    expect(apiB.dispose).not.toHaveBeenCalled();
  });

  it("aborts a pending switch once data for its own epoch has landed", async () => {
    const dA = deferred<ReturnType<typeof makeSource>>();
    mockResolveAggregateSource.mockReturnValue(dA.promise);

    let controls!: InitializeRendererControls;
    let rendererRef!: { current: AnyApi };
    const aggregateBaseLiveRef = { current: false };
    const { rerender } = render(
      React.createElement(Harness, {
        internalData: null,
        aggregateBaseLiveRef,
        onReady: (c, r) => {
          controls = c;
          rendererRef = r;
        },
      })
    );

    // Kick the switch (epoch 1), aggregate fetch still pending.
    act(() => controls.beginDatasetSwitch("/A/manifest.json"));

    // Real data for this selection lands first → main init installs the data
    // renderer and stamps dataLandedEpoch = 1.
    act(() => {
      rerender(
        React.createElement(Harness, {
          internalData: [{ x: 1, y: 2, line: 0, id: 0, DoI: 1, nextEdgeCenter: { x: 0, y: 0 } }],
          aggregateBaseLiveRef,
          onReady: (c, r) => {
            controls = c;
            rendererRef = r;
          },
        })
      );
    });
    const dataApi = rendererRef.current;
    expect(dataApi).not.toBeNull();
    const createCallsAfterData = mockCreateRendererAPI.mock.calls.length;

    // Now the aggregate resolves — it must abort (data for epoch 1 landed),
    // never downgrading the data renderer back to an aggregate base.
    await act(async () => {
      dA.resolve(makeSource());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockCreateRendererAPI.mock.calls.length).toBe(createCallsAfterData);
    expect(rendererRef.current).toBe(dataApi);
    expect(dataApi.dispose).not.toHaveBeenCalled();
  });
});
