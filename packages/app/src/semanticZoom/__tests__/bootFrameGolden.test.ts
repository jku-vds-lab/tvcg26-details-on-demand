// Golden-parity contract for the STATIC boot select-frame (issue #315
// insets-at-boot I3, B3/G4 precedent).
//
// The Python twin (tests/test_boot_frame.py over tests/bootframe_fixtures.py)
// produces fixtures/bootFrame/golden.json by running the bootFrame emitter
// (rl_trajectories/boot_frame.py -> cluster_select.score_and_select) over the
// p7select synthetic dataset. This test replays the SAME fixture through the
// real CLIENT adoption path — reuid → indexLeafRanges → rehydrateHierarchy →
// the armed first zoom pass (takeStaticBootFrame → applySelectFrame) — and
// asserts the applied actives, groups, members, hulls and inset seeds are
// exactly the artifact's. It then runs the superseding local pass and asserts
// the local pipeline picks the SAME winners: the emitter is a faithful port,
// so the supersede is visually a no-op on a fresh session.
//
// If either side drifts, one of the two suites goes red. Regenerate the
// fixture with `python -m tests.bootframe_fixtures` ONLY after a deliberate
// semantic change, and re-run both suites.

import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// Mock rbush (ESM) to avoid transform issues in Jest.
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

import * as d3 from "d3";
import * as fs from "fs";
import * as path from "path";
import { ClusteringService } from "../../clustering/clusteringService";
import type { DataPoint } from "../../dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "../../dataPreprocessing/dataPreprocessing";
import type { ClusterTreeNode } from "../../clustering/ExtendedHDBSCAN";
import {
  indexLeafRanges,
  reuid,
} from "../../hooks/useFullSelectionHdbscanInstance";
import {
  parseStaticBootFrame,
  registerStaticBootFrame,
} from "../staticBootFrame";
import store, {
  initialClusterSettings,
  initialVisualizationSettings,
  updateClusterSettings,
  updateSettings,
} from "../../store";

const FIXTURE = path.resolve(__dirname, "fixtures/bootFrame/golden.json");

interface FixtureRecord { id: number; line: number; x: number; y: number }

interface Fixture {
  records: FixtureRecord[];
  leafOrder: number[];
  tree: ClusterTreeNode;
  artifact: {
    format: string;
    tree: string;
    canvasWidth: number;
    canvasHeight: number;
    viewbox: { minX: number; minY: number; maxX: number; maxY: number };
    frame: {
      actives: Array<{
        uid: string;
        size: number;
        group: number;
        leafRanges: number[][];
        hull?: number[][] | null;
        insetPos?: number[] | null;
      }>;
    };
  };
}

describe("static boot-frame golden parity (issue #315 I3)", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Fixture;
  const { records, artifact } = fixture;

  beforeEach(() => {
    store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
    store.dispatch(updateSettings({ ...initialVisualizationSettings }));
  });

  function makeNodes(): DataPoint[] {
    // A fresh session: no DoI state (`DoI ?? 1` semantics), full selection.
    return records.map((r) => ({
      ...createEmptyDataPoint(),
      id: r.id,
      line: r.line,
      x: r.x,
      y: r.y,
      DoI: 1,
      doiGroup: "inset" as const,
    }));
  }

  /** The client's own identity + leaf-order pass over the SHIPPED tree. */
  function rehydrate(): ClusterTreeNode {
    const root = reuid(fixture.tree);
    const leafOrder = indexLeafRanges(root);
    root._leafOrder = leafOrder;
    return root;
  }

  it("derives the same leaf order the emitter did (uid vocabulary parity)", () => {
    const root = rehydrate();
    expect(root._leafOrder).toEqual(fixture.leafOrder);
  });

  it("the emitted artifact passes the client-side shape validation", () => {
    expect(parseStaticBootFrame(artifact)).not.toBeNull();
  });

  it("replays through the armed first pass and supersedes with the SAME winners", () => {
    const nodes = makeNodes();
    const parsed = parseStaticBootFrame(artifact);
    expect(parsed).not.toBeNull();
    registerStaticBootFrame(nodes, parsed!);

    const svc = new ClusteringService({
      minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation",
    });
    svc.rehydrateHierarchy(
      rehydrate(),
      records.map((r) => [r.x, r.y] as [number, number]),
      nodes,
      nodes
    );
    svc.enableStaticBootFrame();

    const view = artifact.viewbox;
    const W = artifact.canvasWidth;
    const H = artifact.canvasHeight;
    const xScale = d3.scaleLinear().domain([view.minX, view.maxX]).range([0, W]);
    const yScale = d3.scaleLinear().domain([view.minY, view.maxY]).range([H, 0]);
    const run = () => svc.updateClusteringSemanticZoom(view, xScale, yScale, W, H, true);

    // ── pass 1: the artifact IS the answer ─────────────────────────────────
    const applied = run();
    const expectedUids = artifact.frame.actives.map((a) => a.uid);
    expect(applied.activeClusters.map((c) => c.uid)).toEqual(expectedUids);
    for (const expectedActive of artifact.frame.actives) {
      const node = applied.activeClusters.find((c) => c.uid === expectedActive.uid)!;
      expect(node).toBeDefined();
      // Classification rides serverGroups (no DoI => every winner an inset).
      expect(applied.serverGroups?.get(expectedActive.uid)).toBe(expectedActive.group);
      expect(expectedActive.group).toBe(2);
      // Members resolve through the client's OWN leaf order — the leaf-range
      // vocabulary contract this artifact exists to honor.
      const [first, last] = expectedActive.leafRanges[0];
      expect(svc.membersOfCluster(node)).toEqual(fixture.leafOrder.slice(first, last));
      expect(node.size).toBe(expectedActive.size);
      // Geometry the mount consumes, carried on the synthesized node.
      expect((node as { precomputedHull?: unknown }).precomputedHull).toEqual(
        expectedActive.hull
      );
      expect((node as { insetPos?: unknown }).insetPos).toEqual(expectedActive.insetPos);
    }

    // ── pass 2: the genuine local pass supersedes — with identical winners ─
    // The emitter is the byte-faithful port of this very pipeline (empty
    // echo, no DoI, same defaults, same canvas), so a fresh session's first
    // local scoring must select exactly the artifact's uids: the supersede
    // is a visual no-op. A mismatch here is a REAL emitter/client drift.
    const local = run();
    expect(local.serverGroups).toBeUndefined();
    expect(local.activeClusters.map((c) => c.uid).sort()).toEqual(
      expectedUids.slice().sort()
    );
  });
});
