import { Delaunay } from "d3-delaunay";
import { useEffect, useRef } from "react";

/**
 * Debounce function: Delays execution of a function until after `wait` milliseconds
 * have elapsed since the last time it was invoked.
 *
 * @param func - The function to debounce
 * @param wait - The number of milliseconds to delay
 * @returns A debounced version of the function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;

  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Throttle function: Ensures a function is executed at most once every `limit` milliseconds.
 *
 * @param func - The function to throttle
 * @param limit - The time frame in milliseconds
 * @returns A throttled version of the function
 */
export function throttle<T extends (...args: unknown[]) => void>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Rotates an array by moving the first element to the last position.
 *
 * @param arr - The array to rotate
 * @returns A new array with elements rotated
 */
export function rotateArray<T>(arr: T[]): T[] {
  return arr.length > 0 ? arr.slice(1).concat(arr[0]) : arr;
}

/**
 * Converts a hex color string to an RGB object.
 *
 * @param hex - The hex color string (e.g., "#ff5733" or "ff5733")
 * @returns An object containing r, g, and b values (0-255), or `null` if invalid
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalizedHex = hex.startsWith("#") ? hex.slice(1) : hex;
  const match = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalizedHex);

  return match
    ? {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16),
      }
    : null;
}
// Helper: Compute median nearest-neighbor distance.
export function computeMedianNN(points: { x: number; y: number }[]): number {
  const n = points.length;
  if (n < 2) return 0;

  // Optional downsampling for very large n; median is robust.
  const MAX = 50000;
  const sample =
    n > MAX ? reservoirSample(points, MAX) : points;

  // Build Delaunay on sampled points
  const delaunay = Delaunay.from(sample, p => p.x, p => p.y);

  // For each point, find the nearest neighbor among Delaunay neighbors
  const dists: number[] = new Array(sample.length);
  for (let i = 0; i < sample.length; i++) {
    let min = Infinity;
    for (const j of delaunay.neighbors(i)) {
      const dx = sample[i].x - sample[j].x;
      const dy = sample[i].y - sample[j].y;
      const d = Math.hypot(dx, dy);
      if (d < min) min = d;
    }
    dists[i] = min;
  }

  // Many datasets have exact duplicates; guard against zeros dominating the median
  const nonZero = dists.filter(d => d > 0);
  const arr = nonZero.length >= Math.ceil(dists.length * 0.5) ? nonZero : dists;

  arr.sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function reservoirSample<T>(arr: T[], k: number): T[] {
  const res = arr.slice(0, k);
  for (let i = k; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) res[j] = arr[i];
  }
  return res;
}
// Generic groupBy function.
export const groupBy = <T, K extends string | number>(
  array: T[],
  keyFn: (item: T) => K
): Record<K, T[]> => array.reduce((acc, item) => {
  const key = keyFn(item);
  if (!acc[key]) {
    acc[key] = [];
  }
  acc[key].push(item);
  return acc;
}, {} as Record<K, T[]>);
// Debug hook for logging dependency changes
export function useWhyDidYouUpdate(name: string, props: Record<string, unknown>) {
  const prevProps = useRef<Record<string, unknown>>({});
  useEffect(() => {
    const allKeys = Object.keys({ ...prevProps.current, ...props });
    const changes: Record<string, { from: unknown; to: unknown; }> = {};
    for (const key of allKeys) {
      if (prevProps.current[key] !== props[key]) {
        changes[key] = {
          from: prevProps.current[key],
          to: props[key]
        };
      }
    }
    if (Object.keys(changes).length > 0) {
      console.log(`[${name}] dependency changes:`, changes);
    }
    prevProps.current = props;
  });
}
