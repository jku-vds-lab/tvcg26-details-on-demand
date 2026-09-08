// packages/app/src/workers/workerFactories.ts
//
// Web-build worker factories: workers are emitted as separate chunks and
// instantiated via `new URL(..., import.meta.url)` (Vite convention).
//
// The widget build (vite.config.widget.ts) aliases this module to
// workerFactories.widget.ts, which inlines the worker code instead — the
// anywidget _esm bundle loads from a blob URL in Jupyter, where separate
// worker chunks cannot be resolved. Keep the two modules' export lists in
// sync.

export function makeJsonWorker(): Worker {
  return new Worker(new URL("./jsonParse.worker.ts", import.meta.url), { type: "module" });
}

export function makeLabeledExportWorker(): Worker {
  return new Worker(new URL("./labeledExport.worker.ts", import.meta.url), { type: "module" });
}

export function makeHdbscanWorker(): Worker {
  return new Worker(new URL("./hdbscan.worker.ts", import.meta.url), { type: "module" });
}

export function makeSimplePreprocessWorker(): Worker {
  return new Worker(new URL("./simplePreprocess.worker.ts", import.meta.url), {
    type: "module",
  });
}

export function makeSplineWorker(): Worker {
  return new Worker(new URL("./spline.worker.ts", import.meta.url), { type: "module" });
}

export function makeMetricsWorker(): Worker {
  return new Worker(new URL("./metrics.worker.ts", import.meta.url), { type: "module" });
}

export function makeUmapWorker(): Worker {
  return new Worker(new URL("./umap.worker.ts", import.meta.url), { type: "module" });
}

export function makeFieldPreviewWorker(): Worker {
  return new Worker(new URL("./fieldPreview.worker.ts", import.meta.url), { type: "module" });
}

export function makeFieldDistanceWorker(): Worker {
  return new Worker(new URL("./fieldDistance.worker.ts", import.meta.url), { type: "module" });
}
