# detailviews

Adaptive Detail Views as a Jupyter widget. The same visualization as the web
app, rendered in a notebook output cell from a DataFrame or a list of records.
The project itself is described in the repository root README.

## Install

```bash
pip install detailviews
```

Python >= 3.10 and any Jupyter frontend supported by
[anywidget](https://anywidget.dev) (JupyterLab, Notebook 7, VS Code, Colab).
The anywidget frontend extension of your Jupyter server must match the
`anywidget` version installed in the kernel's environment. A stale extension
shows up as a "Module anywidget, version ... is not registered" error in the
output cell, and updating `anywidget` in the server's environment fixes it.

## Quickstart

```python
import pandas as pd
from detailviews import DetailViewsWidget

df = pd.DataFrame({
    "x": ..., "y": ...,           # projected coordinates
    "episode": ..., "step": ...,  # trajectory id and order within the trajectory
})
DetailViewsWidget.from_dataframe(
    df, x="x", y="y", trajectory="episode", order="step"
)
```

`trajectory` and `order` are optional. Without them the data is treated as
plain points. Every other column of `df` becomes a feature column in the
widget, for coloring and for the detail visualizations. A `label` column
names the column used for cluster labels, for example
`from_dataframe(df, x="x", y="y", label="species")`.

## Detail visualization type

`dataset_type` selects how the detail visualizations are drawn. The default is
tabular summaries of the feature columns. `image_shape=(rows, cols)` shows
each record as a grayscale image and expects one column per pixel, keyed
`"1x1"` to `"{rows}x{cols}"` (row by column, 1-based), values 0 to 255. It
selects `dataset_type="image"` unless a type is given. `dataset_type="mnist"`
is the fixed 28 by 28 preset of the same thing. The example notebooks under
[`../examples/`](../examples/) show both, including scikit-learn's 8 by 8
digits passed as they are.

## Citing

If you use this widget in academic work, please cite the accompanying
paper (reference added upon publication).
