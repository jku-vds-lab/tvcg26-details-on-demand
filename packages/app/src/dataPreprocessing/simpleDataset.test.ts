// Mock rbush (ESM, pulled in via dataPreprocessing → JSONLoader) to avoid
// transform issues in Jest.
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

import type { ClusterTreeNode } from "../clustering/ExtendedHDBSCAN";
import type { Dataset } from "../types/datasetTypes";
import { JSONLoader } from "./JSONLoader";
import {
  buildSimpleDatasetObject,
  inferSimpleColumnMapping,
  normalizeSimpleRows,
  SIMPLE_KNN_K,
} from "./simpleDataset";

describe("normalizeSimpleRows", () => {
  const mapping = { x: "px", y: "py", trajectory: "episode", order: "step" };

  it("coerces x/y and drops rows with non-numeric coordinates", () => {
    const { points, droppedRowCount } = normalizeSimpleRows(
      [
        { px: "1.5", py: "2", episode: "a", step: "0" },
        { px: "oops", py: "2", episode: "a", step: "1" },
        { px: "", py: "3", episode: "a", step: "2" },
        { px: "4", py: "5", episode: "a", step: "3" },
      ],
      mapping
    );
    expect(droppedRowCount).toBe(2);
    expect(points).toHaveLength(2);
    expect(points[0].x).toBe(1.5);
    expect(points[0].y).toBe(2);
  });

  it("assigns dense line ids in first-appearance order and keeps the source column as feature", () => {
    const { points } = normalizeSimpleRows(
      [
        { px: "0", py: "0", episode: "run-b", step: "0" },
        { px: "1", py: "0", episode: "run-a", step: "0" },
        { px: "2", py: "0", episode: "run-b", step: "1" },
      ],
      mapping
    );
    const byEpisode = new Map(points.map((p) => [p.episode, p.line]));
    expect(byEpisode.get("run-b")).toBe(0);
    expect(byEpisode.get("run-a")).toBe(1);
    // Sorted by (line, order): run-b rows first.
    expect(points.map((p) => p.line)).toEqual([0, 0, 1]);
  });

  it("sorts within a trajectory by the order column", () => {
    const { points } = normalizeSimpleRows(
      [
        { px: "0", py: "2", episode: "a", step: "2" },
        { px: "0", py: "0", episode: "a", step: "0" },
        { px: "0", py: "1", episode: "a", step: "1" },
      ],
      mapping
    );
    expect(points.map((p) => p.y)).toEqual([0, 1, 2]);
    expect(points.map((p) => p.id)).toEqual([0, 1, 2]);
  });

  it("keeps input order without an order column and gives each row its own line without a trajectory column", () => {
    const { points } = normalizeSimpleRows(
      [
        { px: "0", py: "9", label: "first" },
        { px: "1", py: "8", label: "second" },
      ],
      { x: "px", y: "py" }
    );
    expect(points.map((p) => p.y)).toEqual([9, 8]);
    expect(points[0].line).not.toBe(points[1].line);
  });

  it("coerces numeric feature strings and skips reserved column names", () => {
    const { points } = normalizeSimpleRows(
      [{ px: "0", py: "0", episode: "a", step: "0", reward: "0.75", name: "s0", id: "999" }],
      mapping
    );
    expect(points[0].reward).toBe(0.75);
    expect(points[0].name).toBe("s0");
    expect(points[0].step).toBe(0);
    // "id" is computed by the pipeline; the CSV column must not override it.
    expect(points[0].id).toBe(0);
  });

  it("keeps the x/y source columns as features (iris-style projections)", () => {
    const { points } = normalizeSimpleRows(
      [{ px: "1.5", py: "2.5", episode: "a", step: "0", petal: "3" }],
      mapping
    );
    expect(points[0].px).toBe(1.5);
    expect(points[0].py).toBe(2.5);
    expect(points[0].x).toBe(1.5);
  });

  it("maps the action column onto point.action as string", () => {
    const { points } = normalizeSimpleRows(
      [{ px: "0", py: "0", episode: "a", step: "0", move: "e4" }],
      { ...mapping, action: "move" }
    );
    expect(points[0].action).toBe("e4");
  });

  it("copies the label column onto point.label and keeps the source column (#305)", () => {
    const { points } = normalizeSimpleRows(
      [{ px: "0", py: "0", episode: "a", step: "0", variety: "Setosa" }],
      { ...mapping, label: "variety" }
    );
    // The standard label chain reads `label` (the bespoke-dataset convention).
    expect(points[0].label).toBe("Setosa");
    expect(points[0].variety).toBe("Setosa");
  });
});

describe("inferSimpleColumnMapping", () => {
  it("matches common headers case-insensitively", () => {
    expect(
      inferSimpleColumnMapping(["X", "Y", "Line", "Step", "Action", "reward"])
    ).toEqual({ x: "X", y: "Y", trajectory: "Line", order: "Step", action: "Action" });
  });

  it("leaves unmatched roles undefined", () => {
    const inferred = inferSimpleColumnMapping(["foo", "bar"]);
    expect(inferred.x).toBeUndefined();
    expect(inferred.y).toBeUndefined();
    expect(inferred.trajectory).toBeUndefined();
    expect(inferred.label).toBeUndefined();
  });

  it("seeds the label role from class-like headers (#305)", () => {
    expect(inferSimpleColumnMapping(["x", "y", "Variety"]).label).toBe("Variety");
    expect(inferSimpleColumnMapping(["x", "y", "species"]).label).toBe("species");
    // An explicit "label" header wins over later candidates.
    expect(inferSimpleColumnMapping(["x", "y", "class", "label"]).label).toBe("label");
  });
});

describe("buildSimpleDatasetObject", () => {
  // Two 4-point trajectories, shuffled row order to exercise sorting.
  const rows = [
    { x: "0", y: "0", line: "0", step: "0", reward: "1" },
    { x: "3", y: "1", line: "0", step: "3", reward: "2" },
    { x: "1", y: "0.5", line: "0", step: "1", reward: "1" },
    { x: "2", y: "0.8", line: "0", step: "2", reward: "3" },
    { x: "10", y: "10", line: "1", step: "0", reward: "0" },
    { x: "11", y: "10.5", line: "1", step: "1", reward: "0" },
    { x: "12", y: "10.8", line: "1", step: "2", reward: "1" },
    { x: "13", y: "11", line: "1", step: "3", reward: "2" },
  ];
  const mapping = { x: "x", y: "y", trajectory: "line", order: "step" };

  it("produces the bespoke-JSON object shape with all precomputed parts", () => {
    const phases: string[] = [];
    const obj = buildSimpleDatasetObject(rows, mapping, { datasetType: "Default" }, (p) =>
      phases.push(p)
    );

    expect(phases).toEqual([
      "normalize",
      "knn",
      "geometry",
      "clusterPoints",
      "clusterMidpoints",
    ]);
    expect(obj.data).toHaveLength(8);
    expect(obj.datasetType).toBe("default");
    expect(obj.droppedRowCount).toBe(0);

    // kNN: one self-inclusive row per point.
    expect(obj.knnGraph).toHaveLength(8);
    expect(obj.knnGraph[0]).toHaveLength(Math.min(SIMPLE_KNN_K, 8));
    expect(obj.knnGraph[0][0]).toBe(0);

    // Geometry: 3 edges per line × 20 samples.
    expect(obj.segments).toHaveLength(2 * 3 * 20);
    expect(obj.trajectoryMidpoints).toHaveLength(6);
    // nextEdgeCenter is attached to edge start records.
    expect(obj.data[0].nextEdgeCenter).toBeDefined();
    expect(obj.data[3].nextEdgeCenter).toBeUndefined(); // last point of line 0

    // Hierarchies: leaves carry leafIndex + bbox (rehydrate contract).
    const assertTree = (tree: ClusterTreeNode, expectedLeaves: number) => {
      let leaves = 0;
      const stack: ClusterTreeNode[] = [tree];
      while (stack.length) {
        const node = stack.pop()!;
        expect(node.bbox).toBeDefined();
        if (!node.leftChild && !node.rightChild) {
          leaves++;
          expect(
            node.leafIndex != null || (node.children && node.children.length === 1)
          ).toBe(true);
        }
        if (node.leftChild) stack.push(node.leftChild);
        if (node.rightChild) stack.push(node.rightChild);
      }
      expect(leaves).toBe(expectedLeaves);
    };
    expect(obj.hdbscan).toBeDefined();
    assertTree(obj.hdbscan!.hierarchyTree, 8);
    expect(obj.midpointHdbscan).toBeDefined();
    assertTree(obj.midpointHdbscan!.hierarchyTree, 6);
  });

  it("feeds through JSONLoader like a bespoke JSON payload", async () => {
    const obj = buildSimpleDatasetObject(rows, mapping, { datasetType: "default" });
    const dataset = await new Promise<Dataset>((resolve, reject) => {
      new JSONLoader().resolveParsed(obj, resolve).catch(reject);
    });

    expect(dataset.data).toHaveLength(8);
    expect(dataset.knnGraph).toHaveLength(8);
    expect(dataset.hdbscan).toBeDefined();
    expect(dataset.midpointHdbscan).toBeDefined();
    expect(dataset.datasetType).toBe("default");
    // Geometry converted to resident columns (columnar path downstream).
    const cols = dataset.segmentColumns!;
    expect(cols).toBeDefined();
    // Point 0 starts one 20-sample edge; point 3 ends one and starts none.
    const edgesStartingAt0 = Array.from(cols.edgeStart).filter((i) => i === 0);
    const edgesStartingAt3 = Array.from(cols.edgeStart).filter((i) => i === 3);
    const edgesEndingAt3 = Array.from(cols.edgeEnd).filter((i) => i === 3);
    expect(edgesStartingAt0).toHaveLength(1);
    expect(edgesEndingAt3).toHaveLength(1);
    expect(edgesStartingAt3).toHaveLength(0);
    expect(cols.edgeSegOffset[1] - cols.edgeSegOffset[0]).toBe(20);
  });

  it("streams within-phase progress fractions for the clustering phases", () => {
    const progress: Array<[string, number]> = [];
    buildSimpleDatasetObject(rows, mapping, {}, undefined, (phase, fraction) =>
      progress.push([phase, fraction])
    );
    const phases = new Set(progress.map(([p]) => p));
    expect(phases).toEqual(new Set(["clusterPoints", "clusterMidpoints"]));
    // Each clustering phase ends at fraction 1.
    expect(progress.filter(([p]) => p === "clusterPoints").pop()![1]).toBe(1);
    expect(progress.filter(([p]) => p === "clusterMidpoints").pop()![1]).toBe(1);
  });

  it("omits hierarchies for degenerate datasets instead of crashing", () => {
    const obj = buildSimpleDatasetObject(
      [{ x: "1", y: "1", line: "0", step: "0" }],
      mapping
    );
    expect(obj.data).toHaveLength(1);
    expect(obj.hdbscan).toBeUndefined();
    expect(obj.midpointHdbscan).toBeUndefined();
    expect(obj.segments).toHaveLength(0);
  });
});
