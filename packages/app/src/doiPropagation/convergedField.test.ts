// packages/app/src/doiPropagation/convergedField.test.ts
//
// Contract tests for the converged alternation core (convergedField.ts):
// chain-inert inputs stay byte-identical to the shipped first-order output,
// bridge topologies gain the re-spread the first-order lane truncated, every
// write is raise-only, and the slider endpoints degrade to the documented
// behaviors.

import { computeMaxEmbeddingDistance } from "../utils/embedding";
import {
  CONV_EPS,
  CONV_MAX_ROUNDS,
  runConvergedAlternationCore,
} from "./convergedField";
import { evalFalloffField } from "./falloff";
import { computeRecordDistances, rasterize, type FieldRaster } from "./fieldDistanceCore";
import { chainScanTrajectoryCore } from "./fieldPreviewCore";

const GRID = 64;

/** Bridge topology (doc §5.2): two dense clusters far apart, one stored
 * trajectory running from cluster A through the gap into cluster B. Seeds
 * live in cluster A only. */
function bridgeScene() {
  const x: number[] = [];
  const y: number[] = [];
  // Cluster A: 5×5 block near the origin.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      x.push(i * 0.1);
      y.push(j * 0.1);
    }
  }
  const aEnd = x.length; // 25
  // Cluster B: 5×5 block at distance 10.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      x.push(10 + i * 0.1);
      y.push(j * 0.1);
    }
  }
  const bEnd = x.length; // 50
  // Bridge trajectory: 11 points from A's center to B's center.
  const trajStart = x.length;
  for (let t = 0; t <= 10; t++) {
    x.push(0.2 + (10 + 0.2 - 0.2) * (t / 10));
    y.push(0.2);
  }
  const n = x.length;
  const predIndex = new Int32Array(n).fill(-1);
  const succIndex = new Int32Array(n).fill(-1);
  for (let t = 0; t <= 10; t++) {
    const i = trajStart + t;
    if (t > 0) predIndex[i] = i - 1;
    if (t < 10) succIndex[i] = i + 1;
  }
  const seedIdx = Array.from({ length: aEnd }, (_, i) => i);
  const maxEmb = computeMaxEmbeddingDistance(x.map((px, i) => ({ x: px, y: y[i] })));
  return { x, y, n, predIndex, succIndex, seedIdx, aEnd, bEnd, trajStart, maxEmb };
}

/** Round-0 buffer exactly as applyResidentFieldLocally builds it: falloff
 * over the seed EDT + seed clamp, PRE-chain. */
function round0Buffer(
  scene: ReturnType<typeof bridgeScene>,
  prox: number
): Float32Array {
  const { recordDist } = computeRecordDistances({
    x: scene.x,
    y: scene.y,
    seedIdx: scene.seedIdx,
    gridResolution: GRID,
  });
  const v = evalFalloffField(recordDist, "log", prox, scene.maxEmb);
  for (const i of scene.seedIdx) v[i] = 1;
  return v;
}

function rasterOf(scene: ReturnType<typeof bridgeScene>): () => FieldRaster {
  return () => rasterize(scene.x, scene.y, GRID);
}

describe("runConvergedAlternationCore", () => {
  test("chain-inert input: byte-identical to the shipped first-order output", () => {
    const scene = bridgeScene();
    // Sever the trajectory: every point is its own line — the chain cannot
    // raise anything (the mnist/fashion regime, residual 0.0 by construction).
    const pred = new Int32Array(scene.n).fill(-1);
    const succ = new Int32Array(scene.n).fill(-1);
    const v = round0Buffer(scene, 0.3);
    const shipped = Float32Array.from(v);
    chainScanTrajectoryCore(shipped, pred, succ, 0.75, 0.75);
    let rasterized = false;
    const stats = runConvergedAlternationCore(v, pred, succ, () => {
      rasterized = true;
      return rasterOf(scene)();
    }, { shape: "log", prox: 0.3, maxEmb: scene.maxEmb, past: 0.75, future: 0.75 });
    expect(Array.from(v)).toEqual(Array.from(shipped));
    expect(stats.rounds).toBe(1);
    expect(stats.respreads).toBe(0);
    expect(stats.converged).toBe(true);
    expect(rasterized).toBe(false); // lazy raster never paid
  });

  test("bridge topology: re-spread colors the far cluster beyond round 0", () => {
    const scene = bridgeScene();
    const prox = 0.3;
    const v = round0Buffer(scene, prox);
    const shipped = Float32Array.from(v);
    chainScanTrajectoryCore(shipped, scene.predIndex, scene.succIndex, 0.9, 0.9);
    const stats = runConvergedAlternationCore(
      v,
      scene.predIndex,
      scene.succIndex,
      rasterOf(scene),
      { shape: "log", prox, maxEmb: scene.maxEmb, past: 0.9, future: 0.9 }
    );
    expect(stats.converged).toBe(true);
    expect(stats.rounds).toBeLessThanOrEqual(CONV_MAX_ROUNDS);
    expect(stats.respreads).toBeGreaterThanOrEqual(1);
    // Raise-only: the converged field dominates the shipped one pointwise.
    for (let i = 0; i < scene.n; i++) {
      expect(v[i]).toBeGreaterThanOrEqual(shipped[i]);
    }
    // Seeds stay exactly 1.
    for (const i of scene.seedIdx) expect(v[i]).toBe(1);
    // The chain raised the bridge trajectory's B-side end; the re-spread must
    // recruit cluster B's OFF-trajectory points, which round 0 + one chain
    // leaves untouched (they are neither seeded nor on any line).
    let raisedOffTraj = 0;
    for (let i = scene.aEnd; i < scene.bEnd; i++) {
      if (v[i] > shipped[i] + CONV_EPS) raisedOffTraj++;
    }
    expect(raisedOffTraj).toBeGreaterThan(0);
  });

  test("slider endpoints (p=0 seeds-only, p=1 flood): chain runs, no re-spread", () => {
    const scene = bridgeScene();
    // Seed the bridge's first trajectory point too, so at p=0 the chain DOES
    // raise states and the no-spatial-term guard (not the trivial no-raise
    // exit) is what stops the alternation.
    scene.seedIdx.push(scene.trajStart);
    for (const prox of [0, 1]) {
      const v = round0Buffer(scene, prox);
      const shipped = Float32Array.from(v);
      chainScanTrajectoryCore(shipped, scene.predIndex, scene.succIndex, 0.9, 0.9);
      const stats = runConvergedAlternationCore(
        v,
        scene.predIndex,
        scene.succIndex,
        rasterOf(scene),
        { shape: "log", prox, maxEmb: scene.maxEmb, past: 0.9, future: 0.9 }
      );
      expect(Array.from(v)).toEqual(Array.from(shipped));
      expect(stats.respreads).toBe(0);
      expect(stats.converged).toBe(true);
    }
  });
});
