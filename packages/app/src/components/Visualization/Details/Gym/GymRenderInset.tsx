import { CircularProgress } from "@mui/material";
import React, { useEffect, useMemo, useState } from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { extractRenderPoints } from "./gymPoints";
import {
  ClusterSummary,
  getCachedClusterSummary,
  requestClusterSummary,
} from "./renderServiceClient";

export const GYM_INSET_SIZE = 96;

interface GymRenderInsetProps {
  clusterSamples: DataPoint[];
  scaleFactor: number;
  samplesSig: string;
}

type InsetState =
  | { kind: "loading" }
  | { kind: "ready"; summary: ClusterSummary }
  | { kind: "unavailable" };

/** Cluster inset whose image is rendered on demand by the local Python
 * render service (env.render() of the recorded states, averaged server-side).
 * Async model follows CCTVImageInset: sync cache path, spinner while pending,
 * graceful fallback when the service is unreachable. */
const GymRenderInset: React.FC<GymRenderInsetProps> = ({
  clusterSamples,
  scaleFactor,
  samplesSig,
}) => {
  const key = `gym:${samplesSig}|mean|${GYM_INSET_SIZE}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const points = useMemo(() => extractRenderPoints(clusterSamples), [key]);

  const [state, setState] = useState<InsetState>(() => {
    const cached = getCachedClusterSummary(key);
    return cached ? { kind: "ready", summary: cached } : { kind: "loading" };
  });

  useEffect(() => {
    const cached = getCachedClusterSummary(key);
    if (cached) {
      setState({ kind: "ready", summary: cached });
      return;
    }
    if (points.length === 0) {
      setState({ kind: "unavailable" });
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });
    const handle = requestClusterSummary(key, { points, size: GYM_INSET_SIZE });
    handle.promise
      .then((summary) => {
        if (!cancelled) setState({ kind: "ready", summary });
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
        setState({ kind: "unavailable" });
      });
    return () => {
      cancelled = true;
      handle.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

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
        <img
          src={state.summary.url}
          alt=""
          draggable={false}
          style={{
            width: side,
            height: side,
            objectFit: "contain",
            background: "#000",
          }}
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
  GymRenderInset,
  (a, b) =>
    a.samplesSig === b.samplesSig &&
    a.scaleFactor === b.scaleFactor &&
    a.clusterSamples.length === b.clusterSamples.length
);
