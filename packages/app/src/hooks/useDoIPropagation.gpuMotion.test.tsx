/**
 * GPU motion lane routing (plan-gpu-motion-lane.md). Pinned here:
 *
 *   - default ON + capable renderer: a P/B/F drag uploads the field data once
 *     per revision and runs the GPU tick — the worker/sync preview lanes and
 *     the parked shader lane stay dark;
 *   - the settle-commit still arms and fires on the GPU path (the exact CPU
 *     flush at rest is the contract's other half);
 *   - pins/labeled exclusions bypass the GPU lane for the synchronous remap;
 *   - explicit opt-out (window flag false) keeps the pre-lane routing;
 *   - a failed GPU tick latches the permanent worker/sync fallback.
 */

import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { DataProvider, useDataRef } from "src/contexts/DataContext";
import { SegmentsProvider } from "src/contexts/SegmentsContext";
import { TrajectoryMidpointsProvider } from "src/contexts/TrajectoryMidpointsContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { RendererAPI } from "src/gl/api/RendererAPI";
import store from "src/store";
import type { SliderSettings } from "src/components/InterestTabSliders";
import { useDoIPropagation } from "./useDoIPropagation";

// ── Doubles ──────────────────────────────────────────────────────────────────

const PREVIEW_BUFFER = Float32Array.from([1, 0.5, 0.2]);
const previewFalloffOpacityMock = jest.fn(() => PREVIEW_BUFFER);
const propagateSliderCommitOnServerMock = jest.fn(async () => true);
const exclusionsActiveMock = jest.fn(() => false);

jest.mock("src/doiPropagation/serverPropagation", () => ({
  fieldPreviewRequiresSync: () => true,
  fieldPreviewExclusionsActive: () => exclusionsActiveMock(),
  snapshotCoords: () => ({ x: new Float64Array(3), y: new Float64Array(3) }),
  getAppliedFieldOpacity: () => null,
  getFalloffShape: () => "log",
  getFieldPreviewRaster: () => ({
    rows: Int32Array.from([0, 0, 0]),
    cols: Int32Array.from([0, 1, 2]),
    frows: Float64Array.from([0, 0, 0]),
    fcols: Float64Array.from([0, 1, 2]),
    W: 3,
    H: 1,
    cellSize: 1,
  }),
  getResidentField: () => ({
    revision: 7,
    focusActive: true,
    nLeaves: 3,
    recordDist: Float32Array.from([0, 2, 4]),
    visibleRanges: [],
  }),
  getSeedClampIndices: () => [0],
  hasResidentFieldPreview: () => true,
  previewFalloffOpacity: (...args: unknown[]) => previewFalloffOpacityMock(...(args as [])),
  propagateSliderCommitOnServer: (...args: unknown[]) =>
    propagateSliderCommitOnServerMock(...(args as [])),
  serverPropagationEligible: () => true,
}));

// Spy on rasterize (the coarse-res path re-rasterizes; the exact default
// reuses the engine raster) while keeping the real implementation.
const rasterizeSpy = jest.fn();
jest.mock("src/doiPropagation/fieldDistanceCore", () => {
  const actual = jest.requireActual<
    typeof import("src/doiPropagation/fieldDistanceCore")
  >("src/doiPropagation/fieldDistanceCore");
  return {
    ...actual,
    rasterize: (...args: Parameters<typeof actual.rasterize>) => {
      rasterizeSpy(...args);
      return actual.rasterize(...args);
    },
  };
});

jest.mock("src/clustering/hdbscanClustering", () => ({
  bumpClusteringEpoch: () => 1,
  isCurrentClusteringEpoch: () => true,
  runHdbscanClusteringWithStatus: async () => undefined,
  runTrajectoryMidpointClusteringWithStatus: async () => undefined,
}));

jest.mock("@scaling", () => ({ resolveCutProvider: () => null }));

jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search() { return this.items; }
      remove() { return this; }
    },
  };
});

const mkPoint = (id: number): DataPoint =>
  ({
    x: id,
    y: 0,
    line: 0,
    algo: "a",
    id,
    action: "",
    DoI: 1,
    doiGroup: "gray",
    selected: id === 0,
    nextEdgeCenter: { x: id, y: 0 },
  }) as unknown as DataPoint;

const NODES: DataPoint[] = [mkPoint(0), mkPoint(1), mkPoint(2)];

const SETTINGS: SliderSettings = {
  proximitySlider: 0.6,
  pastSlider: 0.5,
  futureSlider: 0.5,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function makeRenderer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    setOpacityMix: jest.fn(),
    setOpacityParams: jest.fn(),
    setOpacityField: jest.fn(),
    setFalloffPreview: jest.fn(),
    setFalloffPreviewBlend: jest.fn(),
    setInteractiveQuality: jest.fn(),
    setDistanceField: jest.fn(),
    setConvergedMotionField: jest.fn(() => true),
    runConvergedMotionTick: jest.fn(() => true),
    readConvergedMotionField: jest.fn(() => null),
    render: jest.fn(),
    ...overrides,
  } as unknown as RendererAPI;
}

const SeedNodes = ({ children }: { children: ReactNode }) => {
  const dataRef = useDataRef();
  dataRef.current = NODES;
  return <>{children}</>;
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <Provider store={store}>
    <DataProvider>
      <SegmentsProvider>
        <TrajectoryMidpointsProvider>
          <SeedNodes>{children}</SeedNodes>
        </TrajectoryMidpointsProvider>
      </SegmentsProvider>
    </DataProvider>
  </Provider>
);

function mount(api: RendererAPI) {
  const currentSliderSettingsRef = { current: { ...SETTINGS } };
  return renderHook(
    () =>
      useDoIPropagation({
        setSliderSettings: () => {},
        currentSliderSettingsRef,
        sliderUpdateFrameRef: { current: null },
        rendererRef: { current: api },
        visualSettings: {
          maxEmbeddingDistance: 10,
          minimumOpacityClamping: 0.1,
          maximumOpacityClamping: 1,
        } as never,
        performZoomClustering: () => {},
        fullSelectionHdbscan: undefined,
        fullSelectionMidpointHdbscan: undefined,
      }),
    { wrapper }
  );
}

type FlaggedWindow = Window & {
  __gpuMotionLane?: boolean;
  __gpuMotionGridRes?: number;
};

beforeEach(() => {
  jest.useFakeTimers();
  previewFalloffOpacityMock.mockClear();
  propagateSliderCommitOnServerMock.mockClear();
  rasterizeSpy.mockClear();
  exclusionsActiveMock.mockReset();
  exclusionsActiveMock.mockReturnValue(false);
  // Default-ON since 2026-08-18 (CS): no flag needed.
});

afterEach(() => {
  delete (window as FlaggedWindow).__gpuMotionLane;
  delete (window as FlaggedWindow).__gpuMotionGridRes;
});

const tick = (
  result: { current: ReturnType<typeof useDoIPropagation> },
  overrides: Partial<SliderSettings>
) => {
  act(() => {
    result.current.handlePropagationSliderChange({ ...SETTINGS, ...overrides });
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GPU motion lane routing", () => {
  it("default ON: a P/B/F drag uploads once and runs the GPU tick; other lanes stay dark", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(100); // fires the coalescing rAF, stays under the settle
    tick(result, { proximitySlider: 0.45 });
    await advance(100);

    expect(api.setConvergedMotionField).toHaveBeenCalledTimes(1); // once per revision
    expect(api.runConvergedMotionTick).toHaveBeenCalled();
    // No worker/sync preview, no parked shader lane, no quality reduction.
    expect(previewFalloffOpacityMock).not.toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled();
    expect(api.setDistanceField).not.toHaveBeenCalled();
    expect(api.setInteractiveQuality).not.toHaveBeenCalledWith(true);
  });

  it("the default exact-res path reuses the engine raster (no re-rasterize)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(100);

    expect(api.setConvergedMotionField).toHaveBeenCalledTimes(1);
    expect(rasterizeSpy).not.toHaveBeenCalled();
  });

  it("a coarse motion res (knob or adaptive tier — same seam) re-rasterizes at that res", async () => {
    (window as FlaggedWindow).__gpuMotionGridRes = 256;
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(100);

    expect(api.setConvergedMotionField).toHaveBeenCalledTimes(1);
    expect(rasterizeSpy).toHaveBeenCalledTimes(1);
    expect(rasterizeSpy.mock.calls[0][2]).toBe(256);
    expect(api.runConvergedMotionTick).toHaveBeenCalled();
  });

  it("the settle-commit still fires on the GPU path (exact CPU flush at rest)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(200);
    expect(propagateSliderCommitOnServerMock).not.toHaveBeenCalled();
    await advance(200); // > 350 ms rest
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(1);
  });

  it("pins/labeled exclusions bypass the GPU lane for the synchronous remap", async () => {
    exclusionsActiveMock.mockReturnValue(true);
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(150);

    expect(api.setConvergedMotionField).not.toHaveBeenCalled();
    expect(api.runConvergedMotionTick).not.toHaveBeenCalled();
    expect(previewFalloffOpacityMock).toHaveBeenCalled();
  });

  it("explicit opt-out (window flag false) keeps the pre-lane routing", async () => {
    (window as FlaggedWindow).__gpuMotionLane = false;
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(150);

    expect(api.setConvergedMotionField).not.toHaveBeenCalled();
    expect(api.runConvergedMotionTick).not.toHaveBeenCalled();
    expect(previewFalloffOpacityMock).toHaveBeenCalled();
  });

  it("a failed GPU tick latches the permanent fallback and keeps the drag alive", async () => {
    const api = makeRenderer({ runConvergedMotionTick: jest.fn(() => false) });
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(150); // rAF fires, tick fails, fallback preview runs
    expect(previewFalloffOpacityMock).toHaveBeenCalled();

    (api.runConvergedMotionTick as jest.Mock).mockClear();
    tick(result, { proximitySlider: 0.45 });
    await advance(150);
    expect(api.runConvergedMotionTick).not.toHaveBeenCalled(); // latched
  });

  it("an upload refusal (unsupported stack) latches the fallback too", async () => {
    const api = makeRenderer({ setConvergedMotionField: jest.fn(() => false) });
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(150);

    expect(api.runConvergedMotionTick).not.toHaveBeenCalled();
    expect(previewFalloffOpacityMock).toHaveBeenCalled();
  });
});
