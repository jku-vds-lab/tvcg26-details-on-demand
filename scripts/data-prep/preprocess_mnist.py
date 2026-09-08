#!/usr/bin/env python3
"""
Add UMAP (x,y) + admin columns to MNIST CSV.

Usage:
  python add_umap_to_mnist.py --in mnist_test.csv [--out mnist_test.csv]
                              [--n_neighbors 15] [--min_dist 0.1]
Requires:
  pip install pandas numpy umap-learn
"""
import argparse
import sys
from typing import Optional, Sequence

import numpy as np
import pandas as pd

try:
    import umap
except ImportError:
    print("Missing dependency: umap-learn. Install with: pip install umap-learn", file=sys.stderr)
    sys.exit(1)


def find_label_column(cols: Sequence[str]) -> Optional[str]:
    for cand in ("label", "class", "digit", "target", "y"):
        if cand in cols:
            return cand
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Append UMAP x/y and admin columns to an MNIST CSV.")
    ap.add_argument("--in", dest="inp", default="mnist_test.csv", help="Input CSV path (default: mnist_test.csv)")
    ap.add_argument("--out", dest="out", default=None, help="Output CSV path (default: overwrite input)")
    ap.add_argument("--n_neighbors", type=int, default=15, help="UMAP n_neighbors (default: 15)")
    ap.add_argument("--min_dist", type=float, default=0.1, help="UMAP min_dist (default: 0.1)")
    ap.add_argument("--metric", default="euclidean", help="UMAP metric (default: euclidean)")
    ap.add_argument("--random_state", type=int, default=42, help="UMAP random_state (default: 42)")
    args = ap.parse_args()

    df = pd.read_csv(args.inp)

    # Determine label source and ensure a 'label' column exists.
    label_src = find_label_column(df.columns)
    if label_src is None:
        sys.exit("Could not find a label column. Expected one of: label, class, digit, target, y.")
    if "label" not in df.columns:
        df["label"] = df[label_src]

    # Select numeric feature columns for UMAP (exclude admin/label columns if numeric).
    admin_cols = {"label", "line", "x", "y", "step", "action"}
    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    feature_cols = [c for c in numeric_cols if c not in admin_cols and c != label_src]
    if not feature_cols:
        sys.exit("No numeric feature columns found for UMAP.")

    X = df[feature_cols].to_numpy()

    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=args.n_neighbors,
        min_dist=args.min_dist,
        metric=args.metric,
        random_state=args.random_state,
    )
    embedding = reducer.fit_transform(X)
    df["x"] = embedding[:, 0]
    df["y"] = embedding[:, 1]

    # Administrative columns.
    df["line"] = np.arange(len(df), dtype=np.int64)  # unique id per row
    df["step"] = 0
    df["action"] = ""

    # Optional: bring new columns to the front.
    front = ["line", "label", "step", "action", "x", "y"]
    rest = [c for c in df.columns if c not in front]
    df = df[front + rest]

    out_path = args.out or args.inp
    df.to_csv(out_path, index=False)
    print(f"Wrote {len(df)} rows to {out_path}")


if __name__ == "__main__":
    main()
