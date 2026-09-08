// src/components/ServerLossWarning.tsx
//
// Persistent server-loss banner (issue #315 R3a, CS §8.8d): when a
// server-lane mechanism would have to run in a weaker local mode — DoI
// propagation without the (server-only) neighbor graph, deferred columns
// with an unreachable /v1/columns — the degradation must be LOUD, never
// silent. The warning stays until dismissed; reloading with the server
// down takes the classic client-only lane.

import { Alert } from "@mui/material";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../store";
import { setServerLossWarning } from "../store";

export default function ServerLossWarning() {
  const message = useSelector((s: RootState) => s.ui.serverLossWarning);
  const dispatch = useDispatch();
  if (!message) return null;
  return (
    <Alert
      severity="warning"
      onClose={() => dispatch(setServerLossWarning(null))}
      sx={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        maxWidth: "min(90%, 640px)",
        boxShadow: 3,
      }}
      data-testid="server-loss-warning"
    >
      {message}
    </Alert>
  );
}
