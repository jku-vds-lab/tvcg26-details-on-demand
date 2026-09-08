// Aggregate pyramid level must not follow the interactive-quality reduction
// (issue #315, CS 2026-07-26 regression b: "max opacity turns everything
// blurry instead of just transparent").
//
// levelFor CEILs a log2 of the on-screen bin pitch, so halving the drawing
// buffer during a drag drops the level by exactly one. That made every
// quality-reduced frame ask for a level whose tiles were not resident —
// all-or-nothing ⇒ raw-geometry fallback, a refetch of a whole level, and
// visibly coarser splats stretched over the half-resolution upscale. The level
// is a property of the VIEW, so draw() takes the full-quality width for it and
// keeps the real drawing-buffer width for the bin pitch.

import { AggregateLayer } from "./aggregateLayer";
import type { AggregateMeta, AggregateTile } from "../../scaling.types";

/** Minimal recording stand-in for WebGL2RenderingContext (jsdom has no GL). */
function mockGl(): WebGL2RenderingContext {
  const enums: Record<string, number> = {};
  let nextEnum = 1;
  const impl: Record<string, unknown> = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    createShader: () => ({}),
    createProgram: () => ({}),
    createBuffer: () => ({}),
    createTexture: () => ({}),
    createVertexArray: () => ({}),
    getUniformLocation: (_p: unknown, name: string) => name,
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      const key = String(prop);
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
        if (!(key in enums)) enums[key] = nextEnum++;
        return enums[key];
      }
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
}

const META: AggregateMeta = {
  minX: 0,
  minY: 0,
  maxX: 1,
  maxY: 1,
  binsPerTile: 256,
  maxLevel: 6,
  colorColumn: "algo",
  classes: ["a"],
  pointCount: 1_000_000,
};

/** Data [0,1]² → clip [-1,1]², column-major (matches gl.uniformMatrix3fv). */
const MATRIX = new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]);

const FULL_W = 2000;
const REDUCED_W = 1000; // FULL_W × INTERACTIVE_QUALITY_SCALE

function layerWithSpy(): { layer: AggregateLayer; levels: number[] } {
  const levels: number[] = [];
  const layer = new AggregateLayer(mockGl(), () => {}, () => [0, 0, 0]);
  layer.setSource({
    meta: META,
    getTile: (level: number): Promise<AggregateTile | null> => {
      levels.push(level);
      return Promise.resolve(null);
    },
  });
  return { layer, levels };
}

const params = (levelCanvasWidth: number) => ({
  pointSizePx: 2,
  alpha: 1,
  outlineWidthPx: 0,
  outlineWhite: false,
  levelCanvasWidth,
});

test("halving the drawing buffer drops the level by exactly one (the mechanism)", () => {
  const { layer } = layerWithSpy();
  const full = layer.levelFor(MATRIX, FULL_W);
  const reduced = layer.levelFor(MATRIX, REDUCED_W);
  expect(full).not.toBeNull();
  expect(reduced).toBe((full as number) - 1);
});

test("a quality-reduced frame fetches the SAME level as the full-quality frame", () => {
  const atRest = layerWithSpy();
  atRest.layer.draw(MATRIX, FULL_W, params(FULL_W));
  const restLevels = Array.from(new Set(atRest.levels));

  const midDrag = layerWithSpy();
  // Drawing buffer halved by setInteractiveQuality, view unchanged.
  midDrag.layer.draw(MATRIX, REDUCED_W, params(FULL_W));
  const dragLevels = Array.from(new Set(midDrag.levels));

  expect(restLevels).toHaveLength(1);
  expect(dragLevels).toEqual(restLevels);
});

test("level follows the width it is given (guards the wiring, not the math)", () => {
  const { layer, levels } = layerWithSpy();
  // Passing the reduced width as the level width reproduces the regression —
  // this is what drawScene must never do.
  layer.draw(MATRIX, REDUCED_W, params(REDUCED_W));
  expect(Array.from(new Set(levels))).toEqual([layer.levelFor(MATRIX, REDUCED_W)]);
});
