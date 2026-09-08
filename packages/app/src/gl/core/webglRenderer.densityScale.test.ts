// densityPointScale hint fallback (issue #315 G4 — aggregate-first base):
// with no raw geometry loaded (nodeCount 0), the aggregate meta's point
// count + bbox must drive the same density shrink the loaded dataset gets,
// so switch-time bases render thin splats instead of full-size marks.
import { DENSITY_REFERENCE_NODE_RADIUS, densityPointScale } from "./webglRenderer";
import type { WebGLRenderer } from "./webglRenderer";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function fakeRenderer(overrides: Partial<WebGLRenderer>): WebGLRenderer {
  return {
    nodeCount: 0,
    dataBboxW: 0,
    dataBboxH: 0,
    densityHint: null,
    transformMatrix: IDENTITY,
    currentVisualSettings: { nodeRadius: 25 },
    ...overrides,
  } as unknown as WebGLRenderer;
}

const CANVAS_W = 1000;
const CANVAS_H = 1000;
const DPR = 1;

test("empty renderer without a hint keeps the configured size (scale 1)", () => {
  expect(densityPointScale(fakeRenderer({}), CANVAS_W, CANVAS_H, DPR)).toBe(1);
});

test("empty renderer with a 1M-point hint shrinks exactly like the loaded dataset", () => {
  const hinted = fakeRenderer({
    densityHint: { count: 1_000_000, bboxW: 2, bboxH: 2 },
  });
  const loaded = fakeRenderer({
    nodeCount: 1_000_000,
    dataBboxW: 2,
    dataBboxH: 2,
  });
  const hintedScale = densityPointScale(hinted, CANVAS_W, CANVAS_H, DPR);
  const loadedScale = densityPointScale(loaded, CANVAS_W, CANVAS_H, DPR);
  expect(hintedScale).toBeLessThan(1);
  expect(hintedScale).toBeCloseTo(loadedScale, 12);
});

test("real geometry wins over a stale huge hint (small dataset stays unscaled)", () => {
  const renderer = fakeRenderer({
    nodeCount: 2_000,
    dataBboxW: 2,
    dataBboxH: 2,
    densityHint: { count: 1_000_000, bboxW: 2, bboxH: 2 },
  });
  expect(densityPointScale(renderer, CANVAS_W, CANVAS_H, DPR)).toBe(1);
});

test("hint at or below the 300k gate keeps scale 1", () => {
  const renderer = fakeRenderer({
    densityHint: { count: 300_000, bboxW: 2, bboxH: 2 },
  });
  expect(densityPointScale(renderer, CANVAS_W, CANVAS_H, DPR)).toBe(1);
});

// ── slider authority under the cap (issue #315, CS 2026-07-26 regression a) ──
// The cap used to be an ABSOLUTE pixel target, so `nodeRadius × dpr × scale`
// collapsed to it: the Node Radius slider was a no-op on every >300k dataset
// and the arrow length (same factor) SHRANK as nodes grew.

/** Effective device-px radius — what the node/aggregate passes actually use. */
function effectiveRadiusPx(nodeRadius: number): number {
  const renderer = fakeRenderer({
    nodeCount: 1_000_000,
    dataBboxW: 2,
    dataBboxH: 2,
    currentVisualSettings: { nodeRadius } as never,
  });
  return nodeRadius * DPR * densityPointScale(renderer, CANVAS_W, CANVAS_H, DPR);
}

test("at the reference radius the cap is exactly the coverage budget (look unchanged)", () => {
  // 1M points over a 2×2 data bbox at 500 px/unit ⇒ density 1 px⁻², whose
  // ~3× coverage budget is below the 1.25 px floor, so the floor is the cap.
  expect(effectiveRadiusPx(DENSITY_REFERENCE_NODE_RADIUS)).toBeCloseTo(1.25 * DPR, 12);
});

test("the slider keeps linear authority while the cap is engaged", () => {
  const base = effectiveRadiusPx(DENSITY_REFERENCE_NODE_RADIUS);
  expect(effectiveRadiusPx(2 * DENSITY_REFERENCE_NODE_RADIUS)).toBeCloseTo(2 * base, 12);
  expect(effectiveRadiusPx(4 * DENSITY_REFERENCE_NODE_RADIUS)).toBeCloseTo(4 * base, 12);
  // Monotone across the whole slider range, never above the configured size.
  // Not STRICTLY monotone at the bottom: the ~1.25 px visibility floor holds
  // radii under it up, so 2 and 5 both land on the floor here.
  let prev = 0;
  for (const r of [1, 2, 5, 10, 20, 40]) {
    const px = effectiveRadiusPx(r);
    expect(px).toBeGreaterThanOrEqual(prev);
    expect(px).toBeLessThanOrEqual(r * DPR + 1e-9);
    prev = px;
  }
  // Strictly increasing once the configured radius clears the floor.
  expect(effectiveRadiusPx(10)).toBeGreaterThan(effectiveRadiusPx(5));
  expect(effectiveRadiusPx(40)).toBeGreaterThan(effectiveRadiusPx(20));
});
