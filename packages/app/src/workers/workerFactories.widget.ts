// packages/app/src/workers/workerFactories.widget.ts
//
// Widget-build worker factories: swapped in for workerFactories.ts by a
// resolve alias in vite.config.widget.ts. Workers are inlined into the
// bundle (`?worker&inline`) because the anywidget _esm module is loaded
// from a blob URL in Jupyter, where separate worker chunks cannot be
// resolved. Keep the export list in sync with workerFactories.ts.

import InlineHdbscanWorker from "./hdbscan.worker?worker&inline";
import InlineJsonWorker from "./jsonParse.worker?worker&inline";
import InlineLabeledExportWorker from "./labeledExport.worker?worker&inline";
import InlineMetricsWorker from "./metrics.worker?worker&inline";
import InlineSimplePreprocessWorker from "./simplePreprocess.worker?worker&inline";
import InlineFieldPreviewWorker from "./fieldPreview.worker?worker&inline";
import InlineFieldDistanceWorker from "./fieldDistance.worker?worker&inline";
import InlineSplineWorker from "./spline.worker?worker&inline";
import InlineUmapWorker from "./umap.worker?worker&inline";

export function makeJsonWorker(): Worker {
  return new InlineJsonWorker();
}

export function makeLabeledExportWorker(): Worker {
  return new InlineLabeledExportWorker();
}

export function makeHdbscanWorker(): Worker {
  return new InlineHdbscanWorker();
}

export function makeSimplePreprocessWorker(): Worker {
  return new InlineSimplePreprocessWorker();
}

export function makeSplineWorker(): Worker {
  return new InlineSplineWorker();
}

export function makeMetricsWorker(): Worker {
  return new InlineMetricsWorker();
}

export function makeUmapWorker(): Worker {
  return new InlineUmapWorker();
}

export function makeFieldPreviewWorker(): Worker {
  return new InlineFieldPreviewWorker();
}

export function makeFieldDistanceWorker(): Worker {
  return new InlineFieldDistanceWorker();
}
