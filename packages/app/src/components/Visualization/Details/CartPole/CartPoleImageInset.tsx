/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the component by design; dev HMR full-reloads this file (CS 2026-07-09) */
import React, { useMemo } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

interface CartPoleImageInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
}

const WIDTH = 120;
const HEIGHT = 80;
const CART_WIDTH = 30;
const CART_HEIGHT = 15;
const POLE_LENGTH = 40;

// Reuse a single canvas/context/ImageData across renders.
const CANVAS = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  return canvas;
})();
let CTX: CanvasRenderingContext2D | null = null;
try {
  CTX = CANVAS.getContext("2d");
} catch {
  CTX = null;
}

// Cache per-sample state vector [x,v,theta,thetaDot]
const SAMPLE_STATE = new WeakMap<DataPoint, Float32Array>();

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
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
  }
}

const CLUSTER_IMG_CACHE = new LruMap<string, string>(256);

export function getSampleState(sample: DataPoint): Float32Array {
  const cached = SAMPLE_STATE.get(sample);
  if (cached) return cached;

  const out = new Float32Array(4);
  // obs0..obs3 live directly on the point (dynamic feature keys, see AGENTS.md).
  const rec = sample as unknown as Record<string, unknown>;
  const feat = sample.features;
  for (let i = 0; i < 4; i++) {
    const key = `obs${i}`;
    let v: unknown = rec[key];
    if (v === undefined && feat) v = feat[key];
    let num = 0;
    if (typeof v === "number") num = v;
    else if (typeof v === "string") {
      const parsed = v.length ? Number(v) : 0;
      num = Number.isFinite(parsed) ? parsed : 0;
    }
    out[i] = num;
  }
  SAMPLE_STATE.set(sample, out);
  return out;
}

export function averageCluster(samples: DataPoint[]): Float32Array {
  const acc = new Float32Array(4);
  const n = samples.length || 1;
  for (let s = 0; s < samples.length; s++) {
    const st = getSampleState(samples[s]);
    for (let i = 0; i < 4; i++) acc[i] += st[i];
  }
  for (let i = 0; i < 4; i++) acc[i] /= n;
  return acc;
}

function renderState(state: Float32Array): string {
  if (!CTX) return "data:image/png;base64,";
  const [x, _v, theta, _td] = state;
  CTX.clearRect(0, 0, WIDTH, HEIGHT);
  CTX.fillStyle = "white";
  CTX.fillRect(0, 0, WIDTH, HEIGHT);
  const trackY = HEIGHT * 0.75;
  CTX.strokeStyle = "black";
  CTX.lineWidth = 2;
  CTX.beginPath();
  CTX.moveTo(0, trackY);
  CTX.lineTo(WIDTH, trackY);
  CTX.stroke();

  const scaleX = (WIDTH / 2) / 2.4; // cart position range ~[-2.4,2.4]
  const cartX = WIDTH / 2 + x * scaleX;
  const cartY = trackY - CART_HEIGHT;
  CTX.fillStyle = "#888";
  CTX.fillRect(cartX - CART_WIDTH / 2, cartY, CART_WIDTH, CART_HEIGHT);

  const poleBaseX = cartX;
  const poleBaseY = cartY;
  const poleEndX = poleBaseX + POLE_LENGTH * Math.sin(theta);
  const poleEndY = poleBaseY - POLE_LENGTH * Math.cos(theta);
  CTX.strokeStyle = "#d00";
  CTX.lineWidth = 3;
  CTX.beginPath();
  CTX.moveTo(poleBaseX, poleBaseY);
  CTX.lineTo(poleEndX, poleEndY);
  CTX.stroke();

  return CANVAS.toDataURL("image/png");
}

function clusterKey(samples: DataPoint[]): string {
  if (samples.length === 0) return "k:empty";
  const ids = new Array<number>(samples.length);
  for (let i = 0; i < samples.length; i++) ids[i] = samples[i].id ?? (samples[i] as DataPoint & { uid?: number }).uid ?? i;
  ids.sort((a, b) => a - b);
  return `k:${ids.join(",")}`;
}

const CartPoleImageInset: React.FC<CartPoleImageInsetProps> = ({ clusterSamples, scaleFactor }) => {
  const key = useMemo(() => clusterKey(clusterSamples), [clusterSamples]);
  const dataUrl = useMemo(() => {
    const cached = CLUSTER_IMG_CACHE.get(key);
    if (cached) return cached;
    if (clusterSamples.length === 0) return null;
    let state: Float32Array;
    if (clusterSamples.length === 1) state = getSampleState(clusterSamples[0]);
    else state = averageCluster(clusterSamples);
    const url = renderState(state);
    CLUSTER_IMG_CACHE.set(key, url);
    return url;
  }, [key, clusterSamples]);

  return (
    <svg
      width={WIDTH * scaleFactor}
      height={HEIGHT * scaleFactor}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ overflow: "visible", pointerEvents: "none" }}
    >
      {dataUrl && (
        <image
          href={dataUrl}
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          style={{ imageRendering: "pixelated" }}
        />
      )}
    </svg>
  );
};

export default React.memo(CartPoleImageInset);
