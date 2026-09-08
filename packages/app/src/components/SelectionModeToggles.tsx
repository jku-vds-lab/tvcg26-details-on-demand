import { Stack, ToggleButton, Tooltip } from "@mui/material";
import { Pencil, Sparkles } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { useSelectionWorkflow } from "src/contexts/SelectionWorkflowContext";
import { setFreehandMode, setShowAutoInsets } from "src/slices/freehandSlice";
import type { RootState } from "src/store";
import store from "src/store";

const toggleSx = {
  p: 0.75,
  border: "1px solid",
  borderColor: "divider",
  borderRadius: 1.5,
} as const;

/**
 * Horizontal row of selection/annotation mode toggles in the Core Workflow
 * section (future mode tools, e.g. parameter presets, join this row):
 * - Automated clustering (leftmost, on by default): show/hide the automated
 *   cluster annotations and insets.
 * - Freehand selection: a lasso turns exactly the lassoed points into one
 *   inset (Ctrl+lasso adds separate ones), bypassing clustering/activation.
 */
export const SelectionModeToggles = () => {
  const dispatch = useDispatch();
  const runSelectionWorkflow = useSelectionWorkflow();
  const isFreehandMode = useSelector((s: RootState) => s.freehand.isFreehandMode);
  const showAutoInsets = useSelector((s: RootState) => s.freehand.showAutoInsets);

  const toggleFreehand = () => {
    const leaving = isFreehandMode;
    // Read BEFORE the dispatch — setFreehandMode(false) clears the insets.
    const hadFreehandInsets = store.getState().freehand.insets.length > 0;
    dispatch(setFreehandMode(!isFreehandMode));
    if (leaving && hadFreehandInsets) {
      // Leaving clears the freehand insets (mode-scoped); re-run the normal
      // selection workflow so the DoI field and clustering reflect the plain
      // selection state again. Skipped when no freehand inset ever existed:
      // entering the mode touches nothing, so toggling it on and off was a
      // pure no-op that still re-ran full propagation + reclustering — a
      // multi-second freeze at 1M (issue #315).
      void runSelectionWorkflow(store.getState().selection.selectedNodeIds);
    }
  };

  return (
    <Stack direction="row" spacing={1}>
      <Tooltip
        title={
          showAutoInsets
            ? "Automatic cluster annotations & insets are shown. Click to hide them."
            : "Automatic cluster annotations & insets are hidden. Click to show them."
        }
        placement="right"
      >
        <ToggleButton
          value="auto-clustering"
          size="small"
          selected={showAutoInsets}
          color="primary"
          aria-label="Toggle automatic annotations and insets"
          onChange={() => dispatch(setShowAutoInsets(!showAutoInsets))}
          sx={toggleSx}
        >
          <Sparkles size={18} />
        </ToggleButton>
      </Tooltip>
      <Tooltip
        title={
          isFreehandMode
            ? "Freehand selection is on: a lasso turns exactly the selected points into one inset (Ctrl+lasso adds another). Click to return to smart selection."
            : "Freehand selection: a lasso turns exactly the selected points into one inset (Ctrl+lasso adds another), without clustering. Hold Alt while lassoing for a one-off freehand selection without switching modes."
        }
        placement="right"
      >
        <ToggleButton
          value="freehand"
          size="small"
          selected={isFreehandMode}
          color="primary"
          aria-label="Toggle freehand selection"
          onChange={toggleFreehand}
          sx={toggleSx}
        >
          <Pencil size={18} />
        </ToggleButton>
      </Tooltip>
    </Stack>
  );
};

export default SelectionModeToggles;
