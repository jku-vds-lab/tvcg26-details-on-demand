/**
 * Rehydrate coords/bbox parity on the client lazy lane (issue #315 R3d,
 * plan-315-server-first.md §6.1).
 *
 * R3d lets a static-bootFrame dataset WITHOUT a cut provider keep its row
 * array holey through the boot clustering. `rehydrateHierarchy` and the lazy
 * point R-trees therefore read positions from the coords/columns, never from
 * row slots. Pinned here:
 *
 *   (1) bbox parity — a service rehydrated over a HOLEY array produces
 *       byte-identical leaf + internal bboxes to a resident twin;
 *   (2) point-index parity — the lazily built rbush point indexes count the
 *       same points pre-residency as the twin does resident;
 *   (3) accessors only, forever — neither pass materializes a single hole
 *       (the §2.4 identity contract survives the read path).
 */

import { describe, expect, it, jest } from "@jest/globals";

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

import { ClusteringService } from "../clustering/clusteringService";
import {
  materializeRecords,
  type PointColumns as SidecarPointColumns,
} from "../dataPreprocessing/columnSidecar";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { areRowsResident, createLazyRowArray, isLazyRowArray } from "../dataPreprocessing/lazyRows";
import { columnsFromSidecar, createColumnBackedRowFactory } from "../dataPreprocessing/pointColumns";
import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import { indexLeafRanges, reuid } from "../hooks/useFullSelectionHdbscanInstance";

const N = 6;
const XS = [0.1, 0.15, 0.5, 0.55, 0.8, 0.85];
const YS = [0.1, 0.12, 0.5, 0.52, 0.8, 0.82];

function sidecar(): SidecarPointColumns {
  const x = new Float64Array(XS);
  const y = new Float64Array(YS);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  for (let i = 0; i < N; i++) id[i] = 1000 + i;
  return { count: N, byName: { x, y, line, id } };
}

/** The lazy array: eager prefix of 2 + the endpoint, holes at 2..4. */
function lazyNodes(): DataPoint[] {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols, { eagerRows: 2 });
}

async function residentNodes(): Promise<DataPoint[]> {
  const sc = sidecar();
  const cols = columnsFromSidecar(sc)!;
  return (await materializeRecords(sc, {
    rowFactory: createColumnBackedRowFactory(cols),
  })) as unknown as DataPoint[];
}

const coords = (): Array<[number, number]> => XS.map((x, i) => [x, YS[i]]);

function leaf(leafIndex: number): ClusterTreeNode {
  return {
    id: leafIndex,
    leafIndex,
    size: 1,
    stability: 1,
    distance: 0,
  } as unknown as ClusterTreeNode;
}

function internal(id: number, l: ClusterTreeNode, r: ClusterTreeNode, size: number): ClusterTreeNode {
  return { id, leftChild: l, rightChild: r, stability: 5, size, distance: 1 } as unknown as ClusterTreeNode;
}

/** Three tight pairs; NO bboxes anywhere, so assignBBoxes has to compute
 * every one from positions. */
function makeTree(): ClusterTreeNode {
  const p01 = internal(10, leaf(0), leaf(1), 2);
  const p23 = internal(11, leaf(2), leaf(3), 2);
  const p45 = internal(12, leaf(4), leaf(5), 2);
  const left = internal(13, p01, p23, 4);
  const tree = reuid(internal(14, left, p45, 6));
  tree._leafOrder = indexLeafRanges(tree);
  return tree;
}

function service(nodes: DataPoint[]): ClusteringService {
  const svc = new ClusteringService({ minClusterSize: 1, minSamples: 1, alpha: 1.0, group: "annotation" });
  svc.rehydrateHierarchy(makeTree(), coords(), nodes, nodes);
  return svc;
}

function collectBBoxes(svc: ClusteringService): Array<NonNullable<ClusterTreeNode["bbox"]>> {
  const out: Array<NonNullable<ClusterTreeNode["bbox"]>> = [];
  const root = (svc as unknown as { root: ClusterTreeNode | null }).root;
  const walk = (n: ClusterTreeNode | undefined) => {
    if (!n) return;
    expect(n.bbox).toBeDefined();
    out.push(n.bbox!);
    walk(n.leftChild);
    walk(n.rightChild);
  };
  walk(root ?? undefined);
  return out;
}

describe("rehydrateHierarchy on a holey client array (issue #315 R3d)", () => {
  it("computes bboxes identical to the resident twin, without touching a hole", async () => {
    const holey = lazyNodes();
    expect(isLazyRowArray(holey)).toBe(true);
    expect(areRowsResident(holey)).toBe(false);

    const lazyBoxes = collectBBoxes(service(holey));
    const residentBoxes = collectBBoxes(service(await residentNodes()));
    expect(lazyBoxes).toEqual(residentBoxes);

    // Accessors only, forever: the pass materialized nothing.
    for (let i = 2; i <= 4; i++) expect(i in holey).toBe(false);
    expect(areRowsResident(holey)).toBe(false);
  });

  it("builds the lazy point indexes columnar — pre-residency counts match the twin", async () => {
    type WithCount = {
      countPointsInView(v: { minX: number; minY: number; maxX: number; maxY: number }): number;
    };
    const holey = lazyNodes();
    const lazySvc = service(holey) as unknown as WithCount;
    const residentSvc = service(await residentNodes()) as unknown as WithCount;

    // Covers the two holey pairs (indices 2..5 minus the eager endpoint 5).
    const view = { minX: 0.4, minY: 0.4, maxX: 0.9, maxY: 0.9 };
    expect(lazySvc.countPointsInView(view)).toBe(residentSvc.countPointsInView(view));
    expect(lazySvc.countPointsInView(view)).toBe(4);

    // The rbush build read columns, not row slots.
    for (let i = 2; i <= 4; i++) expect(i in holey).toBe(false);
  });
});
