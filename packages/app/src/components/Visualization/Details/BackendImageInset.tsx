// packages/app/src/components/Visualization/Details/BackendImageInset.tsx
//
// Presentational shell for server-aggregated image insets (issue #315,
// phase 3): shows the object-URL PNG the image backend resolved, or a
// spinner while it is pending. Used by the CCTV/MNIST node and edge-diff
// insets when a `backend: { kind: "image" }` provider is active; the local
// canvas path stays in the individual insets.

import { CircularProgress } from "@mui/material";
import React from "react";

export function BackendImageInset({
  url,
  width,
  height,
  scaleFactor,
}: {
  /** Resolved object URL, or null while the request is pending. */
  url: string | null;
  width: number;
  height: number;
  scaleFactor: number;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: width * scaleFactor,
        height: height * scaleFactor,
        pointerEvents: "none",
      }}
    >
      {url !== null ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            width: width * scaleFactor,
            height: height * scaleFactor,
            imageRendering: "pixelated",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div
          data-testid="backend-image-loading"
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
}

export default React.memo(BackendImageInset);
