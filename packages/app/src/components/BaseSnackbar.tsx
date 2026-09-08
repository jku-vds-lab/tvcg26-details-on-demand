/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the component by design; dev HMR full-reloads this file (CS 2026-07-09) */
import { Snackbar, SnackbarContent } from "@mui/material";
import React from "react";

export interface BaseSnackbarProps {
  open: boolean;
  message: React.ReactNode;
  autoHideDuration?: number;
  onClose?: () => void;
}

const SNACKBAR_BG_COLOR = "#333";
const SNACKBAR_TEXT_COLOR = "#fff";

const snackbarStyle = {
  backgroundColor: SNACKBAR_BG_COLOR,
  color: SNACKBAR_TEXT_COLOR,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  "&&": {
    backgroundColor: SNACKBAR_BG_COLOR,
    color: SNACKBAR_TEXT_COLOR,
  },
  "&.MuiSnackbarContent-root": {
    backgroundColor: SNACKBAR_BG_COLOR,
    color: SNACKBAR_TEXT_COLOR,
  },
  "& .MuiSnackbarContent-message": {
    color: SNACKBAR_TEXT_COLOR,
  },
};

const anchorOrigin = { vertical: "bottom", horizontal: "center" } as const;

const BaseSnackbar: React.FC<BaseSnackbarProps> = ({
  open,
  message,
  autoHideDuration,
  onClose,
}) => (
  <Snackbar
    open={open}
    anchorOrigin={anchorOrigin}
    sx={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
    autoHideDuration={autoHideDuration}
    onClose={onClose}
  >
    <SnackbarContent sx={snackbarStyle} message={message} />
  </Snackbar>
);

export default BaseSnackbar;
export { anchorOrigin, SNACKBAR_BG_COLOR, SNACKBAR_TEXT_COLOR, snackbarStyle };

