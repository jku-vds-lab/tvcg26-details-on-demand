// packages/app/src/components/Visualization/Details/Tabular/tabularInsetLayout.ts
//
// Base (unscaled) geometry of the tabular summary/diff inset cards. Kept out
// of the component file so the renderer's bbox math can import it without
// tripping react-refresh's only-export-components rule.

export const TABULAR_HEADER_HEIGHT_PX = 22;
export const TABULAR_ROW_HEIGHT_PX = 18;
export const MAX_VISIBLE_ROWS = 7;

export const TABULAR_VALUE_WIDTH_PX = 36;
export const TABULAR_CUE_WIDTH_PX = 48;
// Row padding (6+6) + flex gaps (4+4).
const ROW_CHROME_PX = 20;
// ~10px sans-serif average glyph width.
const NAME_CHAR_WIDTH_PX = 5.4;
const MIN_NAME_CHARS = 6;
export const MAX_NAME_CHARS = 14;

/** Card height: header + up to MAX_VISIBLE_ROWS rows (more rows scroll). */
export const tabularInsetBaseHeightPx = (rowCount: number): number =>
  TABULAR_HEADER_HEIGHT_PX +
  Math.max(1, Math.min(rowCount, MAX_VISIBLE_ROWS)) * TABULAR_ROW_HEIGHT_PX;

/**
 * Card width fitted to the longest feature name (clamped — longer names
 * ellipsize with the full name in the tooltip), so short-named datasets
 * don't pay for a fixed 200px card.
 */
export const tabularInsetBaseWidthPx = (maxNameLength: number): number => {
  const chars = Math.max(MIN_NAME_CHARS, Math.min(maxNameLength, MAX_NAME_CHARS));
  return Math.round(
    ROW_CHROME_PX + chars * NAME_CHAR_WIDTH_PX + TABULAR_VALUE_WIDTH_PX + TABULAR_CUE_WIDTH_PX
  );
};
