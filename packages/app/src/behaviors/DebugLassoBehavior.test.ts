/**
 * Tests for the lasso R-tree bbox prefilter (perf overhaul phase 6).
 *
 * The prefilter must select exactly the same node ids as a full scan, and must
 * fall back to the full scan when the tree is stale (size mismatch during a
 * dataset switch).
 */

import { describe, expect, it, jest } from "@jest/globals";
import * as d3 from "d3";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { createLassoBehavior } from "./DebugLassoBehavior";

// ── stubs ────────────────────────────────────────────────────────────────────

function makeOverlay(): HTMLCanvasElement {
  const ctx = {
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: () => {},
    stroke: () => {},
    setLineDash: () => {},
  };
  return {
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    width: 800,
    height: 600,
  } as unknown as HTMLCanvasElement;
}

interface TreeItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  data: DataPoint;
}

/** Mirrors the padded item layout of buildPointRTreeChunked. */
function makeTree(nodes: DataPoint[], padding = 0.5) {
  const items: TreeItem[] = nodes.map((p) => ({
    minX: p.x - padding,
    minY: p.y - padding,
    maxX: p.x + padding,
    maxY: p.y + padding,
    data: p,
  }));
  return {
    all: () => items,
    search: (bbox: { minX: number; minY: number; maxX: number; maxY: number }) =>
      items.filter(
        (it) =>
          it.minX <= bbox.maxX &&
          it.maxX >= bbox.minX &&
          it.minY <= bbox.maxY &&
          it.maxY >= bbox.minY
      ),
  };
}

function makeNodes(): DataPoint[] {
  // 21×21 grid over the unit square.
  const nodes: DataPoint[] = [];
  let id = 1;
  for (let gx = 0; gx <= 20; gx++) {
    for (let gy = 0; gy <= 20; gy++) {
      nodes.push({ id: id++, x: gx / 20, y: gy / 20, line: 0 } as unknown as DataPoint);
    }
  }
  return nodes;
}

function makeBehavior(
  nodes: DataPoint[],
  tree: ReturnType<typeof makeTree> | null,
  transform: d3.ZoomTransform,
  resolveSelection?: (poly: { x: number; y: number }[]) => Promise<number[]>
) {
  const xScale = d3.scaleLinear().domain([0, 1]).range([0, 800]);
  // Inverted range, as screen y grows downward.
  const yScale = d3.scaleLinear().domain([0, 1]).range([600, 0]);

  const onComplete = jest.fn();
  const behavior = createLassoBehavior({
    overlay: makeOverlay(),
    getNodes: () => nodes,
    getScales: () => ({ xScale, yScale }),
    getZoomTransform: () => transform,
    getRTree: () => tree as never,
    onComplete: onComplete as never,
    resolveSelection,
  });
  return { behavior, onComplete };
}

const evt = (x: number, y: number) =>
  ({ button: 0, pointerId: 1, clientX: x, clientY: y, ctrlKey: false }) as unknown as PointerEvent;

/** Draw a circle (screen space) around the middle of the viewport. */
function drawCircleLasso(behavior: ReturnType<typeof makeBehavior>["behavior"]) {
  const cx = 400, cy = 300, r = 150;
  behavior.onStart(evt(cx + r, cy));
  for (let i = 1; i <= 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    behavior.onMove(evt(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  behavior.onEnd(evt(cx + r, cy));
}

function runLasso(
  nodes: DataPoint[],
  tree: ReturnType<typeof makeTree> | null,
  transform: d3.ZoomTransform
): number[] {
  const { behavior, onComplete } = makeBehavior(nodes, tree, transform);
  drawCircleLasso(behavior);
  expect(onComplete).toHaveBeenCalledTimes(1);
  return (onComplete.mock.calls[0][0] as number[]).slice().sort((a, b) => a - b);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("lasso R-tree prefilter", () => {
  it("selects the same ids as a full scan (identity transform)", () => {
    const nodes = makeNodes();
    // Full-scan reference: a "stale" tree (size mismatch) forces the fallback.
    const reference = runLasso(nodes, makeTree(nodes.slice(0, 5)), d3.zoomIdentity);
    const prefiltered = runLasso(nodes, makeTree(nodes), d3.zoomIdentity);

    expect(prefiltered.length).toBeGreaterThan(0);
    expect(prefiltered).toEqual(reference);
  });

  it("selects the same ids as a full scan under zoom + pan", () => {
    const nodes = makeNodes();
    const transform = d3.zoomIdentity.translate(-320, 180).scale(1.8);
    const reference = runLasso(nodes, makeTree(nodes.slice(0, 5)), transform);
    const prefiltered = runLasso(nodes, makeTree(nodes), transform);

    expect(prefiltered.length).toBeGreaterThan(0);
    expect(prefiltered).toEqual(reference);
  });

  it("excludes nodes outside the lasso", () => {
    const nodes = makeNodes();
    const selected = new Set(runLasso(nodes, makeTree(nodes), d3.zoomIdentity));
    // Corner node (0,0) maps to screen (0,600) — far outside the circle.
    const corner = nodes.find((n) => n.x === 0 && n.y === 0)!;
    expect(selected.has(corner.id)).toBe(false);
    expect(selected.size).toBeLessThan(nodes.length);
  });

  it("full-scans when no tree exists at all (issue #315 A2)", () => {
    const nodes = makeNodes();
    const reference = runLasso(nodes, makeTree(nodes), d3.zoomIdentity);
    const noTree = runLasso(nodes, null, d3.zoomIdentity);
    expect(noTree).toEqual(reference);
    expect(noTree.length).toBeGreaterThan(0);
  });
});

describe("server-side lasso resolution (issue #315 A2)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("completes with the resolver's ids for polygon lassos", async () => {
    const nodes = makeNodes();
    const resolver = jest.fn(async () => [7, 11]);
    const { behavior, onComplete } = makeBehavior(
      nodes, makeTree(nodes), d3.zoomIdentity, resolver as never
    );
    drawCircleLasso(behavior);
    await flush();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toEqual([7, 11]);
  });

  it("falls back to the local hit-test when the resolver rejects", async () => {
    const nodes = makeNodes();
    const reference = runLasso(nodes, makeTree(nodes), d3.zoomIdentity);
    const resolver = jest.fn(async () => {
      throw new Error("server down");
    });
    const { behavior, onComplete } = makeBehavior(
      nodes, makeTree(nodes), d3.zoomIdentity, resolver as never
    );
    drawCircleLasso(behavior);
    await flush();
    expect(onComplete).toHaveBeenCalledTimes(1);
    const ids = (onComplete.mock.calls[0][0] as number[]).slice().sort((a, b) => a - b);
    expect(ids).toEqual(reference);
  });

  it("drops an in-flight resolution when a new stroke starts", async () => {
    const nodes = makeNodes();
    let releaseFirst: (ids: number[]) => void = () => {};
    const first = new Promise<number[]>((resolve) => { releaseFirst = resolve; });
    const resolver = jest
      .fn<() => Promise<number[]>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([99]);
    const { behavior, onComplete } = makeBehavior(
      nodes, makeTree(nodes), d3.zoomIdentity, resolver as never
    );
    drawCircleLasso(behavior);
    drawCircleLasso(behavior); // second stroke supersedes the first
    releaseFirst([1, 2, 3]); // stale answer arrives late
    await flush();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toEqual([99]);
  });
});
