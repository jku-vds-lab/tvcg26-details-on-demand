import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import App from "./App";
import { AppProviders } from "./AppProviders";
import { parseImageShape } from "./components/Visualization/Details/Mnist/imageGrid";
import { DataPoint } from "./dataPreprocessing/dataPreprocessing";
import type { SimpleColumnMapping } from "./dataPreprocessing/simpleDataset";
import type { SimpleDatasetInput } from "./hooks/useInitialDataset";
import { makeBootTargetChangeHandler, resolveBootTarget } from "./landing/bootTarget";
import LandingPage from "./landing/LandingPage";
import store from "./store";
import { registerDataCacheWorker } from "./utils/dataCacheWorker";

interface AppProps {
  data: DataPoint[];
  knnGraph: number[][];
  simpleDatasetInput?: SimpleDatasetInput;
  embedded?: boolean;
}

function mountReactApp(el: HTMLElement, props: AppProps) {
  ReactDOM.createRoot(el).render(
    <React.StrictMode>
      <Provider store={store}>
        <AppProviders>
          <App {...props} />
        </AppProviders>
      </Provider>
    </React.StrictMode>
  );
}

// Web build only (never runs in Jupyter — there is no #root there): mount the
// landing page for `#/`-prefixed hashes, the tool for everything else (empty
// hash and `#v=1&…` deep links). Crossing that boundary needs a full reload so
// the other side boots; same-target hash changes (the tool rewriting its own
// deep link) never reload. See landing/bootTarget.ts.
const maybeRoot = document.getElementById("root");
if (maybeRoot) {
  // Deployed web builds only (the guard skips localhost and the widget never
  // reaches this block): cache dataset fetches across visits — GitHub Pages'
  // 10-minute max-age otherwise re-downloads ~9 MB per session.
  registerDataCacheWorker(import.meta.env.BASE_URL);
  if (resolveBootTarget(window.location.hash) === "landing") {
    ReactDOM.createRoot(maybeRoot).render(
      <React.StrictMode>
        <LandingPage />
      </React.StrictMode>
    );
  } else {
    mountReactApp(maybeRoot, { data: [], knnGraph: [] });
  }
  const onHashFlip = makeBootTargetChangeHandler(window.location.hash, () =>
    window.location.reload()
  );
  window.addEventListener("hashchange", () => onHashFlip(window.location.hash));
}

/**
 * Interface for the AnyWidget model. The model is expected to have a generic
 * getter function that returns the value for a given key.
 */
interface AnyWidgetModel {
  get<T>(key: string): T;
}

/**
 * The shape that AnyWidget expects: a model with a generic get method and an HTMLElement.
 */
interface AnyWidgetParams {
  model: AnyWidgetModel;
  el: HTMLElement;
}

const WIDGET_DEFAULT_HEIGHT_PX = 640;

export default {
  render: ({ model, el }: AnyWidgetParams) => {
    el.innerHTML = "";
    // The app fills its host; give the notebook cell a sensible height.
    if (!el.style.height) el.style.height = `${WIDGET_DEFAULT_HEIGHT_PX}px`;

    // The app pans on right-drag (ZoomBehavior filters on button === 2);
    // keep JupyterLab's document-level context menu out of the widget.
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Simple-format input from Python (see packages/widget/detailviews/__init__.py): rows of
    // records + optional column mapping + dataset type (+ the pixel grid of
    // the "image" type). The in-app pipeline (dataPreprocessing/simpleDataset.ts)
    // computes kNN, splines, and clustering from it.
    const rows = model.get<Record<string, unknown>[]>("data") ?? [];
    const mapping = model.get<Partial<SimpleColumnMapping>>("columnMapping") ?? {};
    const datasetType = model.get<string>("datasetType") || "default";
    const imageShape = parseImageShape(model.get<unknown>("imageShape"));

    mountReactApp(el, {
      data: [],
      knnGraph: [],
      simpleDatasetInput: rows.length > 0 ? { rows, mapping, datasetType, imageShape } : undefined,
      embedded: true,
    });
  },
};
