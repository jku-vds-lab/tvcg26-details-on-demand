/**
 * Refs mount degate on static-bootFrame datasets (issue #315 R2b): when a
 * dataset boots from a prep-time bootFrame artifact, `rTreeReady` flips
 * immediately instead of waiting for the grid + edge index Promise.all —
 * the first inset frame needs no spatial query, and every client-lane
 * consumer is null-tolerant in the gap.
 *
 * Pinned here (the three guards from plan-315-server-first.md §5 R2b):
 *   (1) MANDATORY stale-ref nulling: the PREVIOUS dataset's trees are
 *       nulled before the flip, never left for the viewport memo,
 *   (2) the real indexes still install in the background, and the annealer
 *       reheat fires exactly then (not before),
 *   (3) a dataset with NO registered frame keeps the classic gated path.
 */

import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import React, { useRef } from "react";
import { Provider } from "react-redux";
import { DataProvider } from "../contexts/DataContext";
import { RTreeProvider, useRTreeReady, useRTreeRef } from "../contexts/RTreeContext";
import { SegmentsProvider } from "../contexts/SegmentsContext";
import { SegmentsRTreeProvider, useSegmentsRTreeRef } from "../contexts/SegmentsRTreeContext";
import { TrajectoryMidpointRTreeProvider } from "../contexts/TrajectoryMidpointRTreeContext";
import { TrajectoryMidpointsProvider } from "../contexts/TrajectoryMidpointsContext";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import {
  registerStaticBootFrame,
  STATIC_BOOT_FRAME_FORMAT,
  type StaticBootFrameArtifact,
} from "../semanticZoom/staticBootFrame";
import store from "../store";
import { usePrepareDatasetRefs } from "./usePrepareDatasetRefs";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
  // The feature-scan branch probes the backend for server feature stats.
  resolveInsetProvider: jest.fn(() => null),
}));

// rbush ships ESM-only; the standard in-repo mock (see
// hdbscanClustering.zoomcut.test.ts).
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
      search(bbox: Box) {
        return this.items.filter(
          (item) =>
            item.minX <= bbox.maxX && item.maxX >= bbox.minX &&
            item.minY <= bbox.maxY && item.maxY >= bbox.minY
        );
      }
    },
  };
});

function makePoints(n = 8): DataPoint[] {
  const pts: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ id: i, x: i / n, y: (i * 7) % n / n, line: 0 } as unknown as DataPoint);
  }
  return pts;
}

function frameArtifact(): StaticBootFrameArtifact {
  return {
    format: STATIC_BOOT_FRAME_FORMAT,
    tree: "points",
    canvasWidth: 800,
    canvasHeight: 600,
    viewbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    frame: { actives: [] } as unknown as StaticBootFrameArtifact["frame"],
  };
}

interface Captured {
  ready: boolean;
  // The ref OBJECTS, not their render-time values: on the degate lane the
  // install-time setRTreeReady(true) is a no-op (already true), so no
  // re-render refreshes a value snapshot — the refs must be read live.
  rTreeRef: { current: unknown } | null;
  segTreeRef: { current: unknown } | null;
}

function Harness({
  data,
  capture,
  reheat,
}: {
  data: DataPoint[];
  capture: Captured;
  reheat: () => void;
}) {
  const reheatRef = useRef<() => void>(reheat);
  reheatRef.current = reheat;
  usePrepareDatasetRefs(data, null, reheatRef);
  capture.ready = useRTreeReady().ready;
  capture.rTreeRef = useRTreeRef();
  capture.segTreeRef = useSegmentsRTreeRef();
  return null;
}

function renderHarness(data: DataPoint[], reheat: () => void = () => {}) {
  const capture: Captured = { ready: false, rTreeRef: null, segTreeRef: null };
  const ui = (props: { data: DataPoint[] }) => (
    <Provider store={store}>
      <DataProvider>
        <SegmentsProvider>
          <RTreeProvider>
            <SegmentsRTreeProvider>
              <TrajectoryMidpointsProvider>
                <TrajectoryMidpointRTreeProvider>
                  <Harness data={props.data} capture={capture} reheat={reheat} />
                </TrajectoryMidpointRTreeProvider>
              </TrajectoryMidpointsProvider>
            </SegmentsRTreeProvider>
          </RTreeProvider>
        </SegmentsProvider>
      </DataProvider>
    </Provider>
  );
  const result = render(ui({ data }));
  return { capture, rerenderWith: (next: DataPoint[]) => result.rerender(ui({ data: next })), ...result };
}

describe("usePrepareDatasetRefs — static-bootFrame mount degate (issue #315 R2b)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("flips ready immediately when a bootFrame is registered, then installs the real indexes", async () => {
    const data = makePoints();
    registerStaticBootFrame(data, frameArtifact());
    const reheat = jest.fn();
    const { capture } = renderHarness(data, reheat);

    // Degated: ready synchronously, trees nulled for the gap.
    expect(capture.ready).toBe(true);
    expect(capture.rTreeRef!.current).toBeNull();
    expect(capture.segTreeRef!.current).toBeNull();
    expect(reheat).not.toHaveBeenCalled();

    // The background build still installs the REAL point index (unlike the
    // server-cut branch, which never installs one).
    await waitFor(() => expect(capture.rTreeRef!.current).not.toBeNull());
    expect(capture.ready).toBe(true);
  });

  it("fires the annealer reheat exactly when the indexes install, not at the flip", async () => {
    const data = makePoints();
    registerStaticBootFrame(data, frameArtifact());
    const reheat = jest.fn();
    const { capture } = renderHarness(data, reheat);

    expect(reheat).not.toHaveBeenCalled();
    await waitFor(() => expect(capture.rTreeRef!.current).not.toBeNull());
    expect(reheat).toHaveBeenCalledTimes(1);
  });

  it("nulls the PREVIOUS dataset's trees before flipping on a dataset switch", async () => {
    // Dataset A: classic path, wait for its index to install.
    const a = makePoints();
    const { capture, rerenderWith } = renderHarness(a);
    await waitFor(() => expect(capture.rTreeRef!.current).not.toBeNull());

    // Dataset B boots from a static frame: the flip must not expose A's grid.
    const b = makePoints(12);
    registerStaticBootFrame(b, frameArtifact());
    await act(async () => {
      rerenderWith(b);
    });
    expect(capture.ready).toBe(true);
    expect(capture.rTreeRef!.current).toBeNull();
    expect(capture.segTreeRef!.current).toBeNull();
  });

  it("keeps the classic gated path when no frame is registered", async () => {
    const reheat = jest.fn();
    const { capture } = renderHarness(makePoints(), reheat);

    expect(capture.ready).toBe(false);
    await waitFor(() => expect(capture.ready).toBe(true));
    expect(capture.rTreeRef!.current).not.toBeNull();
    // No degate happened, so the install path must not reheat.
    expect(reheat).not.toHaveBeenCalled();
  });
});
