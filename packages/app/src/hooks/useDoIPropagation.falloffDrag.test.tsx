/**
 * Proximity-drag wiring for the GPU falloff preview (issue #315).
 *
 * The shader can only preview symmetrically if the hook feeds it the FROZEN
 * CHAIN (chain source distance, gain, seed chain) alongside the distance field —
 * the shader term then carries the whole preview DoI and REPLACES the committed
 * opacity texture (see fieldPreview.contract.test.ts for the formula, and
 * node.frag for the composition). Pinned here:
 *
 *   - a proximity-only tick uploads the frozen layers once per freeze and then
 *     only writes uniforms — no opacity re-upload, no worker;
 *   - a past/future tick turns the shader term OFF (its frozen chain is stale)
 *     and hands the preview back to the worker path.
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

// ── Doubles ──────────────────────────────────────────────────────────────────

// One trajectory of 3 points; index 0 is the selected seed. Distances put index
// 1 in reach and index 2 out of it.
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

// Clustering pulls the worker factories (import.meta) into the module graph —
// stub it out exactly like the sibling previewHold suite.
jest.mock("src/clustering/hdbscanClustering", () => ({
  bumpClusteringEpoch: () => 1,
  isCurrentClusteringEpoch: () => true,
  runHdbscanClusteringWithStatus: async () => undefined,
  runTrajectoryMidpointClusteringWithStatus: async () => undefined,
}));

jest.mock("@scaling", () => ({ resolveCutProvider: () => null }));

// Mock rbush (ESM) to avoid transform issues in Jest — same shim the sibling
// useDoIPropagation.previewHold suite uses.
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

/** Blend weights the commit pushed, in order. */
const blendWeights = (api: RendererAPI): number[] =>
  ((api.setFalloffPreviewBlend as jest.Mock).mock.calls as Array<[number]>).map(
    ([t]) => t
  );

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
  const hook = renderHook(
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
  return hook;
}

/** Run every rAF callback queued by the drag handler. */
function flushFrames() {
  jest.advanceTimersByTime(32);
}

beforeEach(() => {
  jest.useFakeTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("proximity drag feeds the shader a frozen chain", () => {
  it("uploads the frozen chain layers, then only writes uniforms", () => {
    const api = makeRenderer();
    const { result } = mount(api);

    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, proximitySlider: 0.5 });
      flushFrames();
    });

    expect(api.setDistanceField).toHaveBeenCalledTimes(1);
    const [dist, frozen] = (api.setDistanceField as jest.Mock).mock.calls[0] as [
      Float32Array,
      { srcDist: Float32Array; gain: Float32Array; seedChain: Float32Array }
    ];
    expect(Array.from(dist)).toEqual([0, 2, Infinity]);
    // Index 0 is the seed; index 1 keeps its own distance as its best source;
    // index 2 is unreachable but chains off index 1 with the future decay.
    expect(Array.from(frozen.srcDist)).toEqual([0, 2, 2]);
    expect(Array.from(frozen.gain)).toEqual([1, 1, 0.5]);
    // The seed chain is slider-independent: the seed plus future^k along the line.
    expect(Array.from(frozen.seedChain)).toEqual([1, 0.5, 0.25]);

    // The preview params reached the shader; the committed opacity texture was
    // NOT touched (a 4 MB re-upload per tick is what this path exists to avoid).
    expect(api.setFalloffPreview).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 1, shapeCode: 0 })
    );
    expect(api.setOpacityField).not.toHaveBeenCalled();

    // A further proximity move reuses the freeze: uniforms only.
    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, proximitySlider: 0.4 });
      flushFrames();
    });
    expect(api.setDistanceField).toHaveBeenCalledTimes(1);
    expect(api.setFalloffPreview).toHaveBeenCalledTimes(2);
  });

  it("turns the shader term off when a chain slider moves (its freeze is stale)", () => {
    const api = makeRenderer();
    const { result } = mount(api);

    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, pastSlider: 0.9 });
      flushFrames();
    });

    expect(api.setFalloffPreview).toHaveBeenCalledWith(null);
    expect(api.setDistanceField).not.toHaveBeenCalled();
  });

  it("re-freezes at the new chain values on the next proximity-only move", () => {
    const api = makeRenderer();
    const { result } = mount(api);

    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, futureSlider: 0.9 });
      flushFrames();
    });
    act(() => {
      result.current.handlePropagationSliderChange({
        ...SETTINGS,
        futureSlider: 0.9,
        proximitySlider: 0.5,
      });
      flushFrames();
    });

    expect(api.setDistanceField).toHaveBeenCalledTimes(1);
    const [, frozen] = (api.setDistanceField as jest.Mock).mock.calls[0] as [
      Float32Array,
      { srcDist: Float32Array; gain: Float32Array; seedChain: Float32Array }
    ];
    // The freeze used the NEW forward decay (0.9), not the committed 0.5 — the
    // frozen chain always describes the chain sliders the user is holding. At
    // 0.9 the seed chain also OVERTAKES index 1's own spatial term, so index 2
    // now hangs off the seed two hops away (0.9²) instead of off index 1.
    expect(frozen.gain[2]).toBeCloseTo(0.81, 6);
    expect(frozen.srcDist[2]).toBe(0); // the seed's own distance
    expect(frozen.seedChain[2]).toBeCloseTo(0.81, 6);
    expect(api.setFalloffPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 1 })
    );
  });
});

// ── Release cross-fade (issue #315, CS 2026-07-26) ───────────────────────────
//
// The commit used to replace the held preview with the committed field in ONE
// frame, so whatever drift the frozen chain accumulated over the drag landed as a
// visible pop. It now walks the shaders' mix uniform from the preview onto the
// (already uploaded) committed texture, and ENDS by switching the preview off —
// so the end state is the exact committed field, not a lerp of it.

describe("the release commit cross-fades onto the committed field", () => {
  const drag = (result: { current: ReturnType<typeof useDoIPropagation> }) => {
    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, proximitySlider: 0.3 });
      flushFrames();
    });
  };

  const commit = async (result: { current: ReturnType<typeof useDoIPropagation> }) => {
    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.3,
      });
    });
  };

  it("uploads the committed field FIRST, then fades — the preview is never dropped early", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    drag(result);
    (api.setOpacityField as jest.Mock).mockClear();
    (api.setFalloffPreview as jest.Mock).mockClear();
    await commit(result);

    // The texture is in place and the fade has started from pure preview...
    expect(api.setOpacityField).toHaveBeenCalledTimes(1);
    expect(blendWeights(api)[0]).toBe(0);
    // ...and the preview is STILL on: dropping it here is the pop this replaces.
    expect(api.setFalloffPreview).not.toHaveBeenCalledWith(null);
    // The interactive-quality restore is deliberately NOT deferred into the fade:
    // sharpening the backing store 150 ms after release would be a second pop.
    expect(api.setInteractiveQuality).toHaveBeenLastCalledWith(false);
  });

  it("advances the weight over the fade and ends by turning the preview OFF", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    drag(result);
    await commit(result);

    act(() => { jest.advanceTimersByTime(48); });
    const midway = blendWeights(api);
    expect(midway.length).toBeGreaterThan(1);
    for (let i = 1; i < midway.length; i++) {
      expect(midway[i]).toBeGreaterThan(midway[i - 1]);
    }
    // A weight of 1 is never pushed: the end state is the preview switched off,
    // which IS the committed field (a mix at 1.0 would only approximate it).
    expect(Math.max(...midway)).toBeLessThan(1);
    expect(api.setFalloffPreview).not.toHaveBeenCalledWith(null);

    act(() => { jest.advanceTimersByTime(200); });
    expect(api.setFalloffPreview).toHaveBeenLastCalledWith(null);
    expect(api.setInteractiveQuality).toHaveBeenLastCalledWith(false);
    expect(Math.max(...blendWeights(api))).toBeLessThan(1);
  });

  it("cancels FORWARD to the end state when a new drag tick arrives mid-fade", async () => {
    const api = makeRenderer();
    const { result } = mount(api);
    drag(result);
    await commit(result);
    act(() => { jest.advanceTimersByTime(32); }); // mid-fade
    expect(api.setFalloffPreview).not.toHaveBeenCalledWith(null);

    const weightsBefore = blendWeights(api).length;
    act(() => {
      result.current.handlePropagationSliderChange({ ...SETTINGS, proximitySlider: 0.25 });
    });
    // The fade jumped straight to its end state (committed field) before the new
    // drag re-armed the preview on top — never a fade fighting the thumb.
    expect(api.setFalloffPreview).toHaveBeenCalledWith(null);

    // And it does not keep ticking underneath the new drag.
    act(() => { jest.advanceTimersByTime(200); });
    const added = blendWeights(api).slice(weightsBefore);
    expect(added.every((t) => t === 0)).toBe(true);
  });

  it("degrades to the one-frame swap on a renderer without the blend uniform", async () => {
    const api = makeRenderer();
    // Older renderer (or a mock): no cross-fade capability at all.
    delete (api as unknown as Record<string, unknown>).setFalloffPreviewBlend;
    const { result } = mount(api);
    drag(result);
    await commit(result);
    expect(api.setFalloffPreview).toHaveBeenLastCalledWith(null);
  });
});
