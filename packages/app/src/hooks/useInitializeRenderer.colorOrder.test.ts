import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react";
import React, { useRef } from "react";

import store, { initialVisualizationSettings, updateSettings } from "../store";
import { useInitializeRenderer } from "./useInitializeRenderer";

const mockSetData = jest.fn();
const mockSetDataWindow = jest.fn();
const mockDisposeApi = jest.fn();
const mockSetColorMapping = jest.fn();
const mockSetStyle = jest.fn();
const mockSetOpacityParams = jest.fn();
const mockInitWebGLRenderer = jest.fn();
const mockCreateRendererAPI = jest.fn();

jest.mock("../contexts/DataContext", () => {
  const dataRef = { current: [{ x: 1, y: 2, line: 0, algo: "a", id: 0, action: "m", DoI: 1, nextEdgeCenter: { x: 0, y: 0 } }] };
  return {
    useDataRef: () => dataRef,
  };
});

jest.mock("../contexts/SegmentsContext", () => {
  const segmentsRef = { current: [] };
  return {
    useSegmentsRef: () => segmentsRef,
  };
});

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
    const mockD3 = jest.requireActual<typeof import("d3")>("d3");
    return {
      xScale: mockD3.scaleLinear().domain([0, 1]).range([0, 1]),
      yScale: mockD3.scaleLinear().domain([0, 1]).range([0, 1]),
    };
  },
}));

jest.mock("../gl/core/webglRenderer", () => ({
  initWebGLRenderer: (...args: unknown[]) => mockInitWebGLRenderer(...args),
}));

jest.mock("../gl/api/createRendererAPI", () => ({
  createRendererAPI: (...args: unknown[]) => mockCreateRendererAPI(...args),
}));

function Harness({ visualSettings }: { visualSettings: typeof initialVisualizationSettings }) {
  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const currentZoomParamsRef = useRef(null);
  const aggregateBaseLiveRef = useRef(false);
  const setScales = () => undefined;
  const setZoomTransform = () => undefined;

  useInitializeRenderer({
    canvasContainerRef: containerRef,
    internalData: [{ x: 1, y: 2, line: 0, algo: "a", id: 0, action: "m", DoI: 1, nextEdgeCenter: { x: 0, y: 0 } }],
    aggregateBaseLiveRef,
    propKnnGraph: [],
    internalKnnGraph: [],
    visualSettings,
    setScales,
    setZoomTransform,
    rendererRef,
    currentZoomParamsRef,
  });

  return React.createElement("div", { ref: containerRef });
}

describe("useInitializeRenderer color order", () => {
  beforeEach(() => {
    mockSetData.mockReset();
    mockSetDataWindow.mockReset();
    mockDisposeApi.mockReset();
    mockSetColorMapping.mockReset();
    mockSetStyle.mockReset();
    mockSetOpacityParams.mockReset();
    mockInitWebGLRenderer.mockReset();
    mockCreateRendererAPI.mockReset();

    mockInitWebGLRenderer.mockReturnValue({});
    mockCreateRendererAPI.mockReturnValue({
      setVisualSettings: jest.fn(),
      setColorMapping: mockSetColorMapping,
      setStyle: mockSetStyle,
      setOpacityParams: mockSetOpacityParams,
      // The hook migrated from the streaming setDataWindow reveal to a single
      // setData upload (issue #315) — the mock must carry both.
      setData: mockSetData,
      setDataWindow: mockSetDataWindow,
      dispose: mockDisposeApi,
    });

    store.dispatch(updateSettings(initialVisualizationSettings));
  });

  it("initializes renderer with latest store visual settings instead of stale prop settings", async () => {
    store.dispatch(updateSettings({ colorEncoding: "line" }));

    const staleProps = {
      ...store.getState().visualizationSettings,
      colorEncoding: "algo",
    };

    render(React.createElement(Harness, { visualSettings: staleProps }));

    await waitFor(() => {
      expect(mockInitWebGLRenderer).toHaveBeenCalled();
    });

    const initArgs = mockInitWebGLRenderer.mock.calls[0];
    const settingsArg = initArgs[7] as typeof initialVisualizationSettings;
    expect(settingsArg.colorEncoding).toBe("line");
    expect(mockSetColorMapping).toHaveBeenCalledWith(
      expect.objectContaining({ colorEncoding: "line" })
    );
  });
});
