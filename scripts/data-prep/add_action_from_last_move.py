#!/usr/bin/env python3
"""
add_action_from_last_move.py — Append an 'action' column using the NEXT row's 'last_move'.

- For each trajectory (grouped by 'line'), the next row's 'last_move' becomes the current row's 'action'.
- If there is no next row within the same 'line', or the next 'last_move' is 'None' or empty, 'action' is blank.
- Preserves all existing columns and appends 'action' as the last column.

Usage:
  python add_action_from_last_move.py input.csv output.csv
"""

import sys
import pandas as pd

def main():
    if len(sys.argv) != 3:
        print("Usage: python add_action_from_last_move.py input.csv output.csv", file=sys.stderr)
        sys.exit(1)

    in_path, out_path = sys.argv[1], sys.argv[2]

    # Read as strings to preserve tokens like "None", "?", "*"
    df = pd.read_csv(in_path, dtype=str, keep_default_na=False)

    # Next move = next row's last_move within the same line (no cross-line leakage)
    next_last_move = df.groupby("line", sort=False)["last_move"].shift(-1)

    # Clean to blank if the next move is missing or explicitly "None"
    action = next_last_move.where(~next_last_move.isin(["None", ""]), "")

    df["action"] = action.fillna("")

    df.to_csv(out_path, index=False)

if __name__ == "__main__":
    main()
