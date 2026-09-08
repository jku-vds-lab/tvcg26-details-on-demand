import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

/**
 * Safely extracts the annotation value from a DataPoint for a given column.
 * The function casts the DataPoint to any so that arbitrary feature keys can be accessed.
 * Returns the value as a string, or an empty string if undefined.
 */
export function getFeatureValue(point: DataPoint, column: string): string {
    if (column in point) {
      return String(point[column as keyof DataPoint] ?? '');
    }
    return '';
  }