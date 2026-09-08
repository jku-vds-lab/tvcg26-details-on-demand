/**
 * Issue #315 A2: server-cut datasets build NO client spatial interaction
 * indexes at boot — the point grid and edge segment index are skipped, and
 * rTreeReady flips immediately (mount de-gate) instead of waiting for the
 * index Promise.all. Client-complete datasets keep the classic path.
 */

import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import React from "react";
import { Provider } from "react-redux";
import { DataProvider } from "../contexts/DataContext";
import { RTreeProvider, useRTreeReady, useRTreeRef } from "../contexts/RTreeContext";
import { SegmentsProvider } from "../contexts/SegmentsContext";
import { SegmentsRTreeProvider, useSegmentsRTreeRef } from "../contexts/SegmentsRTreeContext";
import { TrajectoryMidpointRTreeProvider } from "../contexts/TrajectoryMidpointRTreeContext";
import { TrajectoryMidpointsProvider } from "../contexts/TrajectoryMidpointsContext";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

function makePoints(n = 8): DataPoint[] {
  const pts: DataPoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ id: i, x: i / n, y: (i * 7) % n / n, line: 0 } as unknown as DataPoint);
  }
  return pts;
}

interface Captured {
  ready: boolean;
  rTree: unknown;
  segTree: unknown;
}

function Harness({ data, capture }: { data: DataPoint[]; capture: Captured }) {
  usePrepareDatasetRefs(data, null);
  capture.ready = useRTreeReady().ready;
  capture.rTree = useRTreeRef().current;
  capture.segTree = useSegmentsRTreeRef().current;
  return null;
}

function renderHarness(data: DataPoint[]) {
  const capture: Captured = { ready: false, rTree: undefined, segTree: undefined };
  const ui = (
    <Provider store={store}>
      <DataProvider>
        <SegmentsProvider>
          <RTreeProvider>
            <SegmentsRTreeProvider>
              <TrajectoryMidpointsProvider>
                <TrajectoryMidpointRTreeProvider>
                  <Harness data={data} capture={capture} />
                </TrajectoryMidpointRTreeProvider>
              </TrajectoryMidpointsProvider>
            </SegmentsRTreeProvider>
          </RTreeProvider>
        </SegmentsProvider>
      </DataProvider>
    </Provider>
  );
  const result = render(ui);
  return { capture, ...result };
}

describe("usePrepareDatasetRefs — server-cut index skip (issue #315 A2)", () => {
  beforeEach(() => {
    scaling.resolveCutProvider.mockReset();
  });

  it("skips both spatial indexes and flips ready immediately on server-cut datasets", async () => {
    scaling.resolveCutProvider.mockReturnValue({});
    const { capture } = renderHarness(makePoints());

    // Ready synchronously after the effect — no index build awaited.
    expect(capture.ready).toBe(true);
    expect(capture.rTree).toBeNull();

    // The background branches settle without ever installing an index.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(capture.rTree).toBeNull();
    expect(capture.segTree).toBeNull();
  });

  it("keeps the classic path on client-complete datasets", async () => {
    scaling.resolveCutProvider.mockReturnValue(null);
    const { capture } = renderHarness(makePoints());

    // Not ready until the index build completes.
    expect(capture.ready).toBe(false);
    await waitFor(() => expect(capture.ready).toBe(true));
    expect(capture.rTree).not.toBeNull();
  });
});
