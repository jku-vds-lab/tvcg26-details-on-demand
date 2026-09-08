import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import store from "../store";

function readPointValue(point: DataPoint, key: string): unknown {
  if (!key) return undefined;
  const recordPoint = point as unknown as Record<string, unknown>;
  if (key in recordPoint && recordPoint[key] !== undefined) {
    return recordPoint[key];
  }
  if (point.features && key in point.features) {
    return point.features[key];
  }
  return undefined;
}

export function getColorEncodingKey(point: DataPoint, encoding?: string): string | number | null {
  const key = encoding ?? store.getState().visualizationSettings.colorEncoding;
  if (!key) return null;

  const value = readPointValue(point, key);
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return null;
}
