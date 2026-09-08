/**
 * Converged drag routing + settle-commit (CS 14.08, ported from the
 * comparison instrument). Under the production routing every field drag
 * takes the synchronous CONVERGED preview lane (fieldPreviewRequiresSync is
 * always true — this suite mocks it true to match, where the falloffDrag
 * sibling mocks it false to keep exercising the parked shader machinery).
 * Pinned here:
 *
 *   - a P/B/F drag tick runs the sync preview (previewFalloffOpacity) and
 *     SKIPS the interactive-quality reduction (the half-res store washes out
 *     the dense converged field);
 *   - a thumb resting ~350 ms with the pointer down fires the full commit in
 *     place (settle auto-commit);
 *   - the release at the settled values is ABSORBED (no second commit — the
 *     re-fit is the jump); a release at moved values always commits.
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

const PREVIEW_BUFFER = Float32Array.from([1, 0.5, 0.2]);
const previewFalloffOpacityMock = jest.fn(() => PREVIEW_BUFFER);
const propagateSliderCommitOnServerMock = jest.fn(async () => true);

jest.mock("src/doiPropagation/serverPropagation", () => ({
  // Production behavior since converged previews: ALWAYS the sync lane.
  fieldPreviewRequiresSync: () => true,
  fieldPreviewExclusionsActive: () => false,
  snapshotCoords: () => ({ x: new Float64Array(3), y: new Float64Array(3) }),
  getAppliedFieldOpacity: () => null,
  getFalloffShape: () => "log",
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

beforeEach(() => {
  jest.useFakeTimers();
  previewFalloffOpacityMock.mockClear();
  propagateSliderCommitOnServerMock.mockClear();
});

const tick = (
  result: { current: ReturnType<typeof useDoIPropagation> },
  overrides: Partial<SliderSettings>
) => {
  act(() => {
    result.current.handlePropagationSliderChange({ ...SETTINGS, ...overrides });
  });
};

/** Advance fake time AND flush the async commit chain the settle timer may
 * have started (the commit handler awaits the server mock). */
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("converged drag ticks (sync lane)", () => {
  it("runs the synchronous converged preview and skips the quality reduction", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(100); // past the 90 ms preview throttle, before the settle

    expect(previewFalloffOpacityMock).toHaveBeenCalled();
    expect(api.setOpacityField).toHaveBeenCalledWith(PREVIEW_BUFFER);
    // The shader lane must NOT engage: the frozen-chain preview is round-0
    // semantics, which converged previews replaced.
    expect(api.setDistanceField).not.toHaveBeenCalled();
    // Interactive-quality reduction is skipped for converged drags (the
    // half-res store washes out the dense field).
    expect(api.setInteractiveQuality).not.toHaveBeenCalledWith(true);
  });

  it("still reduces quality for threshold-only drags (no converged preview runs)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { grayOutDoiThreshold: 0.2 });
    await advance(100);

    expect(api.setInteractiveQuality).toHaveBeenCalledWith(true);
    expect(previewFalloffOpacityMock).not.toHaveBeenCalled();
  });
});

describe("settle-commit + release absorption", () => {
  it("fires the full commit after ~350 ms of rest with the pointer down", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(200);
    expect(propagateSliderCommitOnServerMock).not.toHaveBeenCalled(); // still resting
    await advance(200); // total 400 > 350: settle fires
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(1);
  });

  it("absorbs the release at the settled values — no second commit, no jump", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(400);
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.5,
      });
    });
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(1); // absorbed
  });

  it("a release at MOVED values always commits (the skip key is single-shot)", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(400); // settle commit #1
    tick(result, { proximitySlider: 0.4 }); // clears the skip key, re-arms
    await act(async () => {
      await result.current.handlePropagationSliderFinalChange({
        ...SETTINGS,
        proximitySlider: 0.4,
      });
    });
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(2);

    // The pending settle timer was superseded by the release: nothing more fires.
    await advance(1000);
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(2);
  });

  it("keeps dragging: every tick re-arms the settle window", async () => {
    const api = makeRenderer();
    const { result } = mount(api);

    tick(result, { proximitySlider: 0.5 });
    await advance(200);
    tick(result, { proximitySlider: 0.45 });
    await advance(200);
    tick(result, { proximitySlider: 0.4 });
    await advance(200);
    // No 350 ms rest yet — the timer re-armed on every tick.
    expect(propagateSliderCommitOnServerMock).not.toHaveBeenCalled();
    await advance(200); // now 400 ms since the last tick
    expect(propagateSliderCommitOnServerMock).toHaveBeenCalledTimes(1);
  });
});
