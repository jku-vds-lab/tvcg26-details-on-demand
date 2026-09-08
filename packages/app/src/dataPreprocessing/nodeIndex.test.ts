// Mock rbush (ESM) to avoid transform issues, matching the repo convention
// (see pointGridIndex.test.ts). The mock reproduces rbush's inclusive
// intersection test, so it is a faithful search oracle.
jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); return this; }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); return this; }
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

import RBush from "rbush";
import type { DataPoint, RTreeItem } from "src/dataPreprocessing/dataPreprocessing";
import { createDoiFilteredNodeIndex } from "src/dataPreprocessing/nodeIndex";

/** Minimal RTreeItem factory — only x/y/DoI matter for these tests. */
function item(x: number, y: number, DoI: number): RTreeItem<DataPoint> {
  return {
    minX: x,
    minY: y,
    maxX: x,
    maxY: y,
    data: { x, y, DoI } as DataPoint,
  };
}

function treeFrom(items: RTreeItem<DataPoint>[]): RBush<RTreeItem<DataPoint>> {
  const tree = new RBush<RTreeItem<DataPoint>>();
  tree.load(items);
  return tree;
}

describe("createDoiFilteredNodeIndex", () => {
  it("returns items with DoI strictly above the threshold inside the box", () => {
    const above = item(1, 1, 0.8);
    const tree = treeFrom([above, item(2, 2, 0.9)]);
    const view = createDoiFilteredNodeIndex(tree, 0.5);

    const hits = view.search({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    expect(hits).toHaveLength(2);
    expect(hits).toContain(above);
  });

  it("excludes items at or below the threshold (boundary: DoI === threshold is excluded)", () => {
    const atThreshold = item(1, 1, 0.5);
    const below = item(2, 2, 0.3);
    const above = item(3, 3, 0.7);
    const tree = treeFrom([atThreshold, below, above]);
    const view = createDoiFilteredNodeIndex(tree, 0.5);

    const hits = view.search({ minX: 0, minY: 0, maxX: 4, maxY: 4 });
    expect(hits).toEqual([above]);
  });

  it("excludes items outside the query bbox regardless of DoI", () => {
    const inside = item(1, 1, 0.9);
    const outside = item(100, 100, 0.9);
    const tree = treeFrom([inside, outside]);
    const view = createDoiFilteredNodeIndex(tree, 0.5);

    const hits = view.search({ minX: 0, minY: 0, maxX: 3, maxY: 3 });
    expect(hits).toEqual([inside]);
  });

  it("reads DoI live: mutating data.DoI after creation changes later queries", () => {
    const mutable = item(1, 1, 0.9);
    const tree = treeFrom([mutable]);
    const view = createDoiFilteredNodeIndex(tree, 0.5);
    const box = { minX: 0, minY: 0, maxX: 3, maxY: 3 };

    expect(view.search(box)).toEqual([mutable]);

    // Drop below threshold in place — the view reads the live value.
    mutable.data.DoI = 0.1;
    expect(view.search(box)).toEqual([]);

    // Raise back above threshold — it reappears.
    mutable.data.DoI = 0.6;
    expect(view.search(box)).toEqual([mutable]);
  });
});
