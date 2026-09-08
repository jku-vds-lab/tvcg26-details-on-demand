// packages/app/src/components/Visualization/Details/edgeSides.ts
//
// Side-channel for edge/diff sample arrays (issue #315): a builder that
// already KNOWS the two sides (e.g. HoverDiffGlyphs pairing cluster A with
// cluster B) attaches them as the non-enumerable `__edgeSides` marker, and
// every renderer's edgeSplit consults it first. This keeps the ORIGINAL
// side arrays flowing to the content components — identity-stable and
// `__leafRange`-marked, so backend requests go by range instead of
// materializing O(members) refs — and makes the split O(1) instead of a
// per-member walk (840k-member hover pairs froze for ~1.6 s).

import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

export interface EdgeSides {
  starts: DataPoint[];
  ends: DataPoint[];
}

/** Read the `__edgeSides` marker off an edge-sample array, if present. */
export function edgeSidesOf(samples: readonly DataPoint[]): EdgeSides | null {
  return (samples as { __edgeSides?: EdgeSides }).__edgeSides ?? null;
}

/** Attach the marker (non-enumerable — stays out of iteration/serialization). */
export function attachEdgeSides(samples: DataPoint[], sides: EdgeSides): void {
  Object.defineProperty(samples, "__edgeSides", {
    value: sides,
    enumerable: false,
    configurable: true,
  });
}
