import { Autocomplete, Box, TextField } from "@mui/material";
import React, { useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { FeatureSearchDeps } from "../hooks/useFeatureSearch";
import { useFeatureSearch } from "../hooks/useFeatureSearch";
import type { RootState } from "../store";
import { setFeatureSearchQuery } from "../store";
import BaseSnackbar from "./BaseSnackbar";

interface FeatureSearchInputProps {
  featureSearchDeps: FeatureSearchDeps;
  compact?: boolean;
}

const FeatureSearchInput: React.FC<FeatureSearchInputProps> = ({ featureSearchDeps, compact = false }) => {
  const { suggestions, handleFeatureSearch } = useFeatureSearch(featureSearchDeps);
  const dispatch = useDispatch();
  const inputValue = useSelector((s: RootState) => s.ui.featureSearchQuery);
  const sidePanelBgColor = useSelector((s: RootState) => s.visualizationSettings.sidePanelBgColor);
  // Deferred-column attaches (issue #315 R3c): value suggestions for a
  // just-fetched column can only render after the fetch lands — the
  // revision bump re-runs the suggestions effect below.
  const deferredColumnsRevision = useSelector(
    (s: RootState) => s.datasetFeatures.deferredColumnsRevision
  );
  const [options, setOptions] = useState<string[]>([]);
  const [openSnackbar, setOpenSnackbar] = useState(false);

  // Ref for the underlying input element.
  const inputRef = useRef<HTMLInputElement>(null);
  // Flag to indicate a suggestion selection is in progress.
  const selectingOptionRef = useRef(false);

  // Update autocomplete options as the input changes (and when a deferred
  // column attaches — the pending fetch returned [] for its values).
  useEffect(() => {
    const newOptions = suggestions(inputValue);
    setOptions(newOptions);
  }, [inputValue, suggestions, deferredColumnsRevision]);

  const onKeyDown = async (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      const result = await handleFeatureSearch(inputValue);
      if (result === 0) {
        setOpenSnackbar(true);
      }
    }
  };

  const handleSnackbarClose = () => {
    setOpenSnackbar(false);
  };

  // Helper to get the current token before the cursor.
  // We define a token as a sequence of alphanumeric characters (and periods).
  const getCurrentTokenRange = (text: string, cursor: number): { start: number; token: string } => {
    const textBeforeCursor = text.substring(0, cursor);
    const match = textBeforeCursor.match(/([\w.]+)$/);
    const token = match ? match[0] : "";
    const start = match ? cursor - token.length : cursor;
    return { start, token };
  };

  return (
    // id: stable anchor for the deep-link demo spotlight (deepLinkDemo.ts) —
    // the inner <input> id is owned by Autocomplete's params.inputProps.
    <Box id="feature-search-input" sx={{ mt: compact ? 0 : 4 }}>
      <Autocomplete
        freeSolo
        options={options}
        filterOptions={(x) => x} // Show suggestions as provided
        inputValue={inputValue}
        slotProps={{
          popper: {
            sx: {
              '& .MuiAutocomplete-paper': {
                bgcolor: sidePanelBgColor,
              },
              '& .MuiAutocomplete-listbox': {
                bgcolor: sidePanelBgColor,
              },
            },
          },
        }}
        onInputChange={(_event, newInputValue, reason) => {
          // Ignore updates if a suggestion is being inserted or if the event is triggered by selecting a suggestion.
          if (selectingOptionRef.current || reason === "selectOption" || reason === "reset") {
            return;
          }
          dispatch(setFeatureSearchQuery(newInputValue));
        }}
        onChange={(_event, newValue, reason) => {
          if (reason === "selectOption" && typeof newValue === "string" && inputRef.current) {
            selectingOptionRef.current = true;
            const currentCursor = inputRef.current.selectionStart ?? inputValue.length;
            const currentSelectionEnd = inputRef.current.selectionEnd ?? inputValue.length;
            const { start, token } = getCurrentTokenRange(inputValue, currentCursor);

            let newText: string;
            let newCursorPos: number;
            if (token && newValue.toLowerCase().startsWith(token.toLowerCase())) {
              newText = inputValue.substring(0, start) + newValue + inputValue.substring(currentSelectionEnd);
              newCursorPos = start + newValue.length;
            } else {
              newText = inputValue.substring(0, currentCursor) + newValue + inputValue.substring(currentSelectionEnd);
              newCursorPos = currentCursor + newValue.length;
            }
            dispatch(setFeatureSearchQuery(newText));

            setTimeout(() => {
              if (inputRef.current) {
                inputRef.current.setSelectionRange(newCursorPos, newCursorPos);
                // Update the scroll position to always show the end of the text.
                inputRef.current.scrollLeft = inputRef.current.scrollWidth;
              }
              selectingOptionRef.current = false;
            }, 0);
          }
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            label='Feature Search'
            placeholder='e.g. line=0 and speed>0.5'
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            onKeyDown={onKeyDown}
            inputRef={inputRef}
          />
        )}
      />
      <BaseSnackbar
        open={openSnackbar}
        autoHideDuration={3000}
        onClose={handleSnackbarClose}
        message="No matches found."
      />
    </Box>
  );
};

export default FeatureSearchInput;
