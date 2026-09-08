#!/usr/bin/env python3
import argparse
import csv
import numpy as np
import matplotlib.pyplot as plt


META_COLUMNS = {"line", "label", "step", "action", "x", "y"}


def load_sample(csv_path: str, index: int):
    """Load sample at row index from the MNIST-style CSV.

    index = 0 → first data row after the header.
    """
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        # Skip ahead to the requested row
        for i, row in enumerate(reader):
            if i == index:
                break
        else:
            raise IndexError(f"CSV has no row at index {index}")

    pixel_coords = []
    pixel_values = []

    for key, value in row.items():
        if key in META_COLUMNS or key is None:
            continue

        if "x" not in key:
            continue

        x_str, y_str = key.split("x", 1)
        try:
            x = int(x_str)
            y = int(y_str)
        except ValueError:
            continue

        if value == "" or value is None:
            v = 0.0
        else:
            v = float(value)

        pixel_coords.append((x, y))
        pixel_values.append(v)

    if not pixel_coords:
        raise RuntimeError("No pixel columns found for the selected row.")

    max_x = max(c[0] for c in pixel_coords)
    max_y = max(c[1] for c in pixel_coords)

    img = np.zeros((max_y, max_x), dtype=np.float32)
    for (x, y), v in zip(pixel_coords, pixel_values):
        img[y - 1, x - 1] = v

    meta = {}
    meta["line"] = int(row["line"]) if row.get("line") not in (None, "") else None
    meta["label"] = int(row["label"]) if row.get("label") not in (None, "") else None
    meta["step"] = int(row["step"]) if row.get("step") not in (None, "") else None
    meta["action"] = row.get("action")
    meta["x"] = float(row["x"]) if row.get("x") not in (None, "") else None
    meta["y"] = float(row["y"]) if row.get("y") not in (None, "") else None

    return img, meta


def main():
    parser = argparse.ArgumentParser(
        description="Render a sample from mnist_test.csv by sample index."
    )
    parser.add_argument(
        "--csv",
        default="mnist_test.csv",
        help="Path to mnist_test.csv (default: mnist_test.csv)",
    )
    parser.add_argument(
        "--index",
        type=int,
        default=0,
        help="Sample index to draw (0 = first sample).",
    )
    parser.add_argument(
        "--save",
        default=None,
        help="Optional output filename to save the image.",
    )

    args = parser.parse_args()

    img, meta = load_sample(args.csv, args.index)

    plt.figure()
    plt.imshow(img, cmap="gray", interpolation="nearest", origin="upper")
    plt.axis("off")

    title_items = []
    if meta.get("label") is not None:
        title_items.append(f"label={meta['label']}")
    if meta.get("line") is not None:
        title_items.append(f"line={meta['line']}")
    if meta.get("x") is not None and meta.get("y") is not None:
        title_items.append(f"proj=({meta['x']:.2f}, {meta['y']:.2f})")

    if title_items:
        plt.title(", ".join(title_items))

    if args.save:
        plt.savefig(args.save, bbox_inches="tight", pad_inches=0)
    else:
        plt.show()


if __name__ == "__main__":
    main()
