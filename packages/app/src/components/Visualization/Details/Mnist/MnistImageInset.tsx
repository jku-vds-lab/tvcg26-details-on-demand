import React, { useEffect, useMemo, useRef } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendImageInset from "../BackendImageInset";
import { useBackendImageUrl } from "../imageBackend";
import { getSamplePixels, imagePixelUnit, type ImageShape } from "./imageGrid";

interface MnistImageInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
  samplesSig?: string;
  /** Grid to read and draw (mnist: 28×28; "image": the dataset metadata). */
  shape: ImageShape;
}

/** Very small LRU cache for rendered cluster images (premultiplied RGBA). */
class LruMap<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}

  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.capacity) {
      const iter = this.map.keys();
      const first = iter.next();
      if (!first.done) {
        this.map.delete(first.value);
      }
    }
  }
}

const CLUSTER_IMG_CACHE = new LruMap<string, PixelBuffer>(1024);

// cache for single-sample renders to avoid thrashing the small LRU
const SINGLE_SAMPLE_IMG_CACHE = new WeakMap<DataPoint, PixelBuffer>();

/** Precompute RGBA palette for grayscale [0..255] -> [r,g,b,255]. */
const PALETTE = (() => {
  const p = new Uint8ClampedArray(256 * 4);
  for (let g = 0; g < 256; g++) {
    const o = g << 2;
    p[o] = g;
    p[o + 1] = g;
    p[o + 2] = g;
    p[o + 3] = 255;
  }
  return p;
})();

/** Average pixels across samples; returns [avg, maxAvg]. */
function averageCluster(samples: DataPoint[], shape: ImageShape): { avg: Float32Array; maxAvg: number } {
  const numPixels = shape.rows * shape.cols;
  const n = samples.length || 1;
  const acc = new Float32Array(numPixels);

  // Sum
  for (let s = 0; s < samples.length; s++) {
    const px = getSamplePixels(samples[s], shape);
    for (let i = 0; i < numPixels; i++) acc[i] += px[i];
  }

  // Divide and track max
  let maxAvg = 0;
  for (let i = 0; i < numPixels; i++) {
    const v = acc[i] / n;
    acc[i] = v;
    if (v > maxAvg) maxAvg = v;
  }

  return { avg: acc, maxAvg };
}

/** Render grayscale avg[0..1 or 0..255] into an RGBA buffer. */
function renderToRgba(avg: Float32Array, maxAvg: number) {
  const numPixels = avg.length;
  const scale = maxAvg <= 1.0 ? 255 : 1;
  const rgba = new Uint8ClampedArray(numPixels * 4);

  for (let i = 0; i < numPixels; i++) {
    let g = avg[i] * scale;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    const gi = (g + 0.5) | 0; // round
    const po = gi << 2;
    const doff = i << 2;
    rgba[doff] = PALETTE[po];
    rgba[doff + 1] = PALETTE[po + 1];
    rgba[doff + 2] = PALETTE[po + 2];
    rgba[doff + 3] = 255;
  }

  return rgba;
}

/** Inferred from `renderToRgba`; resolves to `Uint8ClampedArray<ArrayBuffer>` on TS ≥ 5.2
 *  and plain `Uint8ClampedArray` on older builds — avoids the TS2315 generic error. */
type PixelBuffer = ReturnType<typeof renderToRgba>;

/** Stable key for cluster image caching (ids only; order-independent). */
function clusterKey(samples: DataPoint[]): string {
  if (samples.length === 0) return "k:empty";
  // Copy ids into array and sort numeric ascending; avoid creating big strings for each render by reusing join.
  const ids = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i++) ids[i] = samples[i].id ?? (samples[i] as DataPoint & { uid?: number }).uid ?? i;
  ids.sort((a, b) => a - b);
  return `k:${ids.join(",")}`;
}

const MnistImageInset: React.FC<MnistImageInsetProps> = ({
  clusterSamples,
  scaleFactor,
  samplesSig,
  shape,
}) => {
  const { rows, cols } = shape;
  const numPixels = rows * cols;
  // The grid is part of the key: ids repeat across datasets of different shapes.
  const key = useMemo(() => {
    const grid = `${rows}x${cols}`;
    if (samplesSig) return `sig:${grid}:${samplesSig}`;
    return `${grid}:${clusterKey(clusterSamples)}`;
  }, [samplesSig, clusterSamples, rows, cols]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate identity stabilization: downstream re-runs only when the content key changes
  const stableSamples = useMemo(() => clusterSamples, [key]);

  // Server-side aggregation (issue #315): when an image backend is active the
  // mean image arrives as ONE PNG and the local pixel path below never runs.
  const backend = useBackendImageUrl(stableSamples);
  const backendActive = backend.kind !== "local";

  const rgba = useMemo(() => {
    if (backendActive) return null; // the backend PNG renders instead
    if (!key) return null;

    const cached = CLUSTER_IMG_CACHE.get(key);
    if (cached) return cached;

    if (stableSamples.length === 0) return null;

    // Fast path: single sample
    if (stableSamples.length === 1) {
      const sample = stableSamples[0];
      const singleCached = SINGLE_SAMPLE_IMG_CACHE.get(sample);
      if (singleCached && singleCached.length === numPixels * 4) {
        CLUSTER_IMG_CACHE.set(key, singleCached);
        return singleCached;
      }

      const px = getSamplePixels(sample, shape);
      let max = 0;
      for (let i = 0; i < numPixels; i++) if (px[i] > max) max = px[i];
      const buffer = renderToRgba(px, max);
      SINGLE_SAMPLE_IMG_CACHE.set(sample, buffer);
      CLUSTER_IMG_CACHE.set(key, buffer);
      return buffer;
    }

    // Average and render
    const { avg, maxAvg } = averageCluster(stableSamples, shape);
    const buffer = renderToRgba(avg, maxAvg);
    CLUSTER_IMG_CACHE.set(key, buffer);
    return buffer;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shape` is covered by `key`
  }, [key, stableSamples, backendActive, numPixels]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (rgba) {
      if (typeof ImageData !== "undefined") {
        const imageData = new ImageData(rgba, cols, rows);
        ctx.putImageData(imageData, 0, 0);
      }
    } else {
      ctx.clearRect(0, 0, cols, rows);
    }
    ctx.restore();
  }, [rgba, rows, cols]);

  // The canvas is the grid itself; CSS scales it up with `pixelated` (nearest
  // neighbour), whole pixels per image pixel so small grids stay crisp.
  const unit = imagePixelUnit(shape) * scaleFactor;

  if (backendActive) {
    return (
      <BackendImageInset
        url={backend.kind === "ready" ? backend.payload : null}
        width={cols}
        height={rows}
        scaleFactor={unit}
      />
    );
  }

  return (
    <canvas
      ref={canvasRef}
      width={cols}
      height={rows}
      style={{
        width: cols * unit,
        height: rows * unit,
        imageRendering: "pixelated",
        pointerEvents: "none",
      }}
    />
  );
};

export default React.memo(
  MnistImageInset,
  (a, b) =>
    a.samplesSig === b.samplesSig &&
    a.scaleFactor === b.scaleFactor &&
    a.clusterSamples.length === b.clusterSamples.length &&
    a.shape.rows === b.shape.rows &&
    a.shape.cols === b.shape.cols
);
