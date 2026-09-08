#!/usr/bin/env python3
"""
Add trajectory step and relative age features to a Rubik's Cube trajectories CSV.

Adds three columns:
  - step        : 0-based index within each trajectory (grouped by 'line')
  - age         : step normalized within each trajectory (0 at start, 1 at final)
  - age_global  : step normalized by the global max step across all trajectories

Notes:
- Row order is assumed to reflect state order within each trajectory.
- If any of the three columns already exist, they are overwritten and moved to
  the end of the column list (other columns keep their original order).
- Single-state trajectories get age=0.0 to avoid division by zero.
- Only the final state of the longest trajectory will have age_global == 1.0.

Usage:
  python add_steps_to_cube_data.py input.csv
  python add_steps_to_cube_data.py input.csv -o output.csv
  python add_steps_to_cube_data.py input.csv --in-place
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np
import pandas as pd


NEW_COLS = ("step", "age", "age_global")
LINE_COL_DEFAULT = "line"


def derive_output_path(input_path: Path) -> Path:
    """Create default output path by appending '_with_steps' before the suffix."""
    return input_path.with_name(f"{input_path.stem}_with_steps{input_path.suffix}")


def compute_features(
    df: pd.DataFrame,
    line_col: str = LINE_COL_DEFAULT,
    step_col: str = "step",
    age_col: str = "age",
    age_global_col: str = "age_global",
) -> pd.DataFrame:
    """
    Compute step, age (per-trajectory), and age_global (global) columns.

    - step: 0..N_i-1 within each trajectory i (based on existing row order)
    - age: step / max_step_in_trajectory (0..1), singletons -> 0.0
    - age_global: step / global_max_step (0..1), if global_max_step == 0 -> 0.0
    """
    if line_col not in df.columns:
        raise KeyError(f"Required trajectory column '{line_col}' not found.")

    # Drop any existing target columns so we can append them at the end
    for col in (step_col, age_col, age_global_col):
        if col in df.columns:
            logging.warning("Column '%s' exists and will be overwritten.", col)
            df = df.drop(columns=[col])

    # step: use original row order within each trajectory
    step = df.groupby(line_col, sort=False).cumcount().astype("int32")

    # For each row, the trajectory length (N) and hence max step (N-1)
    traj_len = df.groupby(line_col, sort=False)[line_col].transform("size").astype("int32")
    traj_max_step = np.maximum(traj_len - 1, 0)

    # age: handle singletons (max_step == 0) to avoid division by zero
    with np.errstate(divide="ignore", invalid="ignore"):
        age = np.where(traj_max_step > 0, step.to_numpy() / traj_max_step, 0.0).astype("float64")

    # age_global: normalize by the global max step
    if len(step) and int(step.max()) > 0:
        global_max_step = float(int(step.max()))
        age_global = (step.to_numpy() / global_max_step).astype("float64")
    else:
        age_global = np.zeros(len(df), dtype="float64")

    # Append new columns at the end (preserve original order for all others)
    df[step_col] = step
    df[age_col] = age
    df[age_global_col] = age_global

    return df


def safe_write_csv(df: pd.DataFrame, out_path: Path, in_place: bool = False) -> None:
    """
    Write CSV safely. If in_place, write to a temp file in the same directory and atomically replace.
    """
    out_path = out_path.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if in_place:
        # Atomic replace strategy
        with NamedTemporaryFile("w", delete=False, dir=str(out_path.parent), suffix=".tmp", newline="") as tmp:
            tmp_path = Path(tmp.name)
            df.to_csv(tmp_path, index=False)
        os.replace(tmp_path, out_path)
    else:
        df.to_csv(out_path, index=False)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Add/overwrite step, age, and age_global features to a trajectories CSV."
    )
    p.add_argument("input", type=Path, help="Path to input CSV.")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Path to output CSV. If omitted, writes '<input>_with_steps.csv' unless --in-place is used.",
    )
    p.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file atomically (ignores --output).",
    )
    p.add_argument(
        "--line-col",
        default=LINE_COL_DEFAULT,
        help=f"Name of the trajectory ID column (default: '{LINE_COL_DEFAULT}').",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v for INFO, -vv for DEBUG).",
    )
    return p.parse_args()


def configure_logging(verbosity: int) -> None:
    level = logging.WARNING
    if verbosity == 1:
        level = logging.INFO
    elif verbosity >= 2:
        level = logging.DEBUG
    logging.basicConfig(level=level, format="%(levelname)s: %(message)s")


def main() -> None:
    args = parse_args()
    configure_logging(args.verbose)

    input_path: Path = args.input.resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    if args.in_place:
        output_path = input_path
    else:
        output_path = args.output or derive_output_path(input_path)

    logging.info("Reading: %s", input_path)
    df = pd.read_csv(input_path, skipinitialspace=True)

    logging.info("Computing features using line column: '%s'", args.line_col)
    df = compute_features(df, line_col=args.line_col)

    logging.info("Writing: %s%s", output_path, " (in-place)" if args.in_place else "")
    safe_write_csv(df, output_path, in_place=args.in_place)

    logging.info("Done.")


if __name__ == "__main__":
    main()
