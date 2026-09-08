/**
 * Tests for the server-side lasso resolution helpers (issue #315 A2):
 * polygon decimation, screen→data conversion, leaf-range expansion, the
 * index-free linear hit-test, and the resolver's server/fallback contract.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import {
  consumePendingOverlay,
  resetServerDoiState,
} from "../doiPropagation/serverPropagation";
import {
  buildServerLassoResolver,
  decimatePolygon,
  expandLeafRangesToIds,
  linearPolygonHitTest,
  screenPolygonToData,
} from "./serverLasso";

jest.mock("@scaling", () => ({
  resolveCutProvider: jest.fn(() => null),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const scaling = require("@scaling") as { resolveCutProvider: jest.Mock };

const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
const yScale = d3.scaleLinear().domain([0, 1]).range([600, 0]);
const scales = { xScale, yScale };

function makeNodes(): DataPoint[] {
  const nodes: DataPoint[] = [];
  let id = 1;
  for (let gx = 0; gx <= 20; gx++) {
    for (let gy = 0; gy <= 20; gy++) {
      nodes.push({ id: id++, x: gx / 20, y: gy / 20, line: 0 } as unknown as DataPoint);
    }
  }
  return nodes;
}

function circle(cx: number, cy: number, r: number, n = 32): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

describe("decimatePolygon", () => {
  it("passes short polygons through untouched", () => {
    const poly = circle(0, 0, 1, 50);
    expect(decimatePolygon(poly, 128)).toBe(poly);
  });

  it("caps long polygons at maxVertices, keeping the first vertex", () => {
    const poly = circle(0, 0, 1, 1000);
    const out = decimatePolygon(poly, 128);
    expect(out.length).toBe(128);
    expect(out[0]).toBe(poly[0]);
    // Strictly increasing source positions (uniform stride).
    const idx = out.map((p) => poly.indexOf(p));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
});

describe("screenPolygonToData", () => {
  it("inverts scales + zoom transform per vertex", () => {
    const transform = d3.zoomIdentity.translate(-320, 180).scale(1.8);
    const data = screenPolygonToData([{ x: 400, y: 300 }], scales, transform);
    const [dx, dy] = data[0];
    // Round-trip: data → screen reproduces the input.
    expect(transform.applyX(xScale(dx))).toBeCloseTo(400, 6);
    expect(transform.applyY(yScale(dy))).toBeCloseTo(300, 6);
  });
});

describe("expandLeafRangesToIds", () => {
  it("expands half-open ranges through the leaf order", () => {
    const order = [4, 2, 0, 3, 1];
    const ids = expandLeafRangesToIds(order, [[0, 2], [3, 5]], (idx) => idx * 10);
    expect(ids).toEqual([40, 20, 30, 10]);
  });

  it("returns empty for no ranges", () => {
    expect(expandLeafRangesToIds([1, 2, 3], [], (i) => i)).toEqual([]);
  });
});

describe("linearPolygonHitTest", () => {
  it("matches a plain point-in-polygon scan over all nodes", () => {
    const nodes = makeNodes();
    const poly = circle(400, 300, 150);
    const got = linearPolygonHitTest(nodes, scales, d3.zoomIdentity, poly).sort((a, b) => a - b);
    // Reference: geometric containment in screen space (circle radius check
    // is exact for this fixture since the polygon is a fine circle).
    const ref = nodes
      .filter((n) => {
        const sx = xScale(n.x);
        const sy = yScale(n.y);
        return Math.hypot(sx - 400, sy - 300) < 150 * Math.cos(Math.PI / 32);
      })
      .map((n) => n.id)
      .sort((a, b) => a - b);
    // The inscribed-radius reference under-approximates near the boundary;
    // every reference hit must be selected and every selection must be
    // within the circumscribed radius.
    const gotSet = new Set(got);
    for (const id of ref) expect(gotSet.has(id)).toBe(true);
    for (const id of got) {
      const n = nodes.find((p) => p.id === id)!;
      expect(Math.hypot(xScale(n.x) - 400, yScale(n.y) - 300)).toBeLessThanOrEqual(150 + 1e-9);
    }
  });

  it("returns empty for degenerate polygons", () => {
    expect(linearPolygonHitTest(makeNodes(), scales, d3.zoomIdentity, [{ x: 0, y: 0 }])).toEqual([]);
  });
});

describe("buildServerLassoResolver", () => {
  const deps = {
    getNodes: makeNodes,
    getScales: () => scales,
    getZoomTransform: () => d3.zoomIdentity,
  };

  beforeEach(() => {
    scaling.resolveCutProvider.mockReset();
    scaling.resolveCutProvider.mockReturnValue(null);
    resetServerDoiState();
  });

  it("is undefined without a backend or without the select capability", () => {
    expect(buildServerLassoResolver(deps)).toBeUndefined();
    scaling.resolveCutProvider.mockReturnValue({});
    expect(buildServerLassoResolver(deps)).toBeUndefined();
  });

  it("expands server ranges to node ids via the leaf order", async () => {
    const order = [2, 0, 1];
    scaling.resolveCutProvider.mockReturnValue({
      select: jest.fn(async () => ({ ranges: [[1, 3]], n: 2 })),
      getLeafOrder: jest.fn(async () => order),
    });
    const resolver = buildServerLassoResolver(deps)!;
    const nodes = deps.getNodes();
    const ids = await resolver(circle(400, 300, 150));
    // Positions 1..3 of the order are dataset indices 0 and 1 → their ids.
    expect(ids).toEqual([nodes[0].id, nodes[1].id]);
  });

  it("fuses select+propagate and stashes the overlay when params are given (issue #315 P-d)", async () => {
    const overlay = {
      revision: 5,
      focusActive: true,
      runs: [[1, 2]] as Array<[number, number]>,
      values: Float32Array.from([1, 0.5]),
      visibleRanges: [] as Array<[number, number]>,
    };
    const order = [2, 0, 1];
    const select = jest.fn(async () => ({ ranges: [[0, 1]], n: 1 }));
    const selectPropagate = jest.fn(async () => ({ overlay, ranges: [[1, 3]], n: 2 }));
    scaling.resolveCutProvider.mockReturnValue({
      select,
      selectPropagate,
      getLeafOrder: jest.fn(async () => order),
    });
    const params = {
      proximity: 0.5, past: 0.5, future: 0.5, maxEmbeddingDistance: 1, k: 8,
      thresholds: { grayOut: 0.05, annotation: 0.7, inset: 0.9 },
    };
    const resolver = buildServerLassoResolver({ ...deps, getPropagateParams: () => params })!;
    const nodes = deps.getNodes();
    const ids = await resolver(circle(400, 300, 150));
    expect(selectPropagate).toHaveBeenCalledWith(
      "points",
      { polygon: expect.any(Array) },
      params
    );
    expect(select).not.toHaveBeenCalled();
    expect(ids).toEqual([nodes[0].id, nodes[1].id]);
    // The stash carries the resolved ids so a chained (superset) selection
    // can detect the mismatch and seed by ids instead.
    const consumed = consumePendingOverlay();
    expect(consumed?.overlay).toBe(overlay);
    expect(consumed?.ids).toEqual([nodes[0].id, nodes[1].id]);
  });

  it("keeps the stateless select when getPropagateParams returns null", async () => {
    const select = jest.fn(async () => ({ ranges: [[1, 3]], n: 2 }));
    const selectPropagate = jest.fn();
    scaling.resolveCutProvider.mockReturnValue({
      select,
      selectPropagate,
      getLeafOrder: jest.fn(async () => [2, 0, 1]),
    });
    const resolver = buildServerLassoResolver({ ...deps, getPropagateParams: () => null })!;
    await resolver(circle(400, 300, 150));
    expect(select).toHaveBeenCalled();
    expect(selectPropagate).not.toHaveBeenCalled();
  });

  it("falls back to the linear hit-test when the server call fails", async () => {
    scaling.resolveCutProvider.mockReturnValue({
      select: jest.fn(async () => {
        throw new Error("boom");
      }),
      getLeafOrder: jest.fn(async () => []),
    });
    const resolver = buildServerLassoResolver(deps)!;
    const poly = circle(400, 300, 150);
    const ids = await resolver(poly);
    const ref = linearPolygonHitTest(deps.getNodes(), scales, d3.zoomIdentity, poly);
    expect(ids.sort((a, b) => a - b)).toEqual(ref.sort((a, b) => a - b));
    expect(ids.length).toBeGreaterThan(0);
  });
});
