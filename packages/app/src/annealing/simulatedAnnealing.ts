// simulatedAnnealing.ts

import type { Pos } from "src/layout/layoutStore";
import { VisualElement } from "src/models/VisualElement";

/**
 * Only accept a move if it improves the cost by at least this amount.
 * Set to 0 (the default) to accept any improvement.
 */
const MIN_IMPROVEMENT_THRESHOLD = 1e-2;

export interface AnnealingOptions {
  elements: VisualElement[];
  initialPositions: Map<string, Pos>;
  costFunction: (positions: Map<string, Pos>) => number;
  generateNeighbor: (positions: Map<string, Pos>) => {
    id: string;
    old: Pos;
    next: Pos;
    el: VisualElement;
    movement: number;
  };
  coolingRate: number;
  minTemperature: number;
  maxIterations: number;
  /**
   * Wall-clock budget for this run. Checked every 32 iterations; the run
   * returns its best-so-far patch when exceeded. Callers that re-run every
   * frame (useLayoutEngine) use this to bound rAF-callback time — cooling is
   * per-accepted-move, so spreading iterations across frames only stretches
   * convergence wall-clock, never changes the temperature semantics.
   */
  budgetMs?: number;
}

export interface AnnealingDiagnostics {
  initialCost: number;
  finalCost: number;
  bestCost: number;
  acceptedMoves: number;
  attemptedMoves: number;
  iterations: number;
}

export interface SimulatedAnnealingResult {
  patch: Map<string, Pos>;
  diagnostics: AnnealingDiagnostics;
}

export function simulatedAnnealing(options: AnnealingOptions): SimulatedAnnealingResult {
  const positions = new Map(options.initialPositions);
  let currentCost = options.costFunction(positions);
  const initialCost = currentCost;
  let best = new Map(positions);
  let bestCost = currentCost;
  let acceptedMoves = 0;
  let attemptedMoves = 0;
  let iterations = 0;
  const budgetMs = options.budgetMs;
  const startMs = budgetMs !== undefined ? performance.now() : 0;

  for (let iter = 0; iter < options.maxIterations; iter++) {
    if (
      budgetMs !== undefined &&
      (iter & 31) === 31 &&
      performance.now() - startMs >= budgetMs
    ) {
      break;
    }
    iterations = iter + 1;
    attemptedMoves += 1;
    const { id, old, next, el, movement } = options.generateNeighbor(positions);
    positions.set(id, next);
    el.movement = movement;
    const newCost = options.costFunction(positions);
    const delta = newCost - currentCost;
    const temp = el.temperature;

    let accept: boolean;
    if (delta < 0) {
      accept = -delta >= MIN_IMPROVEMENT_THRESHOLD;
    } else {
      accept = Math.exp(-delta / temp) > Math.random();
    }

    if (accept) {
      acceptedMoves += 1;
      currentCost = newCost;
      if (currentCost < bestCost) {
        bestCost = currentCost;
        best = new Map(positions);
      }
      el.coolDown(options.coolingRate);
    } else {
      positions.set(id, old);
      el.movement = 0;
    }

    if (options.elements.every((e) => e.temperature <= options.minTemperature)) {
      break;
    }
  }

  const patch = new Map<string, Pos>();
  best.forEach((p, id) => {
    const orig = options.initialPositions.get(id);
    if (!orig || orig.x !== p.x || orig.y !== p.y) {
      patch.set(id, p);
    }
  });

  return {
    patch,
    diagnostics: {
      initialCost,
      finalCost: currentCost,
      bestCost,
      acceptedMoves,
      attemptedMoves,
      iterations,
    },
  };
}
