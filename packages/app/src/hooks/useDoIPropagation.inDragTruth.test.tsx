/**
 * IN-DRAG TRUTH lane WIRING (issue #315, CS 2026-07-26).
 *
 * The lane's scheduling invariants are pinned purely in
 * doiPropagation/inDragTruth.test.ts. What this suite pins is the hook half —
 * that a truth arrival actually re-anchors the picture, and that a stale one
 * cannot touch it:
 *
 *   - a proximity drag asks the preview worker to RE-FREEZE at the value held;
 *   - the arrival uploads the new layers, re-asserts the LIVE slider params (the
 *     thumb moved while the request was out) and pushes the exact field into the
 *     opacity texture, so the DoI-color encoding and the release cross-fade's
 *     start state are correct too;
 *   - a stale arrival (unknown tick id, or one outliving the release) paints
 *     nothing;
 *   - a chain-slider move invalidates the freeze, so the lane stops with it.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
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

const RECORD_DIST = Float32Array.from([0, 2, Infinity]);

jest.mock("src/doiPropagation/serverPropagation", () => ({
  fieldPreviewRequiresSync: () => false,
  fieldPreviewExclusionsActive: () => false,
  snapshotCoords: () => ({ x: new Float64Array(3), y: new Float64Array(3) }),
  getAppliedFieldOpacity: () => null,
  getFalloffShape: () => "exp",
  getResidentField: () => ({
    revision: 7,
    focusActive: true,
    nLeaves: 3,
    recordDist: RECORD_DIST,
    visibleRanges: [],
  }),
  getSeedClampIndices: () => [0],
  hasResidentFieldPreview: () => true,
  previewFalloffOpacity: () => null,
  propagateSliderCommitOnServer: async () => true,
  serverPropagationEligible: () => true,
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

// The real client statically imports the worker factory (import.meta), which
// ts-jest cannot parse — a factory mock keeps it out of the graph entirely AND
// hands us the result callback the hook installs.
type ResultMeta = {
  tickId: number;
  frozen?: { srcDist: Float32Array; gain: Float32Array; seedChain: Float32Array };
  elapsedMs: number;
};
const worker = {
  freezeTick: jest.fn((..._args: unknown[]) => 1 as number | null),
  tick: jest.fn(() => true),
  reset: jest.fn(),
  onResult: null as null | ((out: Float32Array, meta: ResultMeta) => void),
  nextTickId: 1,
};
jest.mock("src/doiPropagation/fieldPreviewClient", () => ({
  FieldPreviewClient: class {
    constructor(cb: (out: Float32Array, meta: ResultMeta) => void) {
      worker.onResult = cb;
    }
    tick() { return worker.tick(); }
    freezeTick(...args: unknown[]) { return worker.freezeTick(...args); }
    reset() { worker.reset(); }
  },
}));

const mkPoint = (id: number): DataPoint =>
  ({
    x: id, y: 0, line: 0, algo: "a", id, action: "",
    DoI: 1, doiGroup: "gray", selected: id === 0,
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

function makeRenderer() {
  return {
    setOpacityMix: jest.fn(),
    setOpacityParams: jest.fn(),
    setOpacityField: jest.fn(),
    setFalloffPreview: jest.fn(),
    setFalloffPreviewBlend: jest.fn(),
    setInteractiveQuality: jest.fn(),
    setDistanceField: jest.fn(),
    render: jest.fn(),
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

/** The layers a truth arrival would carry (values differ from any freeze the
 * main thread could have made, so the assertions cannot pass by accident). */
const TRUTH_LAYERS = {
  srcDist: Float32Array.from([0, 0, 0]),
  gain: Float32Array.from([1, 0.25, 0.125]),
  seedChain: Float32Array.from([1, 0.25, 0.125]),
};
const TRUTH_FIELD = Float32Array.from([1, 0.25, 0.125]);

/** Drive a proximity drag tick and let its rAF + the lazy client import settle. */
async function dragTo(
  result: { current: ReturnType<typeof useDoIPropagation> },
  prox: number
) {
  await act(async () => {
    result.current.handlePropagationSliderChange({ ...SETTINGS, proximitySlider: prox });
    jest.advanceTimersByTime(32);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  worker.freezeTick.mockClear();
  worker.tick.mockClear();
  worker.reset.mockClear();
  worker.onResult = null;
});

describe("a proximity drag runs an in-drag truth lane", () => {
  it("asks the worker to re-freeze at the value being held", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    // First tick only kicks the lazy client import (nothing to ask yet).
    await dragTo(result, 0.5);
    expect(worker.freezeTick).not.toHaveBeenCalled();
    // Second tick, past the lane's minimum interval, dispatches.
    jest.advanceTimersByTime(120);
    await dragTo(result, 0.4);
    expect(worker.freezeTick).toHaveBeenCalledTimes(1);
    const [, params] = worker.freezeTick.mock.calls[0] as [
      unknown,
      { prox: number; shape: string; freeze?: boolean }
    ];
    expect(params.prox).toBe(0.4);
    expect(params.shape).toBe("exp");
  });

  it("re-anchors the preview on an arrival: new layers + LIVE params + exact field", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);
    jest.advanceTimersByTime(120);
    await dragTo(result, 0.4);
    (api.setDistanceField as jest.Mock).mockClear();
    (api.setFalloffPreview as jest.Mock).mockClear();
    (api.setOpacityField as jest.Mock).mockClear();

    // The thumb keeps moving while the request is out, so the arrival must remap
    // the re-anchored chain to where the slider IS, not to 0.4.
    jest.advanceTimersByTime(10);
    await dragTo(result, 0.35);

    act(() => {
      worker.onResult!(TRUTH_FIELD, { tickId: 1, frozen: TRUTH_LAYERS, elapsedMs: 20 });
    });

    expect(api.setDistanceField).toHaveBeenCalledWith(RECORD_DIST, TRUTH_LAYERS);
    // params for the LIVE slider (0.35), not the requested 0.4.
    const [params] = (api.setFalloffPreview as jest.Mock).mock.calls.at(-1) as [
      { mode: number; sScaled: number }
    ];
    const sAt = (p: number) => p / (1 - p);
    expect(params.mode).toBe(1);
    expect(params.sScaled).toBeCloseTo(sAt(0.35), 6);
    // The exact field lands in the texture too (DoI colors + the fade's start).
    expect(api.setOpacityField).toHaveBeenCalledWith(TRUTH_FIELD);
  });

  it("discards an arrival with an unknown tick id", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);
    jest.advanceTimersByTime(120);
    await dragTo(result, 0.4);
    (api.setDistanceField as jest.Mock).mockClear();
    (api.setOpacityField as jest.Mock).mockClear();

    act(() => {
      worker.onResult!(TRUTH_FIELD, { tickId: 4242, frozen: TRUTH_LAYERS, elapsedMs: 20 });
    });
    expect(api.setDistanceField).not.toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled();
  });

  it("discards an arrival that outlives the release", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);
    jest.advanceTimersByTime(120);
    await dragTo(result, 0.4);
    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.4,
      });
    });
    (api.setDistanceField as jest.Mock).mockClear();

    act(() => {
      worker.onResult!(TRUTH_FIELD, { tickId: 1, frozen: TRUTH_LAYERS, elapsedMs: 20 });
    });
    // Painting here would resurrect the drag preview on top of the committed
    // field — the lane's whole point is that it never fights the commit.
    expect(api.setDistanceField).not.toHaveBeenCalled();
  });

  it("stops asking while a chain slider is being dragged (the freeze is stale)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);
    jest.advanceTimersByTime(120);
    worker.freezeTick.mockClear();
    await act(async () => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, pastSlider: 0.9 });
      jest.advanceTimersByTime(32);
      await Promise.resolve();
    });
    expect(worker.freezeTick).not.toHaveBeenCalled();
  });

  it("disarms after a slow round-trip instead of asking again", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    await dragTo(result, 0.5);
    jest.advanceTimersByTime(120);
    await dragTo(result, 0.4);
    expect(worker.freezeTick).toHaveBeenCalledTimes(1);

    // The probe came back far too slowly: the drag must go back to being pure
    // shader preview rather than keep paying for corrections.
    act(() => {
      worker.onResult!(TRUTH_FIELD, { tickId: 1, frozen: TRUTH_LAYERS, elapsedMs: 5000 });
    });
    for (const p of [0.35, 0.3, 0.25, 0.2]) {
      jest.advanceTimersByTime(120);
      await dragTo(result, p);
    }
    expect(worker.freezeTick).toHaveBeenCalledTimes(1);
  });
});
