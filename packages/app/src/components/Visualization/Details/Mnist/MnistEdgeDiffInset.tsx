// src/components/Visualization/Details/Mnist/MnistEdgeDiffInset.tsx
import { CircularProgress } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import BackendImageInset from "../BackendImageInset";
import { useBackendImageDiffUrl } from "../imageBackend";
import { computeImageDiffIdle } from "../imageDiffShared";
import { getSamplePixels, imagePixelUnit, type ImageShape } from "./imageGrid";

interface MnistEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples: DataPoint[];
  scaleFactor: number;
  /** Stable memo key, e.g. `${startSig}::${endSig}` (order-sensitive). */
  samplesSig: string;
  /** Grid to read and draw (mnist: 28×28; "image": the dataset metadata). */
  shape: ImageShape;
}

/** Very small LRU cache for rendered diff images. */
class LruMap<K, V> {
  private map = new Map<K, V>();
  constructor(private capacity: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.capacity) {
      const iter  = this.map.keys();
      const first = iter.next();
      if (!first.done) this.map.delete(first.value);
    }
  }
}

const EDGE_DIFF_IMG_CACHE = new LruMap<string, Uint8ClampedArray>(256);

const MnistEdgeDiffInset: React.FC<MnistEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  samplesSig,
  shape,
}) => {
  const { rows, cols } = shape;
  const numPixels = rows * cols;
  // Server-side aggregation (issue #315): when an image backend is active the
  // A/B diff arrives as ONE PNG and the local pixel path below never runs.
  const backend = useBackendImageDiffUrl(startSamples, endSamples);
  const backendActive = backend.kind !== "local";

  // Synchronous cache hit → no spinner on first render; cache miss → null → spinner.
  const [rgba, setRgba] = useState<Uint8ClampedArray | null>(
    () => (backendActive ? null : (EDGE_DIFF_IMG_CACHE.get(`diff:${rows}x${cols}:${samplesSig}`) ?? null))
  );

  useEffect(() => {
    if (backendActive) return; // the backend PNG renders instead

    const key = `diff:${rows}x${cols}:${samplesSig}`;
    const hit = EDGE_DIFF_IMG_CACHE.get(key);
    if (hit) { setRgba(hit); return; }
    if (!startSamples.length && !endSamples.length) { setRgba(new Uint8ClampedArray(0)); return; }

    let cancelled = false;
    setRgba(null); // show spinner while computing
    computeImageDiffIdle(
      startSamples,
      endSamples,
      numPixels,
      (s) => getSamplePixels(s, shape),
      () => cancelled
    ).then((buf) => {
      if (cancelled) return;
      EDGE_DIFF_IMG_CACHE.set(key, buf);
      setRgba(buf);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samplesSig, startSamples.length, endSamples.length, backendActive, rows, cols]);

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
        ctx.putImageData(new ImageData(rgba, cols, rows), 0, 0);
      }
    } else {
      ctx.clearRect(0, 0, cols, rows);
    }
    ctx.restore();
  }, [rgba, rows, cols]);

  // See MnistImageInset: whole CSS px per image pixel, drawn nearest-neighbour.
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

  const isComputing = rgba === null;
  return (
    <div
      style={{
        position: "relative",
        width: cols * unit,
        height: rows * unit,
      }}
    >
      <canvas
        ref={canvasRef}
        width={cols}
        height={rows}
        style={{
          width: cols * unit,
          height: rows * unit,
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
  MnistEdgeDiffInset,
  (a, b) =>
    a.samplesSig === b.samplesSig &&
    a.scaleFactor === b.scaleFactor &&
    a.shape.rows === b.shape.rows &&
    a.shape.cols === b.shape.cols
);
