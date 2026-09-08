// Jest stand-in for src/workers/workerFactories.ts (mapped in
// jest.config.cjs). The real module instantiates workers via
// `new URL(..., import.meta.url)`, which ts-jest's CommonJS module target
// cannot compile (TS1343) — so ANY import chain reaching it broke the whole
// suite at load time (the standing ClusterVisualizations.nopan failure).
// Suites that need worker BEHAVIOR keep mocking their own seam
// (make*Worker wrappers / hdbscanWorkerProxy); this stub only makes the
// module loadable and fails loudly if a test actually constructs a worker.
// Keep the export list in sync with workerFactories.ts.

function unavailable(name: string): never {
  throw new Error(
    `${name}: web workers are not available under jest — mock the calling seam in your test`
  );
}

export function makeJsonWorker(): Worker {
  return unavailable("makeJsonWorker");
}

export function makeLabeledExportWorker(): Worker {
  return unavailable("makeLabeledExportWorker");
}

export function makeHdbscanWorker(): Worker {
  return unavailable("makeHdbscanWorker");
}

export function makeSimplePreprocessWorker(): Worker {
  return unavailable("makeSimplePreprocessWorker");
}

export function makeSplineWorker(): Worker {
  return unavailable("makeSplineWorker");
}

export function makeMetricsWorker(): Worker {
  return unavailable("makeMetricsWorker");
}

export function makeUmapWorker(): Worker {
  return unavailable("makeUmapWorker");
}

export function makePropagationWorker(): Worker {
  return unavailable("makePropagationWorker");
}

export function makeFieldPreviewWorker(): Worker {
  return unavailable("makeFieldPreviewWorker");
}

export function makeFieldDistanceWorker(): Worker {
  return unavailable("makeFieldDistanceWorker");
}
