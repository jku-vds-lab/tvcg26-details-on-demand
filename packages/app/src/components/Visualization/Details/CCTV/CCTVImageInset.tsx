import { CircularProgress } from "@mui/material";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getTypedGridPixels } from "src/dataPreprocessing/pixelGrid";
import BackendImageInset from "../BackendImageInset";
import { useBackendImageUrl } from "../imageBackend";
import { computeClusterAverageIdle } from "../imageDiffShared";

interface CCTVImageInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
  samplesSig: string;
}

// replaced single SIZE with WIDTH and HEIGHT
export const CCTV_IMAGE_WIDTH = 128;
export const CCTV_IMAGE_HEIGHT = 72;
const WIDTH = CCTV_IMAGE_WIDTH;
const HEIGHT = CCTV_IMAGE_HEIGHT;
const NUM_PIXELS = WIDTH * HEIGHT;

// CI-safe: typed arrays are not reliably generic across TS/DOM lib versions
type RgbaBuffer = Uint8ClampedArray;

// Precompute pixel keys once: "1x1" .. `${WIDTH}x${HEIGHT}`
const PIXEL_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (let r = 1; r <= HEIGHT; r++) {
    for (let c = 1; c <= WIDTH; c++) keys.push(`${c}x${r}`);
  }
  return keys;
})();

/** Per-sample pixel cache: DataPoint -> Float32Array[NUM_PIXELS] */
const SAMPLE_PIXELS = new WeakMap<DataPoint, Float32Array>();

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

const CLUSTER_IMG_CACHE = new LruMap<string, RgbaBuffer>(1024);

/** Sentinel for "no samples" — distinguishes empty from "still computing" (null). */
const EMPTY_RGBA = new Uint8ClampedArray(0) as RgbaBuffer;

// cache for single-sample renders to avoid thrashing the small LRU
const SINGLE_SAMPLE_IMG_CACHE = new WeakMap<DataPoint, RgbaBuffer>();

/** Precompute RGBA palette for grayscale [0..255] -> [r,g,b,255]. */
const PALETTE: RgbaBuffer = (() => {
  const p = new Uint8ClampedArray(256 * 4) as RgbaBuffer;
  for (let g = 0; g < 256; g++) {
    const o = g << 2;
    p[o] = g;
    p[o + 1] = g;
    p[o + 2] = g;
    p[o + 3] = 255;
  }
  return p;
})();

/** Extract pixels for one sample, cached. Prefers the typed `pixels` field
 * (worker-extracted, see pixelGrid.ts), falling back to direct props or the
 * `features` bag for legacy-loaded datasets. */
function getSamplePixels(sample: DataPoint): Float32Array {
  const cached = SAMPLE_PIXELS.get(sample);
  if (cached) return cached;

  const typed = getTypedGridPixels(sample, NUM_PIXELS);
  if (typed) {
    SAMPLE_PIXELS.set(sample, typed);
    return typed;
  }

  const out = new Float32Array(NUM_PIXELS);
  // Legacy pixel keys live directly on the point ("1x1".."WxH"), see AGENTS.md.
  const rec = sample as unknown as Record<string, unknown>;
  const feat = sample.features;

  for (let i = 0; i < NUM_PIXELS; i++) {
    const key = PIXEL_KEYS[i];
    let v: unknown = rec[key];
    if (v === undefined && feat) v = feat[key];

    let num = 0;
    if (typeof v === "number") num = v;
    else if (typeof v === "string") {
      const parsed = v.length ? Number(v) : 0;
      num = Number.isFinite(parsed) ? parsed : 0;
    } else if (v === true) num = 1;

    out[i] = num;
  }

  SAMPLE_PIXELS.set(sample, out);
  return out;
}

/** Render grayscale avg[0..1 or 0..255] into an RGBA buffer. */
function renderToRgba(avg: Float32Array, maxAvg: number): RgbaBuffer {
  const scale = maxAvg <= 1.0 ? 255 : 1;
  const rgba = new Uint8ClampedArray(NUM_PIXELS * 4) as RgbaBuffer;

  for (let i = 0; i < NUM_PIXELS; i++) {
    let g = avg[i] * scale;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    const gi = (g + 0.5) | 0;
    const po = gi << 2;
    const doff = i << 2;

    rgba[doff] = PALETTE[po];
    rgba[doff + 1] = PALETTE[po + 1];
    rgba[doff + 2] = PALETTE[po + 2];
    rgba[doff + 3] = 255;
  }

  return rgba;
}

/** Stable key for cluster image caching (ids only; order-independent). */
function clusterKey(samples: DataPoint[]): string {
  if (samples.length === 0) return "k:empty";
  const ids = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i++) {
    ids[i] = samples[i].id ?? (samples[i] as DataPoint & { uid?: number }).uid ?? i;
  }
  ids.sort((a, b) => a - b);
  return `k:${ids.join(",")}`;
}

const CCTVImageInset: React.FC<CCTVImageInsetProps> = ({
  clusterSamples,
  scaleFactor,
  samplesSig,
}) => {
  const key = useMemo(() => {
    if (samplesSig) return `sig:${samplesSig}`;
    return clusterKey(clusterSamples);
  }, [samplesSig, clusterSamples]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate identity stabilization: downstream re-runs only when the content key changes
  const stableSamples = useMemo(() => clusterSamples, [key]);

  // Server-side aggregation (issue #315): when an image backend is active the
  // mean image arrives as ONE PNG and the local pixel path below never runs.
  const backend = useBackendImageUrl(stableSamples);
  const backendActive = backend.kind !== "local";

  // Cache hits and single samples resolve synchronously (no spinner flash);
  // multi-sample averaging is idle-chunked so a burst of newly-activated
  // clusters during zoom never runs O(samples × 9216) in the React commit.
  const resolveSync = (): RgbaBuffer | null => {
    if (!key) return null;

    const cached = CLUSTER_IMG_CACHE.get(key);
    if (cached) return cached;

    if (stableSamples.length === 0) return EMPTY_RGBA;

    if (stableSamples.length === 1) {
      const sample = stableSamples[0];
      const singleCached = SINGLE_SAMPLE_IMG_CACHE.get(sample);
      if (singleCached) {
        CLUSTER_IMG_CACHE.set(key, singleCached);
        return singleCached;
      }

      const px = getSamplePixels(sample);
      let max = 0;
      for (let i = 0; i < NUM_PIXELS; i++) if (px[i] > max) max = px[i];

      const buffer = renderToRgba(px, max);
      SINGLE_SAMPLE_IMG_CACHE.set(sample, buffer);
      CLUSTER_IMG_CACHE.set(key, buffer);
      return buffer;
    }

    return null; // multi-sample cache miss → async path
  };

  const [rgba, setRgba] = useState<RgbaBuffer | null>(() =>
    backendActive ? null : resolveSync()
  );

  useEffect(() => {
    if (backendActive) return; // the backend PNG renders instead

    const sync = resolveSync();
    if (sync) {
      setRgba(sync);
      return;
    }

    let cancelled = false;
    setRgba(null); // spinner while the idle-chunked average runs
    void computeClusterAverageIdle(stableSamples, NUM_PIXELS, getSamplePixels, () => cancelled)
      .then((result) => {
        if (cancelled || !result) return;
        const buffer = renderToRgba(result.avg, result.maxAvg);
        CLUSTER_IMG_CACHE.set(key, buffer);
        setRgba(buffer);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backendActive]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageDataRef = useRef<ImageData | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    if (rgba && rgba.length) {
      if (typeof ImageData !== "undefined") {
        if (!imageDataRef.current) {
          imageDataRef.current = new ImageData(WIDTH, HEIGHT);
        }
        imageDataRef.current.data.set(rgba);
        ctx.putImageData(imageDataRef.current, 0, 0);
      }
    } else {
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
    }

    ctx.restore();
  }, [rgba]);

  if (backendActive) {
    return (
      <BackendImageInset
        url={backend.kind === "ready" ? backend.payload : null}
        width={WIDTH}
        height={HEIGHT}
        scaleFactor={scaleFactor}
      />
    );
  }

  const isComputing = rgba === null;
  return (
    <div
      style={{
        position: "relative",
        width: WIDTH * scaleFactor,
        height: HEIGHT * scaleFactor,
      }}
    >
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        style={{
          width: WIDTH * scaleFactor,
          height: HEIGHT * scaleFactor,
          imageRendering: "pixelated",
          pointerEvents: "none",
          opacity: isComputing ? 0 : 1,
        }}
      />
      {isComputing && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress size={16} />
        </div>
      )}
    </div>
  );
};

export default React.memo(
  CCTVImageInset,
  (a, b) =>
    a.samplesSig === b.samplesSig &&
    a.scaleFactor === b.scaleFactor &&
    a.clusterSamples.length === b.clusterSamples.length
);
