"""`image_shape` on DetailViewsWidget: trait, dataset_type default, validation."""

import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from detailviews import DetailViewsWidget  # noqa: E402


def grid_rows(n_rows, n_cols, count=3):
    rows = []
    for i in range(count):
        row = {"x": float(i), "y": float(-i), "digit": str(i)}
        for r in range(1, n_rows + 1):
            for c in range(1, n_cols + 1):
                row[f"{r}x{c}"] = (r * c * 7 + i) % 256
        rows.append(row)
    return rows


def test_default_is_unset():
    w = DetailViewsWidget(data=[{"x": 0.0, "y": 0.0}])
    assert w.imageShape == []
    assert w.datasetType == "default"


def test_constructor_image_shape_selects_image_type():
    w = DetailViewsWidget(data=grid_rows(2, 3), image_shape=(2, 3))
    assert w.imageShape == [2, 3]
    assert w.datasetType == "image"


def test_explicit_dataset_type_is_kept():
    w = DetailViewsWidget(data=grid_rows(2, 2), image_shape=(2, 2), datasetType="mnist")
    assert w.datasetType == "mnist"


def test_from_dataframe_image_shape():
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame(grid_rows(2, 2))
    w = DetailViewsWidget.from_dataframe(df, x="x", y="y", label="digit", image_shape=(2, 2))
    assert w.imageShape == [2, 2]
    assert w.datasetType == "image"
    assert w.columnMapping == {"x": "x", "y": "y", "label": "digit"}

    w2 = DetailViewsWidget.from_dataframe(df, x="x", y="y", dataset_type="mnist", image_shape=(2, 2))
    assert w2.datasetType == "mnist"

    w3 = DetailViewsWidget.from_dataframe(df, x="x", y="y")
    assert w3.imageShape == []
    assert w3.datasetType == "default"


@pytest.mark.parametrize("shape", [(0, 2), (2, -1), (2,), (2, 2, 2), (2.5, 2), ("2", "2"), (True, 2)])
def test_invalid_shape_raises(shape):
    with pytest.raises(ValueError, match="two positive ints"):
        DetailViewsWidget(data=grid_rows(2, 2), image_shape=shape)


def test_later_assignment_is_validated():
    w = DetailViewsWidget(data=grid_rows(2, 2), image_shape=(2, 2))
    with pytest.raises(ValueError, match="two positive ints"):
        w.imageShape = [3, 0]
    assert w.imageShape == [2, 2]


def test_missing_pixel_key_names_the_first_missing_one():
    rows = grid_rows(2, 2)
    for row in rows:
        del row["1x2"]
    with pytest.raises(ValueError, match="'1x2'"):
        DetailViewsWidget(data=rows, image_shape=(2, 2))


def test_shape_larger_than_the_grid_is_rejected():
    with pytest.raises(ValueError, match="'1x3'"):
        DetailViewsWidget(data=grid_rows(2, 2), image_shape=(2, 3))
