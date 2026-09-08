// packages/app/src/workers/umap.worker.ts
//
// Runs the in-app UMAP projection entirely off the main thread, then builds
// the k=5 2D kNN graph over the final embedding so the main thread can apply
// coords + kNN in a single React batch (one renderer rebuild).
//
// Wire types are kept local to avoid cross-context import issues; they must
// stay in sync with UmapWorkerRequest / UmapWorkerResponse in umapWorkerProxy.ts.

import { UMAP } from "umap-js";

import type { KnnGraph } from "../types/graphTypes";
import { buildKnn2d } from "../utils/knn2d";

export type UmapMetric = "euclidean" | "cosine" | "manhattan";

interface WorkerRequest {
  jobId: number;
  /** Row-major nRows × nCols feature matrix (transferred). */
  matrix: ArrayBuffer;
  nRows: number;
  nCols: number;
  params: {
    nNeighbors: number;
    minDist: number;
    spread: number;
    /** 0 = let umap-js pick automatically from the dataset size. */
    nEpochs: number;
    metric: UmapMetric;
    seed: number;
  };
}

interface WorkerResponse {
  jobId: number;
  type: "progress" | "done" | "error";
  /**
   * Which run stage a progress message belongs to. "neighbors"
   * (initializeFit's NNDescent kNN search — umap-js exposes no per-iteration
   * hook, so it reports once, unquantified) and "knn2d" (2D kNN over the
   * final embedding) bracket the quantified "epochs" stage.
   */
  stage?: "neighbors" | "epochs" | "knn2d";
  epoch?: number;
  totalEpochs?: number;
  /** Interleaved [x0, y0, x1, y1, ...] embedding (transferred). */
  coords?: ArrayBuffer;
  knnGraph?: KnnGraph;
  error?: string;
}

type Vector = number[];

const METRIC_FNS: Record<UmapMetric, (a: Vector, b: Vector) => number> = {
  euclidean: (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  },
  manhattan: (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum;
  },
  cosine: (a, b) => {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return normA === normB ? 0 : 1;
    return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
  },
};

/** Deterministic PRNG so equal seeds give reproducible embeddings. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { jobId, matrix, nRows, nCols, params } = ev.data;

  try {
    const flat = new Float32Array(matrix);
    const rows: number[][] = new Array(nRows);
    for (let r = 0; r < nRows; r++) {
      const row: number[] = new Array(nCols);
      for (let c = 0; c < nCols; c++) row[c] = flat[r * nCols + c];
      rows[r] = row;
    }

    const umap = new UMAP({
      nComponents: 2,
      // umap-js requires nNeighbors < nRows.
      nNeighbors: Math.min(params.nNeighbors, Math.max(2, nRows - 1)),
      minDist: params.minDist,
      spread: params.spread,
      ...(params.nEpochs > 0 ? { nEpochs: params.nEpochs } : {}),
      distanceFn: METRIC_FNS[params.metric],
      random: mulberry32(params.seed),
    });

    // initializeFit dominates startup (kNN search over the high-dimensional
    // feature space); announce it so the UI isn't stuck on a silent bar.
    const neighborsMsg: WorkerResponse = { jobId, type: "progress", stage: "neighbors" };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore web worker global
    self.postMessage(neighborsMsg);

    const totalEpochs = umap.initializeFit(rows);
    const progressEvery = Math.max(1, Math.floor(totalEpochs / 100));

    for (let epoch = 0; epoch < totalEpochs; epoch++) {
      umap.step();
      if (epoch % progressEvery === 0 || epoch === totalEpochs - 1) {
        const progress: WorkerResponse = {
          jobId,
          type: "progress",
          stage: "epochs",
          epoch: epoch + 1,
          totalEpochs,
        };
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore web worker global
        self.postMessage(progress);
      }
    }

    const embedding = umap.getEmbedding();
    const coords = new Float32Array(2 * nRows);
    for (let i = 0; i < nRows; i++) {
      coords[2 * i] = embedding[i][0];
      coords[2 * i + 1] = embedding[i][1];
    }

    const knn2dMsg: WorkerResponse = { jobId, type: "progress", stage: "knn2d" };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore web worker global
    self.postMessage(knn2dMsg);

    const knnGraph = buildKnn2d(coords, 5);

    const coordsBuffer = coords.buffer as ArrayBuffer;
    const response: WorkerResponse = { jobId, type: "done", coords: coordsBuffer, knnGraph };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore web worker global
    self.postMessage(response, [coordsBuffer]);
  } catch (err) {
    const response: WorkerResponse = {
      jobId,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    };
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore web worker global
    self.postMessage(response);
  }
};
