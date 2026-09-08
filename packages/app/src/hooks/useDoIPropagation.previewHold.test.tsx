/**
 * Slider-commit preview lifecycle (issue #315 P7).
 *
 * DEFECT: releasing a propagation slider cleared the GPU falloff preview
 * immediately, so the view fell back to the STALE committed field for the
 * whole server propagate RTT (~1 s at 1M) before the new field landed — CS:
 * "the live drag preview disappears for a second".
 *
 * CONTRACT pinned here: between the release and the moment the committed field
 * is uploaded, NOTHING that changes the rendered image is issued — no
 * `setFalloffPreview(null)`, no `setInteractiveQuality(false)`, no
 * `setOpacityField`, no `setOpacityParams`. All of it lands together, once,
 * when the field applies.
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

let mockCommitGate: { resolve: (applied: boolean) => void; promise: Promise<boolean> };
const mockAppliedField = new Float32Array([0.2, 0.4, 0.6]);

jest.mock("src/doiPropagation/serverPropagation", () => ({
  fieldPreviewRequiresSync: () => false,
  fieldPreviewExclusionsActive: () => false,
  snapshotCoords: () => ({ x: new Float64Array(3), y: new Float64Array(3) }),
  getAppliedFieldOpacity: () => mockAppliedField,
  getFalloffShape: () => "log",
  getResidentField: () => null,
  getSeedClampIndices: () => null,
  hasResidentFieldPreview: () => true,
  previewFalloffOpacity: () => null,
  propagateSliderCommitOnServer: () => mockCommitGate.promise,
  serverPropagationEligible: () => true,
}));

jest.mock("src/clustering/hdbscanClustering", () => ({
  bumpClusteringEpoch: () => 1,
  isCurrentClusteringEpoch: () => true,
  runHdbscanClusteringWithStatus: async () => undefined,
  runTrajectoryMidpointClusteringWithStatus: async () => undefined,
}));

jest.mock("@scaling", () => ({ resolveCutProvider: () => null }));

// Mock rbush (ESM) to avoid transform issues in Jest — same shim the
// clusteringService server-cut suites use.
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


const mkPoint = (id: number): DataPoint => ({
  x: id,
  y: id,
  line: 0,
  algo: "a",
  id,
  action: "",
  DoI: 1,
  doiGroup: "gray",
  selected: id === 1,
  nextEdgeCenter: { x: id, y: id },
});

const NODES: DataPoint[] = [mkPoint(1), mkPoint(2), mkPoint(3)];

const SETTINGS: SliderSettings = {
  proximitySlider: 0.5,
  pastSlider: 0.3,
  futureSlider: 0.2,
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

function makeRenderer() {
  const calls: string[] = [];
  const note = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}(${args[0] === null ? "null" : typeof args[0]})`);
  };
  const api = {
    setOpacityMix: jest.fn(note("setOpacityMix")),
    setOpacityParams: jest.fn(note("setOpacityParams")),
    setOpacityField: jest.fn(note("setOpacityField")),
    setFalloffPreview: jest.fn(note("setFalloffPreview")),
    setInteractiveQuality: jest.fn(note("setInteractiveQuality")),
    setDistanceField: jest.fn(note("setDistanceField")),
    render: jest.fn(note("render")),
  } as unknown as RendererAPI;
  return { api, calls };
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

function mount(rendererApi: RendererAPI) {
  const rendererRef = { current: rendererApi };
  return renderHook(
    () =>
      useDoIPropagation({
        setSliderSettings: () => {},
        currentSliderSettingsRef: { current: { ...SETTINGS } },
        sliderUpdateFrameRef: { current: null },
        rendererRef,
        visualSettings: {
          maxEmbeddingDistance: 1,
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("slider commit holds the drag preview until the field applies", () => {
  beforeEach(() => {
    let resolve!: (applied: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    mockCommitGate = { resolve, promise };
  });

  it("issues nothing visual while the propagate RTT is in flight", async () => {
    const { api, calls } = makeRenderer();
    const { result } = mount(api);

    let commit!: Promise<void>;
    await act(async () => {
      commit = result.current.handlePropagationSliderFinalChange(SETTINGS);
      // let the synchronous prologue + the first await run
      await Promise.resolve();
    });

    expect(calls).toEqual([]);
    expect(api.setFalloffPreview).not.toHaveBeenCalled();
    expect(api.setInteractiveQuality).not.toHaveBeenCalled();
    expect(api.setOpacityField).not.toHaveBeenCalled();
    expect(api.setOpacityParams).not.toHaveBeenCalled();

    await act(async () => {
      mockCommitGate.resolve(true);
      await commit;
    });
  });

  it("releases the preview together with the committed field", async () => {
    const { api, calls } = makeRenderer();
    const { result } = mount(api);

    let commit!: Promise<void>;
    await act(async () => {
      commit = result.current.handlePropagationSliderFinalChange(SETTINGS);
      await Promise.resolve();
    });
    await act(async () => {
      mockCommitGate.resolve(true);
      await commit;
    });

    expect(api.setFalloffPreview).toHaveBeenCalledWith(null);
    expect(api.setInteractiveQuality).toHaveBeenCalledWith(false);
    expect(api.setOpacityField).toHaveBeenCalledWith(mockAppliedField);
    // The preview is held until the committed field is UPLOADED, then released.
    // Order flipped with the release cross-fade (issue #315, CS 2026-07-26): the
    // texture must be in place before the fade can walk the mix uniform onto it,
    // and the teardown IS the fade's end state. This renderer double has no
    // setFalloffPreviewBlend, so the fade degrades to the one-frame swap and the
    // teardown still lands in the same synchronous block.
    const clearAt = calls.indexOf("setFalloffPreview(null)");
    const fieldAt = calls.indexOf("setOpacityField(object)");
    const renderAt = calls.lastIndexOf("render(undefined)");
    expect(fieldAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeGreaterThan(fieldAt);
    expect(renderAt).toBeGreaterThan(fieldAt);
  });

  it("a dataset swap still clears the preview immediately", () => {
    const { api } = makeRenderer();
    const { result } = mount(api);
    act(() => {
      result.current.notifyDatasetSwap();
    });
    expect(api.setFalloffPreview).toHaveBeenCalledWith(null);
    expect(api.setInteractiveQuality).toHaveBeenCalledWith(false);
  });
});
