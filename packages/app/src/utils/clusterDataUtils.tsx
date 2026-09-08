
import type { BaseInsetRenderer } from "../components/Visualization/Details/BaseInsetRenderer";
import { CartPoleDatasetRenderer } from "../components/Visualization/Details/CartPole/CartPoleDatasetRenderer";
import { CCTVDatasetRenderer } from "../components/Visualization/Details/CCTV/CCTVDatasetRenderer";
import { ChessDatasetRenderer } from "../components/Visualization/Details/Chess/ChessDatasetRenderer";
import { DefaultDatasetRenderer } from "../components/Visualization/Details/DefaultDatasetRenderer";
import { GymDatasetRenderer } from "../components/Visualization/Details/Gym/GymDatasetRenderer";
import { MnistDatasetRenderer } from "../components/Visualization/Details/Mnist/MnistDatasetRenderer";
import { RubiksDatasetRenderer } from "../components/Visualization/Details/Rubiks/RubiksDatasetRenderer";
import store, { RootState, updateClusterSettings } from "../store";

/**
 * Returns the appropriate renderer instance based on the dataset type.
 */
export function instantiateRenderer(datasetType: string): BaseInsetRenderer {
  let renderer: BaseInsetRenderer;
  switch (datasetType) {
    case "rubik":
      renderer = new RubiksDatasetRenderer();
      break;
    case "chess":
      renderer = new ChessDatasetRenderer();
      break;
    case "mnist":
      renderer = new MnistDatasetRenderer();
      break;
    case "image":
      // Generic pixel-grid insets (widget `image_shape`): the MNIST path with
      // the grid from the dataset metadata and the standard label column.
      renderer = new MnistDatasetRenderer("label");
      break;
    case "cctv":
      renderer = new CCTVDatasetRenderer();
      break;
    case "cartpole":
      renderer = new CartPoleDatasetRenderer();
      break;
    case "gymnasium":
      renderer = new GymDatasetRenderer();
      break;
    default:
      renderer = new DefaultDatasetRenderer();
  }

  return renderer;
}

/**
 * Instantiate the renderer and apply its default scale bounds
 * to the visualization settings. The defaults are dispatched
 * only once per invocation.
 */
let lastAppliedDefaults: {
  datasetType: string;
  bounds: { insetMinScale: number; insetMaxScale: number };
} | null = null;

export function applyRendererDefaults(datasetType: string): {
  renderer: BaseInsetRenderer;
  defaults?: { insetMinScale: number; insetMaxScale: number };
} {
  const renderer = instantiateRenderer(datasetType);
  const defaults = (renderer.constructor as { defaultScaleBounds?: { insetMinScale: number; insetMaxScale: number } })
    .defaultScaleBounds;
  if (defaults) {
    const current = (store.getState() as RootState).clusterSettings;
    const lastApplied = lastAppliedDefaults;
    const scalesMatchLast =
      lastApplied &&
      current.insetMinScale === lastApplied.bounds.insetMinScale &&
      current.insetMaxScale === lastApplied.bounds.insetMaxScale;

    if (!lastApplied || (datasetType !== lastApplied.datasetType && scalesMatchLast)) {
      store.dispatch(updateClusterSettings(defaults));
      lastAppliedDefaults = { datasetType, bounds: defaults };
    } else if (!scalesMatchLast) {
      // user changed settings, just update the remembered dataset
      lastAppliedDefaults = { datasetType, bounds: defaults };
    }
  }
  return { renderer, defaults };
}
