/**
 * ActiveClusterReadout.tsx
 *
 * Live status line under the cluster-budget slider (issue #261): shows how
 * many node clusters are actually annotated right now against the budget cap,
 * and how they got their slot — base pool vs the chain-rescue reserve
 * (reserved within the same budget, so base + chain never exceeds it).
 */
import { Typography } from "@mui/material";
import React from "react";
import { useSelector } from "react-redux";
import type { RootState } from "src/store";

const ActiveClusterReadout: React.FC = () => {
  const { base, chain } = useSelector(
    (s: RootState) => s.clustering.activeClusterStats
  );
  const budget = useSelector(
    (s: RootState) => s.clusterSettings.maxActiveClusters
  );
  const total = base + chain;

  // "1 of 12 clusters" — the noun counts the budget, so it pluralises on it.
  const noun = `cluster${budget === 1 ? "" : "s"}`;

  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: "block", mt: -1, mb: 2 }}
    >
      {chain > 0
        ? `Showing ${total} of ${budget} ${noun} (${base} base + ${chain} chain)`
        : `Showing ${total} of ${budget} ${noun}`}
    </Typography>
  );
};

export default ActiveClusterReadout;
