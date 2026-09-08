import { Box, LinearProgress, Typography } from "@mui/material";
import React from "react";
import BaseSnackbar from "./BaseSnackbar";

interface DownloadProgressProps {
  open: boolean;
  /** 0..100 for determinate, null for indeterminate */
  value: number | null;
  /** Short status text like "Downloading…", "Parsing…", "Preparing…" */
  label: string;
}

const DownloadProgress: React.FC<DownloadProgressProps> = ({ open, value, label }) => {
  return (
    <BaseSnackbar
      open={open}
      message={
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            justifyContent: "center",
            width: 360,
            gap: 1,
          }}
        >
          <Typography variant="body2" sx={{ textAlign: "center" }}>
            {label} {typeof value === "number" ? `${Math.round(value)}%` : ""}
          </Typography>
          <LinearProgress variant={typeof value === "number" ? "determinate" : "indeterminate"} value={value ?? undefined} />
        </Box>
      }
    />
  );
};

export default DownloadProgress;
