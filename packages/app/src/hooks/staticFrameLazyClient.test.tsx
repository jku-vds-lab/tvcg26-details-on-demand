/**
 * Client lazy-lane boot pass (issue #315 R3d, plan-315-server-first.md §6.1).
 *
 * On a static-bootFrame dataset without a cut provider the row array stays
 * holey through the boot clustering — the first inset mounts from the
 * artifact, and `forEach` over holes SILENTLY skips them, so the select-all
 * marking pass must NOT run against the holey array (it would mark only the
 * eager prefix and report success). Pinned here:
 *
 *   (1) deferred marking — the boot pass runs the clustering but leaves the
 *       rows unmarked and NON-resident (no silent hole-skip, no silent
 *       materialization on the critical path);
 *   (2) the deferred block — residency lands off the critical path, then the
 *       whole pass re-runs: every row (including former holes) carries the
 *       classic selected/DoI/doiGroup marking and a second clustering+zoom
 *       pass supersedes the frame;
 *   (3) the classic lane is untouched — a resident client array marks
 *       synchronously in the first pass, exactly one clustering run.
 */

import { describe, expect, it, jest } from "@jest/globals";

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
    },
  };
});

// The clustering runners are heavyweight (workers, store dispatches); the
// pass ORDER and the marking are what this suite pins. Epoch bookkeeping
// stays real so the deferred block's supersede guard is exercised.
jest.mock("../clustering/hdbscanClustering", () => {
  const actual = jest.requireActual("../clustering/hdbscanClustering") as object;
  return {
    ...actual,
    runHdbscanClusteringWithStatus: jest.fn(async () => undefined),
    runTrajectoryMidpointClusteringWithStatus: jest.fn(async () => undefined),
  };
});

import { render, waitFor } from "@testing-library/react";
import * as d3 from "d3";
import { useRef, type MutableRefObject } from "react";
import {
  materializeRecords,
  type PointColumns as SidecarPointColumns,
} from "../dataPreprocessing/columnSidecar";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident, createLazyRowArray, isLazyRowArray } from "../dataPreprocessing/lazyRows";
import { columnsFromSidecar, columnsOf, createColumnBackedRowFactory } from "../dataPreprocessing/pointColumns";
import type { SegmentColumns } from "../dataPreprocessing/splineColumns";
import { runHdbscanClusteringWithStatus } from "../clustering/hdbscanClustering";
import { DataProvider, useDataRef } from "../contexts/DataContext";
import {
  TrajectoryMidpointRTreeProvider,
} from "../contexts/TrajectoryMidpointRTreeContext";
import { TrajectoryMidpointsProvider } from "../contexts/TrajectoryMidpointsContext";
import { useInitialClustering } from "./useInitialClustering";
import type { PrecomputedHdbscanResult } from "./useFullSelectionHdbscanInstance";

const N = 12;
const EAGER = 2;

function sidecar(): SidecarPointColumns {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = i / N;
    y[i] = (i % 3) / 3;
    id[i] = 1000 + i;
  }
  return { count: N, byName: { x, y, line, id } };
}

function lazyNodes(): DataPoint[] {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols, { eagerRows: EAGER });
}

async function residentClientNodes(): Promise<DataPoint[]> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc)!;
  return (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
  })) as unknown as DataPoint[];
}

const scales = {
  xScale: d3.scaleLinear().domain([0, 1]).range([0, 800]),
  yScale: d3.scaleLinear().domain([0, 1]).range([600, 0]),
};

/** Seeds the context ref during render, BEFORE the sibling hook's effect. */
function SeedData({ rows }: { rows: DataPoint[] }) {
  const dataRef = useDataRef();
  dataRef.current = rows;
  return null;
}

function Probe({
  rows,
  performZoomClustering,
}: {
  rows: DataPoint[];
  performZoomClustering: () => void;
}) {
  const segmentsRef = useRef<SegmentColumns | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(document.createElement("div"));
  useInitialClustering({
    segmentsRef: segmentsRef as MutableRefObject<SegmentColumns | null>,
    canvasContainerRef,
    scales,
    internalData: rows,
    internalHdbscan: null,
    internalMidpointHdbscan: null,
    fullSelectionHdbscan: { hierarchyTree: {} } as unknown as PrecomputedHdbscanResult,
    fullSelectionMidpointHdbscan: undefined,
    performZoomClustering,
  });
  return null;
}

function mount(rows: DataPoint[], performZoomClustering: () => void) {
  return render(
    <DataProvider>
      <TrajectoryMidpointsProvider>
        <TrajectoryMidpointRTreeProvider>
          <SeedData rows={rows} />
          <Probe rows={rows} performZoomClustering={performZoomClustering} />
        </TrajectoryMidpointRTreeProvider>
      </TrajectoryMidpointsProvider>
    </DataProvider>
  );
}

const runClustering = runHdbscanClusteringWithStatus as jest.MockedFunction<
  typeof runHdbscanClusteringWithStatus
>;

describe("useInitialClustering on the client lazy lane (issue #315 R3d)", () => {
  it("defers the marking pass past first inset, then re-runs the whole pass resident", async () => {
    runClustering.mockClear();
    const rows = lazyNodes();
    const zoom = jest.fn();
    mount(rows, zoom);

    // Boot pass, observed synchronously (the effect body runs through its
    // first await during mount): clustering started against the holey
    // array, and NOTHING got marked or materialized — the deferred block
    // completes within a few macrotasks on this tiny fixture, so the
    // pre-residency state is only observable here.
    expect(runClustering).toHaveBeenCalledTimes(1);
    expect(areRowsResident(rows)).toBe(false);
    expect(rows[0].doiGroup).toBeUndefined();
    for (let i = EAGER; i < N - 1; i++) expect(i in rows).toBe(false);

    // Deferred block: residency lands off the critical path, the pass
    // re-runs, and every row — former holes included — carries the classic
    // select-all marking.
    await waitFor(() => expect(areRowsResident(rows)).toBe(true));
    await waitFor(() => expect(runClustering).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(zoom).toHaveBeenCalledTimes(2));
    for (let i = 0; i < N; i++) {
      expect(rows[i].selected).toBe(true);
      expect(rows[i].DoI).toBe(1);
      expect(rows[i].doiGroup).toBe("inset");
    }
    // The DoI accessor wrote through to the column.
    const cols = columnsOf(rows)!;
    for (let i = 0; i < N; i++) expect(cols.doi[i]).toBe(1);
  });

  it("marks synchronously in the first pass on a resident client array", async () => {
    runClustering.mockClear();
    const rows = await residentClientNodes();
    expect(isLazyRowArray(rows)).toBe(false);
    const zoom = jest.fn();
    mount(rows, zoom);

    await waitFor(() => expect(zoom).toHaveBeenCalled());
    expect(runClustering).toHaveBeenCalledTimes(1);
    for (let i = 0; i < N; i++) expect(rows[i].doiGroup).toBe("inset");

    // No deferred re-run on the classic lane.
    await new Promise((r) => setTimeout(r, 25));
    expect(runClustering).toHaveBeenCalledTimes(1);
    expect(zoom).toHaveBeenCalledTimes(1);
  });
});
