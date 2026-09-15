# Jupyter widget examples

One-time setup — run with the **same Python your notebook kernel uses** (activate
your venv first):

```bash
python packages/widget/examples/setup_widget.py
```

The script builds the gitignored widget bundle (`npm ci` + `npm run build:widget`),
editable-installs `detailviews` into that Python's environment, registers a
`Python (detailviews demo)` Jupyter kernel bound to that exact interpreter, and
verifies the import. `--rebuild` forces a fresh JS build after frontend changes.

Then open [`simple_widget_demo.ipynb`](simple_widget_demo.ipynb) — it is pinned to
the registered kernel, so `import detailviews` resolves on first run.

Verify in a real notebook (human check):

1. Start Jupyter from this environment and open the demo notebook.
2. Run all cells; the last cell must show a scatterplot with 8 spiral trajectories.
3. Lasso a few points — insets and cluster contours should appear.

## scikit-learn datasets

[`sklearn_datasets_demo.ipynb`](sklearn_datasets_demo.ipynb) feeds two standard
scikit-learn datasets into the widget (needs `scikit-learn`, `numpy`, `pandas`):
the 8×8 **digits** with the digit class as label and the images as detail views
(`image_shape=(8, 8)`: one column per pixel keyed `"{row}x{col}"`, grayscale
0–255, no padding to a fixed grid), and **iris** with the species as label and
the default tabular detail views. Neither has trajectories; `dataset_type` (or
`image_shape`, which selects the `"image"` type) is what selects the detail-view
renderer.

## Install by name

[`publish_preview.ipynb`](publish_preview.ipynb) shows the plain install-by-name
path: its `%pip install detailviews` cell pulls the package from PyPI, then it loads
`sample_trajectories.csv` with pandas and shows the widget. No build step needed.
