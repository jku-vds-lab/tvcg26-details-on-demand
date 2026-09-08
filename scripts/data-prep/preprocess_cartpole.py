#!/usr/bin/env python3
"""Preprocess a CartPole trajectories CSV by adding a 2D UMAP embedding.

Differences vs `preprocess_mnist.py`:
  * Uses fixed feature columns: obs0, obs1, obs2, obs3.
  * Does NOT overwrite existing columns `line`, `step`, `action` if they already exist.
  * Appends new columns `x`, `y` (UMAP coordinates) at the end (or replaces if already there).

Usage (examples):
  python preprocess_cartpole.py --in cartpole_trajectories.csv
  python preprocess_cartpole.py --in cartpole_trajectories.csv --out cartpole_embedded.csv --n_neighbors 25 --min_dist 0.05

Requires: pandas, numpy, umap-learn
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List

import numpy as np
import pandas as pd

try:
    import umap
except ImportError as e:  # pragma: no cover
    print("Missing dependency: umap-learn. Install with: pip install umap-learn", file=sys.stderr)
    raise SystemExit(1) from e


DEF_FEATURES: List[str] = ["obs0", "obs1", "obs2", "obs3"]


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Append UMAP x/y columns to CartPole trajectory CSV.")
    ap.add_argument("--in", dest="inp", default="cartpole_trajectories.csv", help="Input CSV path")
    ap.add_argument("--out", dest="out", default=None, help="Output CSV path (default: overwrite input)")
    ap.add_argument("--n_neighbors", type=int, default=15, help="UMAP n_neighbors (default: 15)")
    ap.add_argument("--min_dist", type=float, default=0.1, help="UMAP min_dist (default: 0.1)")
    ap.add_argument("--metric", default="euclidean", help="UMAP metric (default: euclidean)")
    ap.add_argument("--random_state", type=int, default=42, help="UMAP random_state (default: 42)")
    ap.add_argument(
        "--features",
        nargs="*",
        default=DEF_FEATURES,
        help="Feature columns to embed (default: obs0 obs1 obs2 obs3)",
    )
    return ap.parse_args()


def main() -> None:
    args = parse_args()
    df = pd.read_csv(args.inp)

    # Validate feature columns
    missing = [c for c in args.features if c not in df.columns]
    if missing:
        sys.exit(f"Feature columns missing from input CSV: {missing}")

    X = df[args.features].to_numpy(dtype=float)

    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=args.n_neighbors,
        min_dist=args.min_dist,
        metric=args.metric,
        random_state=args.random_state,
    )
    embedding = reducer.fit_transform(X)

    # Assign / overwrite only x,y columns (safe to overwrite if re-running)
    df["x"] = embedding[:, 0]
    df["y"] = embedding[:, 1]

    # Only create administrative columns if absent
    if "line" not in df.columns:
        # Provide sequential id per row (can be changed to group-based if needed)
        df["line"] = np.arange(len(df), dtype=int)
    if "step" not in df.columns:
        df["step"] = np.arange(len(df), dtype=int)
    if "action" not in df.columns:
        df["action"] = -1  # placeholder integer action

    out_path = args.out or args.inp
    # Keep original column order, but ensure x,y at the end (remove existing then append)
    cols = [c for c in df.columns if c not in {"x", "y"}] + ["x", "y"]
    df = df[cols]
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} rows with UMAP embedding to {out_path}")


if __name__ == "__main__":  # pragma: no cover

    main()
