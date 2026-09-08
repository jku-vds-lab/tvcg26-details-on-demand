import type { Pos } from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";
import { simulatedAnnealing, type AnnealingOptions } from "./simulatedAnnealing";

/** Minimal stub — the annealer only touches temperature/coolDown/movement. */
function makeElement(id: string, temperature = 1): VisualElement {
  const el = {
    id,
    temperature,
    movement: 0,
    coolDown(rate: number) {
      this.temperature *= rate;
    },
  };
  return el as unknown as VisualElement;
}

function makeOptions(el: VisualElement, overrides: Partial<AnnealingOptions> = {}): AnnealingOptions {
  let flip = 0;
  return {
    elements: [el],
    initialPositions: new Map<string, Pos>([[el.id, { x: 0, y: 0 }]]),
    // Non-constant cost so moves keep being attempted (never converges by cost).
    costFunction: (pos) => Math.abs((pos.get(el.id)?.x ?? 0) - 1000),
    generateNeighbor: (pos) => {
      const old = pos.get(el.id) ?? { x: 0, y: 0 };
      flip += 1;
      return { id: el.id, old, next: { x: old.x + (flip % 2 ? 1 : -0.5), y: 0 }, el, movement: 1 };
    },
    coolingRate: 1, // never cools → never converges by temperature
    minTemperature: 1e-3,
    maxIterations: 100_000,
    ...overrides,
  };
}

describe("simulatedAnnealing budgetMs", () => {
  it("stops within one check-window once the budget is exhausted", () => {
    const el = makeElement("a");
    const result = simulatedAnnealing(makeOptions(el, { budgetMs: 0 }));
    // budget 0 → first check at iteration 32 aborts the run
    expect(result.diagnostics.iterations).toBeLessThanOrEqual(32);
    expect(result.patch).toBeInstanceOf(Map);
  });

  it("runs to maxIterations when no budget is set", () => {
    const el = makeElement("b");
    const result = simulatedAnnealing(makeOptions(el, { maxIterations: 200 }));
    expect(result.diagnostics.iterations).toBe(200);
  });

  it("still returns the best-so-far improvement found before the cutoff", () => {
    const el = makeElement("c");
    const result = simulatedAnnealing(makeOptions(el, { budgetMs: 0 }));
    // Moves toward x=1000 monotonically improve cost; some are accepted even
    // in <32 iterations, so the patch reflects the best positions found.
    expect(result.diagnostics.attemptedMoves).toBeGreaterThan(0);
    expect(result.diagnostics.bestCost).toBeLessThanOrEqual(result.diagnostics.initialCost);
  });
});
