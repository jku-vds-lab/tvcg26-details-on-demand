// src/components/Visualization/Details/CCTVEdgeDiffInset.tsx
import { CircularProgress } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getTypedGridPixels } from "src/dataPreprocessing/pixelGrid";
import BackendImageInset from "../BackendImageInset";
import { useBackendImageDiffUrl } from "../imageBackend";
import { computeImageDiffIdle } from "../imageDiffShared";

interface CCTVEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples: DataPoint[];
  scaleFactor: number;
  // Stable key, e.g., `${startSig}::${endSig}` (order-sensitive)
  samplesSig: string;
}

// Match CCTVImageInset resolution
const WIDTH = 128;
const HEIGHT = 72;
const NUM_PIXELS = WIDTH * HEIGHT;

// Precompute pixel keys once: "1x1" .. "WIDTHxHEIGHT"
const PIXEL_KEYS: string[] = (() => {
  const keys: string[] = [];
  for (let r = 1; r <= HEIGHT; r++) {
    for (let c = 1; c <= WIDTH; c++) {
      keys.push(`${c}x${r}`);
    }
  }
  return keys;
})();

/** Per-sample pixel cache: DataPoint -> Float32Array[NUM_PIXELS] */
const SAMPLE_PIXELS = new WeakMap<DataPoint, Float32Array>();

/** Very small LRU cache for rendered edge-diff images (premultiplied RGBA). */
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
      if (!first.done) this.map.delete(first.value);
    }
  }
}

const EDGE_DIFF_IMG_CACHE = new LruMap<string, Uint8ClampedArray>(256);

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

    // Prefer direct property, then features map.
    let v: unknown = rec[key];
    if (v === undefined && feat) v = feat[key];

    let num = 0;
    if (typeof v === "number") num = v;
    else if (typeof v === "string") {
      const parsed = v.length ? Number(v) : 0;
      num = Number.isFinite(parsed) ? parsed : 0;
    } else if (v === true) {
      num = 1;
    }

    out[i] = num;
  }

  SAMPLE_PIXELS.set(sample, out);
  return out;
}

const CCTVEdgeDiffInset: React.FC<CCTVEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  samplesSig,
}) => {
  // Server-side aggregation (issue #315): when an image backend is active the
  // A/B diff arrives as ONE PNG and the local pixel path below never runs.
  const backend = useBackendImageDiffUrl(startSamples, endSamples);
  const backendActive = backend.kind !== "local";

  // Synchronous cache hit → no spinner on first render; cache miss → null → spinner.
  const [rgba, setRgba] = useState<Uint8ClampedArray | null>(
    () => (backendActive ? null : (EDGE_DIFF_IMG_CACHE.get(`diff:${samplesSig}`) ?? null))
  );

  useEffect(() => {
    if (backendActive) return; // the backend PNG renders instead

    const key = `diff:${samplesSig}`;
    const hit = EDGE_DIFF_IMG_CACHE.get(key);
    if (hit) { setRgba(hit); return; }
    if (!startSamples.length && !endSamples.length) { setRgba(new Uint8ClampedArray(0)); return; }

    let cancelled = false;
    setRgba(null); // show spinner while computing
    computeImageDiffIdle(startSamples, endSamples, NUM_PIXELS, getSamplePixels, () => cancelled)
      .then((buf) => {
        if (cancelled) return;
        EDGE_DIFF_IMG_CACHE.set(key, buf);
        setRgba(buf);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samplesSig, startSamples.length, endSamples.length, backendActive]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (rgba && rgba.length) {
      if (typeof ImageData !== "undefined") {
        ctx.putImageData(new ImageData(rgba, WIDTH, HEIGHT), 0, 0);
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
  CCTVEdgeDiffInset,
  (a, b) => a.samplesSig === b.samplesSig && a.scaleFactor === b.scaleFactor
);
