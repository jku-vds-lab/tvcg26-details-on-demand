import pathlib

import anywidget
import traitlets

# Widget assets are built by `npm run build:widget` in packages/app
# (vite.config.widget.ts):
# a single self-contained ESM bundle with all Web Workers inlined, so it can
# run from the blob URL anywidget loads it from inside Jupyter.
_STATIC_WIDGET_DIR = pathlib.Path(__file__).parent / "static" / "widget"
_JS_PATH = _STATIC_WIDGET_DIR / "index.js"
_CSS_PATH = _STATIC_WIDGET_DIR / "style.css"

if not _JS_PATH.exists():
    raise FileNotFoundError(
        f"Widget bundle not found at: {_JS_PATH}\n"
        "Build it first: cd packages/app && npm run build:widget"
    )


def _normalize_image_shape(value):
    """``(rows, cols)`` as a list of two positive ints; ``None``/empty ⇒ ``[]``."""
    if value is None:
        return []
    shape = list(value)
    if not shape:
        return shape
    if len(shape) != 2 or any(
        isinstance(v, bool) or not isinstance(v, int) or v <= 0 for v in shape
    ):
        raise ValueError(
            f"image_shape must be two positive ints (rows, cols), got {value!r}"
        )
    return shape


def _check_pixel_keys(rows, shape):
    """The first row must carry every ``"{r}x{c}"`` pixel column of ``shape``."""
    if not shape or not rows:
        return
    first = rows[0]
    n_rows, n_cols = shape
    for r in range(1, n_rows + 1):
        for c in range(1, n_cols + 1):
            key = f"{r}x{c}"
            if key not in first:
                raise ValueError(
                    f"image_shape={tuple(shape)} expects one pixel column per cell, "
                    f"keyed '1x1' to '{n_rows}x{n_cols}' (row by column, 1-based), "
                    f"but the first row has no '{key}'"
                )


class DetailViewsWidget(anywidget.AnyWidget):
    """Trajectory scatterplot widget.

    Pass a dataset in the simple format: ``data`` is a list of records
    (rows) with projected ``x``/``y`` columns, arbitrary feature columns,
    and optionally a trajectory-id column and a within-trajectory order
    column. ``column_mapping`` says which column plays which role (keys:
    ``x``, ``y``, ``trajectory``, ``order``, ``action``, ``label``); roles
    left out are inferred from common column names. The kNN graph, trajectory
    splines, and HDBSCAN clustering are computed inside the widget, off
    the UI thread.

    ``image_shape=(rows, cols)`` shows each record as a grayscale image in
    the detail views: one column per pixel keyed ``"{row}x{col}"`` (1-based),
    values 0 to 255. It selects ``dataset_type="image"`` unless a type is
    given explicitly; ``dataset_type="mnist"`` is the fixed 28 by 28 preset.
    """

    _esm = _JS_PATH.read_text(encoding="utf-8")
    _css = _CSS_PATH.read_text(encoding="utf-8") if _CSS_PATH.exists() else ""

    data = traitlets.List(trait=traitlets.Dict()).tag(sync=True)
    columnMapping = traitlets.Dict().tag(sync=True)
    datasetType = traitlets.Unicode("default").tag(sync=True)
    # [rows, cols] of the pixel grid for the "image" type; empty = unset.
    imageShape = traitlets.List(trait=traitlets.Int(), default_value=[]).tag(sync=True)

    def __init__(self, *args, image_shape=None, **kwargs):
        if image_shape is not None:
            kwargs["imageShape"] = _normalize_image_shape(image_shape)
        if kwargs.get("imageShape") and not kwargs.get("datasetType"):
            kwargs["datasetType"] = "image"
        super().__init__(*args, **kwargs)
        _check_pixel_keys(self.data, self.imageShape)

    @traitlets.validate("imageShape")
    def _validate_image_shape(self, proposal):
        return _normalize_image_shape(proposal["value"])

    @classmethod
    def from_dataframe(
        cls,
        df,
        x="x",
        y="y",
        trajectory=None,
        order=None,
        action=None,
        label=None,
        dataset_type=None,
        image_shape=None,
        **kwargs,
    ):
        """Build the widget from a pandas DataFrame.

        Column-role arguments name columns of ``df``; ``trajectory``,
        ``order``, ``action``, and ``label`` are optional. ``dataset_type``
        defaults to ``"image"`` when ``image_shape`` is given, else
        ``"default"``.
        """
        mapping = {"x": x, "y": y}
        if trajectory is not None:
            mapping["trajectory"] = trajectory
        if order is not None:
            mapping["order"] = order
        if action is not None:
            mapping["action"] = action
        if label is not None:
            mapping["label"] = label
        if dataset_type is not None:
            kwargs["datasetType"] = dataset_type
        return cls(
            data=df.to_dict(orient="records"),
            columnMapping=mapping,
            image_shape=image_shape,
            **kwargs,
        )


# Legacy alias: the class was called D3ProjectionViewWidget in the early
# D3-based prototype; the public API name is DetailViewsWidget.
D3ProjectionViewWidget = DetailViewsWidget
