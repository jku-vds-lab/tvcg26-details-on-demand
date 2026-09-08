import { CircularProgress } from "@mui/material";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { GYM_INSET_SIZE } from "./GymRenderInset";
import { decodeUrlToRgba, diffRgbaFromImages, diffRgbaFromPresence } from "./gymDiff";
import { extractRenderPoints } from "./gymPoints";
import {
  ClusterSummary,
  getCachedClusterSummary,
  requestClusterSummary,
} from "./renderServiceClient";

interface GymEdgeDiffInsetProps {
  startSamples: DataPoint[];
  endSamples: DataPoint[];
  scaleFactor: number;
  /** Order-sensitive signature of the start side. */
  startSig: string;
  /** Order-sensitive signature of the end side. */
  endSig: string;
}

/** Small LRU for computed diff buffers (mirrors CCTVEdgeDiffInset's cache). */
const DIFF_CACHE = new Map<string, Uint8ClampedArray>();
const DIFF_CACHE_CAPACITY = 256;

function diffCacheGet(key: string): Uint8ClampedArray | undefined {
  const hit = DIFF_CACHE.get(key);
  if (hit) {
    DIFF_CACHE.delete(key);
    DIFF_CACHE.set(key, hit);
  }
  return hit;
}

function diffCacheSet(key: string, value: Uint8ClampedArray): void {
  if (DIFF_CACHE.has(key)) DIFF_CACHE.delete(key);
  DIFF_CACHE.set(key, value);
  if (DIFF_CACHE.size > DIFF_CACHE_CAPACITY) {
    const oldest = DIFF_CACHE.keys().next();
    if (!oldest.done) DIFF_CACHE.delete(oldest.value);
  }
}

type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; rgba: Uint8ClampedArray }
  | { kind: "unavailable" };

/** Resolve one side's summary: cache first, else a client request. Mean keys
 * match GymRenderInset's, so a node inset for the same cluster shares the
 * LRU entry (no extra render-service round trip). */
function resolveSummary(
  sig: string,
  samples: DataPoint[],
  agg: "mean" | "presence",
  cancels: (() => void)[]
): Promise<ClusterSummary> {
  const key = `gym:${sig}|${agg}|${GYM_INSET_SIZE}`;
  const cached = getCachedClusterSummary(key);
  if (cached) return Promise.resolve(cached);
  const handle = requestClusterSummary(key, {
    points: extractRenderPoints(samples),
    agg,
    size: GYM_INSET_SIZE,
  });
  cancels.push(handle.cancel);
  return handle.promise;
}

/** Edge inset: per-pixel diverging diff (end − start) of the two clusters'
 * mean-rendered summary images, on the shared CCTV/MNIST blue-orange palette.
 * Async model follows GymRenderInset: spinner while pending, dashed offline
 * fallback when the render service is unreachable. */
const GymEdgeDiffInset: React.FC<GymEdgeDiffInsetProps> = ({
  startSamples,
  endSamples,
  scaleFactor,
  startSig,
  endSig,
}) => {
  const diffKey = `gymdiff:${startSig}::${endSig}|${GYM_INSET_SIZE}`;

  const [state, setState] = useState<DiffState>(() => {
    const cached = diffCacheGet(diffKey);
    return cached ? { kind: "ready", rgba: cached } : { kind: "loading" };
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sides = useMemo(() => ({ startSamples, endSamples }), [diffKey]);

  useEffect(() => {
    const cached = diffCacheGet(diffKey);
    if (cached) {
      setState({ kind: "ready", rgba: cached });
      return;
    }
    if (sides.startSamples.length === 0 || sides.endSamples.length === 0) {
      setState({ kind: "unavailable" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });
    const cancels: (() => void)[] = [];

    const diffVia = async (agg: "mean" | "presence") => {
      const [startSummary, endSummary] = await Promise.all([
        resolveSummary(startSig, sides.startSamples, agg, cancels),
        resolveSummary(endSig, sides.endSamples, agg, cancels),
      ]);
      const [startRgba, endRgba] = await Promise.all([
        decodeUrlToRgba(startSummary.url, GYM_INSET_SIZE),
        decodeUrlToRgba(endSummary.url, GYM_INSET_SIZE),
      ]);
      return agg === "presence"
        ? diffRgbaFromPresence(startRgba, endRgba)
        : diffRgbaFromImages(startRgba, endRgba);
    };

    // Prefer the server-side presence maps (true per-pixel occupancy vs the
    // dataset-median background); an older render server rejects the agg
    // with a 400 → fall back to diffing the mean images client-side.
    // TypeError = service unreachable, no point retrying with mean.
    diffVia("presence")
      .catch((err: unknown) => {
        if (
          cancelled ||
          (err instanceof DOMException && err.name === "AbortError") ||
          err instanceof TypeError
        ) {
          throw err;
        }
        return diffVia("mean");
      })
      .then((rgba) => {
        if (cancelled) return;
        diffCacheSet(diffKey, rgba);
        setState({ kind: "ready", rgba });
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setState({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
      cancels.forEach((cancel) => cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffKey]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (state.kind !== "ready" || state.rgba.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(state.rgba, GYM_INSET_SIZE, GYM_INSET_SIZE), 0, 0);
  }, [state]);

  const side = GYM_INSET_SIZE * scaleFactor;
  return (
    <div
      style={{
        position: "relative",
        width: side,
        height: side,
        pointerEvents: "none",
      }}
    >
      {state.kind === "ready" && (
        <canvas
          ref={canvasRef}
          width={GYM_INSET_SIZE}
          height={GYM_INSET_SIZE}
          style={{ width: side, height: side }}
        />
      )}
      {state.kind === "loading" && (
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
      {state.kind === "unavailable" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px dashed rgba(128,128,128,0.8)",
            borderRadius: 4,
            fontSize: 10,
            color: "rgba(128,128,128,0.9)",
            textAlign: "center",
            padding: 4,
          }}
        >
          render service offline
        </div>
      )}
    </div>
  );
};

export default React.memo(
  GymEdgeDiffInset,
  (a, b) =>
    a.startSig === b.startSig &&
    a.endSig === b.endSig &&
    a.scaleFactor === b.scaleFactor
);
