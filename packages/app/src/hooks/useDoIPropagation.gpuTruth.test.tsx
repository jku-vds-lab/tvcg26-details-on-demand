/**
 * GPU motion lane TRUTH BLEND (plan-gpu-motion-lane.md §5b, CS 2026-08-18:
 * "compute the real solution behind the GPU preview and fade to it").
 * Pinned here:
 *
 *   - a GPU drag tick ALSO dispatches a worker compute of the exact field;
 *   - a result arriving while the thumb still holds its values uploads the
 *     exact field and fades it in, ending on the canonical setOpacityField
 *     with the exact values;
 *   - a result computed at values the thumb has left is dropped;
 *   - without the blend infra the exact field lands as a one-frame swap;
 *   - a new drag tick cancels a fade in flight.
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

const previewFalloffOpacityMock = jest.fn(() => Float32Array.from([1, 0.5, 0.2]));
const propagateSliderCommitOnServerMock = jest.fn(async () => true);
/** The committed exact field the commit paint hands to the renderer. */
const APPLIED = Float32Array.from([0.7, 0.3, 0.05]);

jest.mock("src/doiPropagation/serverPropagation", () => ({
  fieldPreviewRequiresSync: () => true,
  fieldPreviewExclusionsActive: () => false,
  snapshotCoords: () => ({ x: new Float64Array(3), y: new Float64Array(3) }),
  getAppliedFieldOpacity: () => APPLIED,
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

// Worker-client factory mock (the runtime module statically imports the
// worker factory ts-jest cannot parse). Captures the hook's onResult and the
// last tick params so tests can deliver truth results by hand.
type TickParams = {
  shape: string;
  prox: number;
  past: number;
  future: number;
  maxEmb: number;
};
type ResultMeta = { tickId: number; elapsedMs: number; params: TickParams };
const worker = {
  tick: jest.fn((..._args: unknown[]) => true),
  reset: jest.fn(),
  onResult: null as null | ((out: Float32Array, meta: ResultMeta) => void),
  lastParams: null as TickParams | null,
};
jest.mock("src/doiPropagation/fieldPreviewClient", () => ({
  FieldPreviewClient: class {
    constructor(cb: (out: Float32Array, meta: ResultMeta) => void) {
      worker.onResult = cb;
    }
    tick(_init: unknown, params: TickParams) {
      worker.lastParams = params;
      return worker.tick(_init, params) as boolean;
    }
    freezeTick() {
      return null;
    }
    reset() {
      worker.reset();
    }
  },
}));

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
    uploadConvergedMotionExact: jest.fn(() => true),
    blendConvergedMotionExact: jest.fn(() => true),
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

type FlaggedWindow = Window & { __gpuMotionLane?: boolean };

beforeEach(() => {
  jest.useFakeTimers();
  previewFalloffOpacityMock.mockClear();
  propagateSliderCommitOnServerMock.mockClear();
  worker.tick.mockClear();
  worker.tick.mockReturnValue(true);
  worker.onResult = null;
  worker.lastParams = null;
  // Default-ON since 2026-08-18 (CS): no flag needed.
});

afterEach(() => {
  delete (window as FlaggedWindow).__gpuMotionLane;
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

/** Two ticks (distinct values — onChange only re-enters the P/B/F branch on
 * a value change) with a flush between them: the FIRST kicks the lazy client
 * import (truth not yet dispatched), the second dispatches. */
const dragTo = async (
  result: { current: ReturnType<typeof useDoIPropagation> },
  prox: number
) => {
  tick(result, { proximitySlider: prox - 0.05 });
  await advance(30);
  tick(result, { proximitySlider: prox });
  await advance(30);
};

const MATCH_META = (prox: number): ResultMeta => ({
  tickId: 1,
  elapsedMs: 42,
  params: { shape: "log", prox, past: 0.5, future: 0.5, maxEmb: 10 },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GPU motion truth blend", () => {
  it("a GPU drag tick dispatches a worker compute at the held values", async () => {
    const { result } = mount(makeRenderer());
    await dragTo(result, 0.5);
    expect(worker.tick).toHaveBeenCalled();
    expect(worker.lastParams).toMatchObject({ prox: 0.5, past: 0.5, future: 0.5 });
  });

  it("a matching truth result fades in and ends on the exact setOpacityField", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);

    const exact = Float32Array.from([0.9, 0.4, 0.1]);
    act(() => worker.onResult!(exact, MATCH_META(0.5)));
    expect(api.uploadConvergedMotionExact).toHaveBeenCalled();

    await advance(60); // mid-fade frames
    expect(api.blendConvergedMotionExact).toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled(); // not canonical yet

    await advance(150); // past GPU_TRUTH_BLEND_MS, still before the settle
    expect(api.setOpacityField).toHaveBeenCalledTimes(1);
    const landed = (api.setOpacityField as jest.Mock).mock.calls[0][0] as Float32Array;
    expect(Array.from(landed)).toEqual(Array.from(Float32Array.from([0.9, 0.4, 0.1])));
  });

  it("a truth result at values the thumb has left is dropped", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);

    act(() => worker.onResult!(Float32Array.from([0.9, 0.4, 0.1]), MATCH_META(0.45)));
    await advance(200);
    expect(api.uploadConvergedMotionExact).not.toHaveBeenCalled();
    expect(api.blendConvergedMotionExact).not.toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled();
  });

  it("without blend infra the exact field lands as a one-frame swap", async () => {
    const api = makeRenderer({ uploadConvergedMotionExact: jest.fn(() => false) });
    const { result } = mount(api);
    await dragTo(result, 0.5);

    act(() => worker.onResult!(Float32Array.from([0.9, 0.4, 0.1]), MATCH_META(0.5)));
    expect(api.setOpacityField).toHaveBeenCalledTimes(1);
    const landed = (api.setOpacityField as jest.Mock).mock.calls[0][0] as Float32Array;
    expect(Array.from(landed)).toEqual(Array.from(Float32Array.from([0.9, 0.4, 0.1])));
  });

  it("a mid-motion release fades the committed field in (no one-frame swap)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);

    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.5,
      });
    });
    expect(api.uploadConvergedMotionExact).toHaveBeenCalledWith(APPLIED);
    expect(api.setOpacityField).not.toHaveBeenCalled(); // fading, not swapping

    await advance(250); // past GPU_TRUTH_BLEND_MS
    expect(api.setOpacityField).toHaveBeenCalledTimes(1);
    const landed = (api.setOpacityField as jest.Mock).mock.calls[0][0] as Float32Array;
    expect(Array.from(landed)).toEqual(Array.from(APPLIED));
  });

  it("a commit without a GPU drag keeps the direct upload", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.5,
      });
    });
    expect(api.uploadConvergedMotionExact).not.toHaveBeenCalled();
    expect(api.setOpacityField).toHaveBeenCalledWith(APPLIED);
  });

  it("a new drag tick cancels a fade in flight", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);

    act(() => worker.onResult!(Float32Array.from([0.9, 0.4, 0.1]), MATCH_META(0.5)));
    await advance(60); // fade running
    (api.blendConvergedMotionExact as jest.Mock).mockClear();

    tick(result, { proximitySlider: 0.4 }); // cancels the fade
    await advance(200); // past the old fade window, before the settle
    expect(api.blendConvergedMotionExact).not.toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled(); // no stale end state
  });
});
