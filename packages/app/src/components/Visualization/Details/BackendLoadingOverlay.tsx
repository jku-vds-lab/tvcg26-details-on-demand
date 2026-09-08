// packages/app/src/components/Visualization/Details/BackendLoadingOverlay.tsx
//
// Centered spinner overlay for insets whose backend payload is in flight
// (issue #315). The board insets render a meaningful placeholder while
// loading (chess: the bare board; rubiks: a transparent canvas) — this
// overlay makes explicit that the placeholder is "not loaded yet", not a
// bug. Parent must be position: relative.

import { CircularProgress } from "@mui/material";
import React from "react";

export function BackendLoadingOverlay() {
  return (
    <div
      data-testid="backend-board-loading"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <CircularProgress size={16} />
    </div>
  );
}

export default React.memo(BackendLoadingOverlay);
