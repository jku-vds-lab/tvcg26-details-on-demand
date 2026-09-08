// src/components/CopyLinkButton.tsx
import LinkIcon from "@mui/icons-material/Link";
import { IconButton, Snackbar, Tooltip } from "@mui/material";
import React, { useCallback, useState } from "react";
import { useSelector } from "react-redux";
import { findDatasetEntryByPath } from "../datasets/catalog";
import type { RootState } from "../store";

interface CopyLinkButtonProps {
  /** Builds the shareable URL for the current state; null when not shareable. */
  buildUrl: () => string | null;
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for insecure contexts (e.g. LAN-hosted dev server).
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (ok) resolve();
    else reject(new Error("execCommand copy failed"));
  });
}

/**
 * Small dock button that copies a deep-link URL reproducing the current app
 * state (dataset, settings diffs, selection, viewbox) to the clipboard.
 */
const CopyLinkButton: React.FC<CopyLinkButtonProps> = ({ buildUrl }) => {
  const datasetPath = useSelector((s: RootState) => s.dataset.datasetPath);
  const shareable = Boolean(findDatasetEntryByPath(datasetPath));
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleClick = useCallback(() => {
    const url = buildUrl();
    if (!url) {
      setFeedback("Current state can't be linked (dataset not in catalog)");
      return;
    }
    copyToClipboard(url)
      .then(() => setFeedback("Link copied"))
      .catch(() => {
        console.info("CopyLinkButton: clipboard unavailable, URL:", url);
        setFeedback("Clipboard unavailable — URL logged to console");
      });
  }, [buildUrl]);

  return (
    <>
      <Tooltip
        title={shareable ? "Copy link to current state" : "Only predefined datasets can be linked"}
        placement="left"
      >
        <span
          style={{
            position: "absolute",
            bottom: 12,
            right: 16,
            zIndex: 20,
          }}
        >
          <IconButton
            size="small"
            onClick={handleClick}
            disabled={!shareable}
            aria-label="Copy link to current state"
            sx={{
              backgroundColor: "rgba(255,255,255,0.85)",
              border: "1px solid rgba(0,0,0,0.12)",
              "&:hover": { backgroundColor: "rgba(255,255,255,1)" },
            }}
          >
            <LinkIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Snackbar
        open={feedback !== null}
        autoHideDuration={2500}
        onClose={() => setFeedback(null)}
        message={feedback ?? ""}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      />
    </>
  );
};

export default CopyLinkButton;
