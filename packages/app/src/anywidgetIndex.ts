import render from "./App";
import type { DataPoint } from "./dataPreprocessing/dataPreprocessing";

interface AnyWidgetModel {
  get<T>(key: string): T;
}

interface AnyWidgetParams {
  model: AnyWidgetModel;
  el: HTMLElement;
}

export function renderWidget(params: AnyWidgetParams) {
  const { model, el } = params;
  // Extract and type the properties expected by App
  const data = model.get<DataPoint[]>("data");
  // const width = model.get<number>("width") || 700;
  // const height = model.get<number>("height") || 700;
  const knnGraph = model.get<number[][]>("knnGraph") || [];
  // Clear the container element before mounting
  el.innerHTML = "";
  render({ data, knnGraph });
}
